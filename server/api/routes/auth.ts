import { CliLoginPollSchema, CliLoginStartSchema } from '@adamant/contract'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { html, raw } from 'hono/html'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

import { type Db } from '../../db/client.ts'
import {
  createAuthMiddleware,
  readSessionToken,
  SESSION_COOKIE_NAME,
  type AuthVariables,
} from '../middleware/auth.ts'
import { createRateLimit } from '../middleware/rateLimit.ts'
import {
  consumeOAuthState,
  createOAuthState,
  createSession,
  getUserAuthInfo,
  OAuthAccountConflictError,
  revokeSessionToken,
  upsertOAuthIdentity,
  type OAuthProvider,
} from '../services/authService.ts'
import {
  createPostgresCliLoginStore,
  generateUserCode,
  type CliLoginStore,
} from '../services/cliLogin.ts'
import {
  DATABASE_UNAVAILABLE,
  isDatabaseUnavailable,
  redactDatabaseError,
} from '../services/databaseErrors.ts'

const OAUTH_REQUEST_TIMEOUT_MS = 10_000
const OAUTH_STATE_MAX_AGE_SECONDS = 15 * 60
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

const CLI_CONFIRM_PATH = '/auth/github/cli/confirm'
const CLI_CONFIRM_COOKIE = 'adamant_cli_confirm'
const CONFIRM_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/

// A sign-in costs two of these (the CLI start and its browser redirect), so the
// burst covers a few retries and the refill a steady trickle per client.
const SIGN_IN_BURST = 20
const SIGN_IN_PER_MINUTE = 20

export type OAuthProviderConfig = {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export type OAuthConfig = {
  github?: OAuthProviderConfig
  google?: OAuthProviderConfig
}

export type AuthRouteOptions = {
  fetch?: typeof globalThis.fetch
  /** Where terminal sign-ins wait for their browser half. Postgres unless a test says otherwise. */
  cliLogins?: CliLoginStore
  /** Guards the unauthenticated routes that write a row per request. */
  rateLimit?: MiddlewareHandler
}

const ACCOUNT_CONFLICT_MESSAGE =
  'This email belongs to another Adamant account. Sign in the way you did before.'

class OAuthConfigurationError extends Error {}
class InvalidOAuthStateError extends Error {}
/** The provider was unreachable or answered with something other than what OAuth promises. */
class OAuthProviderError extends Error {}

const TokenResponseSchema = z.object({ access_token: z.string().min(1) })
const GithubUserSchema = z.object({ id: z.number().int().positive(), login: z.string().min(1) })
const GithubEmailsSchema = z.array(
  z.object({ email: z.string(), verified: z.boolean(), primary: z.boolean() }).partial(),
)
const GoogleUserSchema = z.object({
  sub: z.string().min(1),
  email: z.string().nullish(),
  // Only a JSON `true` counts: a truthy check would read the string "false" as verified.
  email_verified: z.unknown().optional(),
  name: z.string().nullish(),
})

// The confirmation pages run no script and load nothing; their one style block
// is allowed by hash, so an injected tag could neither run nor restyle the page.
const PAGE_STYLE =
  'body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}' +
  '.code{font:600 2rem/1.2 ui-monospace,monospace;letter-spacing:.15em}' +
  'button{font:inherit;padding:.5rem 1rem;margin:0 .5rem .5rem 0}'
// One raw piece, so no formatter can add whitespace inside the element and
// break the hash, which covers the element's exact text.
const PAGE_STYLE_ELEMENT = `<style>${PAGE_STYLE}</style>`
const PAGE_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${createHash('sha256').update(PAGE_STYLE).digest('base64')}'`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ')

/** Everything interpolated by `html` is escaped; only the constant style is raw. */
function page(title: string, body: ReturnType<typeof html>) {
  return html`<!doctype html>
    <html lang="en">
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      ${raw(PAGE_STYLE_ELEMENT)}
      <main>${body}</main>
    </html> `
}

/** Static on purpose: the session token must not be interpolated into any page. */
const SIGNED_IN_PAGE = page('Adamant', html`<p>Signed in. Return to the terminal.</p>`)
const CANCELLED_PAGE = page(
  'Adamant',
  html`<p>Sign-in cancelled. The terminal was not signed in.</p>`,
)
const NOT_WAITING_PAGE = page(
  'Adamant',
  html`<p>
    No sign-in is waiting for this browser. It may have expired or been answered already. Run /login
    in the terminal to start again.
  </p>`,
)
const REFUSED_PAGE = page(
  'Adamant',
  html`<p>This request did not come from the confirmation page. Nothing was changed.</p>`,
)
const UNAVAILABLE_PAGE = page(
  'Adamant',
  html`<p>Sign-in is unavailable right now. Try again shortly.</p>`,
)

/**
 * The browser half of a terminal sign-in. The terminal printed the same code; a
 * phishing link sent to someone else shows them a code no terminal of theirs shows.
 * Only the form's POST lets the terminal's poll collect a session.
 */
function confirmPage(userCode: string, formToken: string) {
  return page(
    'Confirm the Adamant sign-in',
    html`<h1>Sign in to the Adamant terminal</h1>
      <p>Check that your terminal shows this code:</p>
      <p class="code">${userCode}</p>
      <p>
        If it shows a different code, or you did not just run /login yourself, cancel. Someone may
        have sent you this link to get a session for your account.
      </p>
      <form method="post" action="${CLI_CONFIRM_PATH}">
        <input type="hidden" name="token" value="${formToken}" />
        <button type="submit" name="action" value="confirm">This is the code in my terminal</button>
        <button type="submit" name="action" value="cancel">Cancel</button>
      </form>`,
  )
}

/**
 * The form's CSRF token, derived one-way from the confirmation cookie: the page
 * proves the POST came from it, and reading the page never yields the cookie.
 */
function confirmFormToken(confirmSecret: string): string {
  return createHash('sha256')
    .update(`adamant-cli-confirm-form:${confirmSecret}`)
    .digest('base64url')
}

function protectPage(c: Context) {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Content-Security-Policy', PAGE_CSP)
  // For browsers that predate frame-ancestors.
  c.header('X-Frame-Options', 'DENY')
  c.header('X-Content-Type-Options', 'nosniff')
}

function readConfirmSecret(c: Context): string | undefined {
  const secret = getCookie(c, CLI_CONFIRM_COOKIE)
  return secret && CONFIRM_SECRET_PATTERN.test(secret) ? secret : undefined
}

function getProviderConfig(config: OAuthConfig, provider: OAuthProvider): OAuthProviderConfig {
  const providerConfig = config[provider]
  if (!providerConfig) {
    throw new OAuthConfigurationError(`${provider} OAuth is not configured`)
  }
  return providerConfig
}

function authorizationUrlFor(
  config: OAuthConfig,
  provider: OAuthProvider,
  state: string,
  codeChallenge: string,
): string {
  const providerConfig = getProviderConfig(config, provider)
  const params = new URLSearchParams({
    client_id: providerConfig.clientId,
    redirect_uri: providerConfig.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  if (provider === 'github') {
    // Enough for /user (id and login are public) and /user/emails; `read:user`
    // would also grant the private profile, which sign-in never reads.
    params.set('scope', 'user:email')
    return `https://github.com/login/oauth/authorize?${params.toString()}`
  }

  // No `access_type=offline`: sign-in reads the profile once and keeps no
  // provider token, so a refresh token would only be one more secret in flight.
  params.set('response_type', 'code')
  params.set('scope', 'openid email profile')
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

function oauthStateCookieName(provider: OAuthProvider): string {
  return `adamant_oauth_${provider}_state`
}

function oauthStateCookiePath(provider: OAuthProvider): string {
  return `/auth/${provider}/callback`
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function matchesBrowserState(browserState: string | undefined, callbackState: string): boolean {
  return browserState !== undefined && safeEqual(browserState, callbackState)
}

/**
 * One provider request, read as JSON. Failures name the request and status
 * only: the request carries the code, verifier and client secret, a token
 * response carries the access token, and JSON.parse quotes the body it rejects,
 * so none of them reaches an error message or a log.
 */
async function providerJson(
  fetchProvider: typeof globalThis.fetch,
  what: string,
  url: string,
  init: RequestInit,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  let response: Response
  try {
    response = await fetchProvider(url, {
      ...init,
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new OAuthProviderError(`${what} was unreachable`)
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (body === undefined && response.ok) {
    throw new OAuthProviderError(`${what} did not return JSON`)
  }
  return { status: response.status, ok: response.ok, body }
}

/** The provider's OAuth error code (`bad_verification_code`), never its free-text description. */
function providerErrorCode(body: unknown): string {
  const parsed = z.object({ error: z.string().max(100) }).safeParse(body)
  return parsed.success ? ` (${parsed.data.error})` : ''
}

async function exchangeCode(
  fetchProvider: typeof globalThis.fetch,
  config: OAuthConfig,
  provider: OAuthProvider,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const providerConfig = getProviderConfig(config, provider)

  const body = new URLSearchParams({
    client_id: providerConfig.clientId,
    client_secret: providerConfig.clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: providerConfig.redirectUri,
  })

  const what = provider === 'github' ? 'GitHub token exchange' : 'Google token exchange'
  if (provider === 'google') body.set('grant_type', 'authorization_code')

  const response = await providerJson(
    fetchProvider,
    what,
    provider === 'github'
      ? 'https://github.com/login/oauth/access_token'
      : 'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers:
        provider === 'github'
          ? { Accept: 'application/json' }
          : { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  )

  // GitHub reports a bad or reused code as 200 with an `error` field.
  const token = TokenResponseSchema.safeParse(response.body)
  if (!response.ok || !token.success) {
    throw new OAuthProviderError(
      `${what} failed with ${response.status}${providerErrorCode(response.body)}`,
    )
  }
  return token.data.access_token
}

async function authenticateOAuthUser(
  fetchProvider: typeof globalThis.fetch,
  provider: OAuthProvider,
  accessToken: string,
): Promise<{
  providerUserId: string
  username: string
  email?: string
}> {
  if (provider === 'github') {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Adamant',
    }
    const userResponse = await providerJson(
      fetchProvider,
      'GitHub user lookup',
      'https://api.github.com/user',
      { headers },
    )
    const user = GithubUserSchema.safeParse(userResponse.body)
    if (!userResponse.ok || !user.success) {
      throw new OAuthProviderError(`GitHub user lookup failed with ${userResponse.status}`)
    }

    // A user who keeps every address private still signs in, with no email.
    // Only a verified address is kept, since it is what account linking trusts.
    const emailsResponse = await providerJson(
      fetchProvider,
      'GitHub email lookup',
      'https://api.github.com/user/emails',
      { headers },
    )
    const emails = GithubEmailsSchema.safeParse(emailsResponse.body)
    const verified =
      emailsResponse.ok && emails.success
        ? emails.data.filter((entry) => entry.email && entry.verified === true)
        : []
    const verifiedEmail = (verified.find((entry) => entry.primary === true) ?? verified[0])?.email
      ?.trim()
      .toLowerCase()

    return {
      providerUserId: String(user.data.id),
      username: user.data.login,
      ...(verifiedEmail ? { email: verifiedEmail } : {}),
    }
  }

  const response = await providerJson(
    fetchProvider,
    'Google user lookup',
    'https://openidconnect.googleapis.com/v1/userinfo',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  const user = GoogleUserSchema.safeParse(response.body)
  if (!response.ok || !user.success) {
    throw new OAuthProviderError(`Google user lookup failed with ${response.status}`)
  }

  const email = user.data.email?.trim().toLowerCase()
  return {
    providerUserId: user.data.sub,
    username: user.data.name || email || user.data.sub,
    // An unverified address is whatever the user typed; it must not link accounts.
    ...(user.data.email_verified === true && email ? { email } : {}),
  }
}

/** Spends the state, redeems the code with its verifier, and returns the Adamant user. */
async function identifyUser(
  db: Db,
  config: OAuthConfig,
  fetchProvider: typeof globalThis.fetch,
  provider: OAuthProvider,
  code: string,
  state: string,
): Promise<string> {
  const claimed = await consumeOAuthState(db, provider, state)

  if (!claimed) {
    throw new InvalidOAuthStateError()
  }

  const accessToken = await exchangeCode(
    fetchProvider,
    config,
    provider,
    code,
    claimed.codeVerifier,
  )

  const identity = await authenticateOAuthUser(fetchProvider, provider, accessToken)

  const { userId } = await upsertOAuthIdentity(db, {
    provider,
    providerUserId: identity.providerUserId,
    username: identity.username,
    ...(identity.email ? { email: identity.email } : {}),
  })

  return userId
}

function oauthFailureStatus(error: unknown): 500 | 502 | 503 {
  if (error instanceof OAuthConfigurationError || isDatabaseUnavailable(error)) return 503
  return error instanceof OAuthProviderError ? 502 : 500
}

/** An outage says so, whatever the route would otherwise call its failure. */
function failure(c: Context, error: unknown, message: string) {
  if (isDatabaseUnavailable(error)) return c.json({ error: DATABASE_UNAVAILABLE }, 503)
  return c.json({ error: message }, oauthFailureStatus(error))
}

export function createAuthRoute(db: Db, config: OAuthConfig, options: AuthRouteOptions = {}) {
  const auth = new Hono<{ Variables: AuthVariables }>()
  const fetchProvider = options.fetch ?? globalThis.fetch
  const requireSession = createAuthMiddleware({ database: db })
  const cliLogins = options.cliLogins ?? createPostgresCliLoginStore(db)
  const rateLimit =
    options.rateLimit ?? createRateLimit({ burst: SIGN_IN_BURST, perMinute: SIGN_IN_PER_MINUTE })

  /** Ends a waiting terminal login now instead of letting it poll until expiry. */
  const endCliLogin = async (provider: OAuthProvider, state: string) => {
    if (provider !== 'github') return
    try {
      await cliLogins.cancel(state)
    } catch (error) {
      console.error('GitHub CLI login could not be ended', redactDatabaseError(error))
    }
  }

  const setStateCookie = (c: Context, provider: OAuthProvider, state: string) =>
    setCookie(c, oauthStateCookieName(provider), state, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: oauthStateCookiePath(provider),
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    })

  for (const provider of ['github', 'google'] as const) {
    auth.get(`/${provider}`, rateLimit, async (c) => {
      try {
        getProviderConfig(config, provider)
        const { state, codeChallenge } = await createOAuthState(db, provider)
        setStateCookie(c, provider, state)
        return c.redirect(authorizationUrlFor(config, provider, state, codeChallenge))
      } catch (error) {
        console.error(`${provider} OAuth initialization failed`, redactDatabaseError(error))
        return failure(c, error, 'OAuth authentication is unavailable')
      }
    })

    auth.get(`/${provider}/callback`, async (c) => {
      c.header('Cache-Control', 'no-store')
      // The URL carries the code and state; no page served from it may pass it on.
      c.header('Referrer-Policy', 'no-referrer')
      const code = c.req.query('code')
      const state = c.req.query('state')
      const declined = c.req.query('error') !== undefined

      if (!state || (!code && !declined)) {
        return c.json({ error: 'OAuth code and state are required' }, 400)
      }

      const browserState = getCookie(c, oauthStateCookieName(provider))
      if (!matchesBrowserState(browserState, state)) {
        return c.json({ error: 'Invalid or expired OAuth state' }, 400)
      }

      deleteCookie(c, oauthStateCookieName(provider), {
        secure: true,
        path: oauthStateCookiePath(provider),
      })

      if (declined || !code) {
        // The user said no (or the provider refused). Spend the state so it
        // cannot be replayed, and end a waiting CLI login now instead of letting
        // it poll until expiry. The provider's description is not echoed.
        await endCliLogin(provider, state)
        await consumeOAuthState(db, provider, state).catch((error: unknown) => {
          console.error(`${provider} OAuth state could not be spent`, redactDatabaseError(error))
        })
        return c.json({ error: 'Sign-in was cancelled or refused by the provider.' }, 403)
      }

      try {
        const userId = await identifyUser(db, config, fetchProvider, provider, code, state)
        if (provider === 'github') {
          // A terminal login gets no session here: this browser must first say
          // the code matches the terminal's, and the terminal's poll mints it.
          // A browser copy would also outlive the terminal's in the cookie jar.
          const confirmSecret = randomBytes(32).toString('base64url')
          const waiting = await cliLogins.authorize(state, userId, confirmSecret)
          if (waiting) {
            setCookie(c, CLI_CONFIRM_COOKIE, confirmSecret, {
              httpOnly: true,
              secure: true,
              // Lax, not Strict: the redirect below is still part of the navigation
              // GitHub started, and Strict would withhold the cookie from it.
              sameSite: 'Lax',
              path: CLI_CONFIRM_PATH,
              maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
            })
            // 303 so a reload shows the page instead of replaying a spent code.
            return c.redirect(CLI_CONFIRM_PATH, 303)
          }
        }
        const session = await createSession(db, userId)
        setCookie(c, SESSION_COOKIE_NAME, session.token, {
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
          path: '/',
          maxAge: SESSION_MAX_AGE_SECONDS,
        })
        return c.json({ authenticated: true })
      } catch (error) {
        if (error instanceof InvalidOAuthStateError) {
          return c.json({ error: 'Invalid or expired OAuth state' }, 400)
        }
        await endCliLogin(provider, state)
        if (error instanceof OAuthAccountConflictError) {
          return c.json({ error: ACCOUNT_CONFLICT_MESSAGE }, 409)
        }
        console.error(`${provider} OAuth callback failed`, redactDatabaseError(error))
        return failure(c, error, 'OAuth authentication failed')
      }
    })
  }

  auth.post('/github/cli/start', rateLimit, async (c) => {
    c.header('Cache-Control', 'no-store')
    try {
      getProviderConfig(config, 'github')
      const loginId = randomBytes(32).toString('base64url')
      const pollSecret = randomBytes(32).toString('base64url')
      const userCode = generateUserCode()
      const payload = CliLoginStartSchema.safeParse({
        loginId,
        pollSecret,
        userCode,
        beginPath: `/auth/github/cli/begin?login=${loginId}`,
      })
      if (!payload.success) {
        return c.json({ error: 'OAuth authentication is unavailable' }, 500)
      }
      const stored = await cliLogins.create({
        loginId,
        pollSecret,
        userCode,
        expiresAt: new Date(Date.now() + OAUTH_STATE_MAX_AGE_SECONDS * 1000),
      })
      if (!stored) {
        return c.json({ error: 'Too many sign-ins are in progress. Try again shortly.' }, 503)
      }
      return c.json(payload.data)
    } catch (error) {
      console.error('GitHub CLI login failed to start', redactDatabaseError(error))
      return failure(c, error, 'OAuth authentication is unavailable')
    }
  })

  auth.get('/github/cli/begin', rateLimit, async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    const loginId = c.req.query('login')
    if (!loginId || loginId.length > 200) {
      return c.json({ error: 'Sign-in expired or unknown.' }, 400)
    }
    try {
      getProviderConfig(config, 'github')
      // A fresh state per visit: the store keeps only its hash, so an earlier one
      // cannot be read back, and opening the link again simply rebinds the login.
      const { state, codeChallenge } = await createOAuthState(db, 'github')
      if (!(await cliLogins.bind(loginId, state))) {
        await consumeOAuthState(db, 'github', state)
        return c.json({ error: 'Sign-in expired or unknown.' }, 400)
      }
      setStateCookie(c, 'github', state)
      return c.redirect(authorizationUrlFor(config, 'github', state, codeChallenge))
    } catch (error) {
      console.error('GitHub CLI login could not redirect', redactDatabaseError(error))
      return failure(c, error, 'OAuth authentication is unavailable')
    }
  })

  auth.get('/github/cli/confirm', async (c) => {
    protectPage(c)
    const confirmSecret = readConfirmSecret(c)
    if (!confirmSecret) return c.html(NOT_WAITING_PAGE, 400)
    try {
      const waiting = await cliLogins.awaiting(confirmSecret)
      if (!waiting) return c.html(NOT_WAITING_PAGE, 400)
      return c.html(confirmPage(waiting.userCode, confirmFormToken(confirmSecret)))
    } catch (error) {
      console.error('GitHub CLI login confirmation failed to load', redactDatabaseError(error))
      return c.html(UNAVAILABLE_PAGE, oauthFailureStatus(error))
    }
  })

  auth.post('/github/cli/confirm', async (c) => {
    protectPage(c)
    // Three independent checks that the page itself sent this: the browser says
    // so, the SameSite cookie came along, and the form carries the token that
    // only someone holding the cookie could derive.
    const site = c.req.header('Sec-Fetch-Site')
    const confirmSecret = readConfirmSecret(c)
    const form: Record<string, unknown> = await c.req.parseBody().catch(() => ({}))
    const token = form.token
    const action = form.action
    if (
      (site !== undefined && site !== 'same-origin') ||
      !confirmSecret ||
      typeof token !== 'string' ||
      !safeEqual(token, confirmFormToken(confirmSecret)) ||
      (action !== 'confirm' && action !== 'cancel')
    ) {
      return c.html(REFUSED_PAGE, 403)
    }

    try {
      const decided = await cliLogins.decide(confirmSecret, action)
      deleteCookie(c, CLI_CONFIRM_COOKIE, { secure: true, path: CLI_CONFIRM_PATH })
      if (!decided) return c.html(NOT_WAITING_PAGE, 400)
      return c.html(action === 'confirm' ? SIGNED_IN_PAGE : CANCELLED_PAGE)
    } catch (error) {
      console.error('GitHub CLI login could not be confirmed', redactDatabaseError(error))
      return c.html(UNAVAILABLE_PAGE, oauthFailureStatus(error))
    }
  })

  auth.post('/github/cli/token', async (c) => {
    c.header('Cache-Control', 'no-store')
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = CliLoginPollSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Sign-in expired or unknown.' }, 400)
    try {
      const result = await cliLogins.take(parsed.data.loginId, parsed.data.pollSecret)
      if (result.status === 'pending') return c.json({ status: 'pending' }, 202)
      if (result.status === 'cancelled') {
        return c.json({ error: 'Sign-in was cancelled or failed in the browser.' }, 403)
      }
      if (result.status === 'missing') return c.json({ error: 'Sign-in expired or unknown.' }, 404)
      // This poll alone moved the login to consumed. If the insert below fails,
      // the login is spent and the terminal starts another.
      const session = await createSession(db, result.userId)
      return c.json({ token: session.token })
    } catch (error) {
      console.error('GitHub CLI login poll failed', redactDatabaseError(error))
      return failure(c, error, 'Sign-in failed')
    }
  })

  // No session required: an expired or already revoked token must still be able
  // to sign out, or the CLI keeps a dead token it cannot clear. Only the session
  // the presented token names is revoked; the user's other sessions stay.
  auth.post('/logout', async (c) => {
    c.header('Cache-Control', 'no-store')
    const token = readSessionToken(c)
    try {
      if (token) await revokeSessionToken(db, token)
    } catch (error) {
      console.error('Failed to logout', redactDatabaseError(error))
      return failure(c, error, 'Failed to logout')
    }
    // Only a request that carried the cookie clears it, which a cross-site form
    // post (SameSite=Lax withholds it) cannot do.
    if (getCookie(c, SESSION_COOKIE_NAME) !== undefined) {
      deleteCookie(c, SESSION_COOKIE_NAME, {
        secure: true,
        path: '/',
      })
    }
    return c.json({ message: 'Logged out successfully' })
  })

  auth.use('/me', requireSession)
  auth.get('/me', async (c) => {
    c.header('Cache-Control', 'no-store')
    try {
      const user = await getUserAuthInfo(db, c.get('userId'))
      // A session without its user is no session: 401 sends the client to sign in again.
      return user ? c.json({ user }) : c.json({ error: 'Unauthorized' }, 401)
    } catch (error) {
      console.error('Failed to load user', redactDatabaseError(error))
      return failure(c, error, 'Failed to load user')
    }
  })

  return auth
}
