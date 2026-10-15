import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DrizzleQueryError } from 'drizzle-orm'

import { createAuthRoute, type OAuthConfig } from '../../server/api/routes/auth.ts'
import { pkceChallenge } from '../../server/api/services/authService.ts'
import { createMemoryCliLoginStore } from '../../server/api/services/cliLogin.ts'
import { oauthStates, sessions, userIdentities, users, type Db } from '../../server/db/client.ts'
import {
  captureLogs,
  cookieValue,
  createFakeAuthDb,
  github,
  GITHUB_EMAILS_URL,
  GITHUB_TOKEN_URL,
  GITHUB_USER_URL,
  githubProvider,
  google,
  GOOGLE_TOKEN_URL,
  GOOGLE_USER_URL,
  googleProvider,
  PROVIDER_ACCESS_TOKEN,
  sha256,
  type FakeAuthDb,
} from './auth-fakes.ts'

type Provider = 'github' | 'google'

const CODE = 'oauth-code-value-1234'
const config: OAuthConfig = { github, google }

function setUp(
  provider: ReturnType<typeof githubProvider> = githubProvider(),
  oauthConfig: OAuthConfig = config,
) {
  const fake = createFakeAuthDb()
  const app = createAuthRoute(fake.db, oauthConfig, {
    fetch: provider.fetch,
    cliLogins: createMemoryCliLoginStore(),
  })
  return { fake, app, provider }
}

async function authorize(app: ReturnType<typeof createAuthRoute>, provider: Provider) {
  const response = await app.request(`/${provider}`)
  const location = new URL(response.headers.get('location') ?? 'about:blank')
  return { response, location, state: location.searchParams.get('state') ?? '' }
}

function callback(
  app: ReturnType<typeof createAuthRoute>,
  provider: Provider,
  query: Record<string, string>,
  cookie: { provider: Provider; state: string } | undefined,
) {
  return app.request(`/${provider}/callback?${new URLSearchParams(query).toString()}`, {
    headers: cookie ? { Cookie: `adamant_oauth_${cookie.provider}_state=${cookie.state}` } : {},
  })
}

/** Authorize, then come back with a code, as a browser does. */
async function signIn(app: ReturnType<typeof createAuthRoute>, provider: Provider) {
  const { state } = await authorize(app, provider)
  return callback(app, provider, { code: CODE, state }, { provider, state })
}

function liveState(fake: FakeAuthDb, provider: Provider, state: string, expiresInMs = 60_000) {
  fake.add(oauthStates, {
    state,
    provider,
    codeVerifier: `verifier-for-${state}`,
    expiresAt: new Date(Date.now() + expiresInMs),
  })
}

/** The token exchange's form body, as the provider received it. */
function exchangeBody(provider: ReturnType<typeof githubProvider>, url: string) {
  return new URLSearchParams(String(provider.calls.find((call) => call.url === url)?.init?.body))
}

const SECRETS = [github.clientSecret, google.clientSecret, CODE, PROVIDER_ACCESS_TOKEN]

function assertNoSecrets(text: string) {
  for (const secret of SECRETS) {
    assert.equal(text.includes(secret), false, `leaked ${secret}`)
  }
}

describe('OAuth authorize redirect', () => {
  for (const provider of ['github', 'google'] as const) {
    it(`answers 503, not a crash, when ${provider} is not configured`, async () => {
      const fake = createFakeAuthDb()
      const app = createAuthRoute(fake.db, {})

      const response = await app.request(`/${provider}`)

      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: 'OAuth authentication is unavailable' })
      assert.deepEqual(fake.rows(oauthStates), [])
    })

    it(`answers 503 on the ${provider} callback when the provider is not configured`, async () => {
      const fake = createFakeAuthDb()
      liveState(fake, provider, 'state-1')
      const app = createAuthRoute(fake.db, {}, { cliLogins: createMemoryCliLoginStore() })

      const response = await callback(
        app,
        provider,
        { code: CODE, state: 'state-1' },
        { provider, state: 'state-1' },
      )

      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: 'OAuth authentication failed' })
    })
  }

  it('sends Google a code request with no offline access and no client secret', async () => {
    const { fake, app } = setUp()
    const { response, location, state } = await authorize(app, 'google')

    assert.equal(response.status, 302)
    assert.equal(
      location.origin + location.pathname,
      'https://accounts.google.com/o/oauth2/v2/auth',
    )
    assert.equal(location.searchParams.get('response_type'), 'code')
    assert.equal(location.searchParams.get('scope'), 'openid email profile')
    assert.equal(location.searchParams.get('redirect_uri'), google.redirectUri)
    assert.equal(location.searchParams.has('access_type'), false)
    assert.equal(location.searchParams.has('client_secret'), false)
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(
      location.searchParams.get('code_challenge'),
      pkceChallenge(String(fake.rows(oauthStates)[0]?.codeVerifier)),
    )
    assert.deepEqual(
      fake.rows(oauthStates).map((row) => [row.state, row.provider]),
      [[state, 'google']],
    )
    assert.match(cookieValue(response, 'adamant_oauth_google_state') ?? '', /^[\w-]{43}$/)
  })

  it('has no redirect parameter to abuse: the target is always the provider', async () => {
    const { app } = setUp()
    const evil = 'https://evil.example/steal'

    for (const provider of ['github', 'google'] as const) {
      const response = await app.request(
        `/${provider}?redirect_uri=${encodeURIComponent(evil)}&return_to=${encodeURIComponent(evil)}&next=//evil.example&redirect=${encodeURIComponent(evil)}`,
      )
      const location = response.headers.get('location') ?? ''

      assert.equal(response.status, 302)
      assert.equal(location.includes('evil.example'), false)
      assert.equal(
        new URL(location).searchParams.get('redirect_uri'),
        provider === 'github' ? github.redirectUri : google.redirectUri,
      )
    }

    const done = await signIn(app, 'github')
    const returned = await callback(
      app,
      'github',
      { code: CODE, state: 'x', return_to: evil },
      { provider: 'github', state: 'x' },
    )
    assert.equal(done.headers.get('location'), null)
    assert.equal(returned.headers.get('location'), null)
  })
})

describe('OAuth PKCE and scope', () => {
  it('asks GitHub only for user:email, the narrowest scope that reads the id, login and emails', async () => {
    const { app } = setUp()
    const { location } = await authorize(app, 'github')

    assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize')
    assert.equal(location.searchParams.get('scope'), 'user:email')
  })

  for (const [provider, tokenUrl, fetchProvider] of [
    ['github', GITHUB_TOKEN_URL, githubProvider],
    ['google', GOOGLE_TOKEN_URL, googleProvider],
  ] as const) {
    it(`sends ${provider} an S256 challenge and redeems the code with its verifier`, async (t) => {
      const logs = captureLogs(t)
      const provided = fetchProvider()
      const { fake, app } = setUp(provided)
      const { location, state } = await authorize(app, provider)
      const verifier = String(fake.rows(oauthStates)[0]?.codeVerifier)
      const challenge = location.searchParams.get('code_challenge')

      const response = await callback(app, provider, { code: CODE, state }, { provider, state })

      assert.equal(response.status, 200)
      // RFC 7636: 43-128 unreserved characters, and the challenge is base64url(SHA-256).
      assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/)
      assert.equal(location.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(challenge, pkceChallenge(verifier))
      assert.notEqual(challenge, verifier)
      assert.equal(exchangeBody(provided, tokenUrl).get('code_verifier'), verifier)
      // The verifier leaves only in the token request body: no URL, no cookie, no log.
      assert.equal(location.href.includes(verifier), false)
      for (const call of provided.calls) assert.equal(call.url.includes(verifier), false)
      assert.equal(logs().includes(verifier), false)
      assert.deepEqual(fake.rows(oauthStates), [])
    })
  }

  it('gives each authorization its own verifier', async () => {
    const { fake, app } = setUp()
    await authorize(app, 'github')
    await authorize(app, 'github')

    const verifiers = fake.rows(oauthStates).map((row) => row.codeVerifier)
    assert.equal(new Set(verifiers).size, 2)
  })

  it('refuses a state stored without a verifier before talking to the provider', async () => {
    const { fake, app, provider } = setUp()
    fake.add(oauthStates, {
      state: 'pre-pkce',
      provider: 'github',
      codeVerifier: null,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const response = await callback(
      app,
      'github',
      { code: CODE, state: 'pre-pkce' },
      { provider: 'github', state: 'pre-pkce' },
    )

    assert.equal(response.status, 400)
    assert.equal(provider.calls.length, 0)
    // Spent all the same: it cannot be tried again.
    assert.deepEqual(fake.rows(oauthStates), [])
  })

  it('answers 503 when the database is down, and logs neither the state nor the verifier', async (t) => {
    const logs = captureLogs(t)
    const written: unknown[] = []
    const refused = Object.assign(new Error('connect ECONNREFUSED ::1:5432'), {
      code: 'ECONNREFUSED',
    })
    const database = {
      insert: () => ({
        values: async (value: Record<string, unknown>) => {
          written.push(...Object.values(value))
          // What drizzle throws: the SQL, every bound value, and the driver's error.
          throw new DrizzleQueryError(
            'insert into "oauth_states" values ($1, $2, $3, $4)',
            Object.values(value),
            new AggregateError([refused], 'connect failed'),
          )
        },
      }),
    } as unknown as Db
    const app = createAuthRoute(database, config, { cliLogins: createMemoryCliLoginStore() })

    const response = await app.request('/github')
    const logged = logs()

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'The database is unavailable' })
    assert.ok(written.length > 0)
    for (const value of written) {
      if (typeof value === 'string' && value.length > 20) {
        assert.equal(logged.includes(value), false, 'a bound value reached the log')
      }
    }
    assert.match(logged, /ECONNREFUSED/)
  })

  it('limits authorize redirects per client', async () => {
    const fake = createFakeAuthDb()
    const app = createAuthRoute(fake.db, config, {
      cliLogins: createMemoryCliLoginStore(),
      rateLimit: async (c) =>
        c.json({ error: 'Too many sign-in attempts. Try again shortly.' }, 429),
    })

    for (const provider of ['github', 'google'] as const) {
      assert.equal((await app.request(`/${provider}`)).status, 429)
    }
    assert.deepEqual(fake.rows(oauthStates), [])
  })
})

describe('OAuth callback state', () => {
  it('needs both a state and a code (or a provider error)', async () => {
    const { app, provider } = setUp()
    const cookie = { provider: 'github' as const, state: 's' }

    for (const query of [{ code: CODE }, { state: 's' }, {}, { error: 'access_denied' }]) {
      const response = await callback(app, 'github', query, cookie)
      assert.equal(response.status, 400, JSON.stringify(query))
    }
    assert.equal(provider.calls.length, 0)
  })

  it('refuses an unknown state before talking to the provider', async () => {
    const { app, provider } = setUp()

    const response = await callback(
      app,
      'github',
      { code: CODE, state: 'never-issued' },
      { provider: 'github', state: 'never-issued' },
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Invalid or expired OAuth state' })
    assert.equal(provider.calls.length, 0)
  })

  it('refuses an expired state and leaves it for cleanup', async () => {
    const { fake, app, provider } = setUp()
    liveState(fake, 'github', 'old-state', -1)

    const response = await callback(
      app,
      'github',
      { code: CODE, state: 'old-state' },
      { provider: 'github', state: 'old-state' },
    )

    assert.equal(response.status, 400)
    assert.equal(provider.calls.length, 0)
    assert.equal(fake.rows(sessions).length, 0)
  })

  it('refuses a replayed state, even with the original cookie', async () => {
    const { fake, app, provider } = setUp()
    const { state } = await authorize(app, 'github')
    const cookie = { provider: 'github' as const, state }

    const first = await callback(app, 'github', { code: CODE, state }, cookie)
    const replay = await callback(app, 'github', { code: CODE, state }, cookie)

    assert.equal(first.status, 200)
    assert.equal(replay.status, 400)
    assert.equal(provider.calls.filter((call) => call.url === GITHUB_TOKEN_URL).length, 1)
    assert.equal(fake.rows(sessions).length, 1)
  })

  it('spends the state cookie on the callback', async () => {
    const { app } = setUp()
    const response = await signIn(app, 'github')
    const cleared = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('adamant_oauth_github_state='))

    assert.match(cleared ?? '', /Max-Age=0/i)
    assert.match(cleared ?? '', /Path=\/auth\/github\/callback/i)
  })

  it('refuses a GitHub state on the Google callback, cookie or no cookie', async () => {
    const { fake, app } = setUp(googleProvider())
    const { state } = await authorize(app, 'github')

    // The browser holds the state under GitHub's cookie name and path.
    const crossed = await callback(
      app,
      'google',
      { code: CODE, state },
      { provider: 'github', state },
    )
    // A cookie planted under Google's name still meets a state Postgres issued for GitHub.
    const planted = await callback(
      app,
      'google',
      { code: CODE, state },
      { provider: 'google', state },
    )

    assert.equal(crossed.status, 400)
    assert.equal(planted.status, 400)
    assert.equal(fake.rows(sessions).length, 0)
    assert.deepEqual(
      fake.rows(oauthStates).map((row) => row.provider),
      ['github'],
    )
  })
})

describe('OAuth callback failures', () => {
  it('ends a declined sign-in with 403, spends the state and does not echo the provider', async () => {
    const { fake, app, provider } = setUp()
    const { state } = await authorize(app, 'github')
    const description = 'The+user+has+denied+your+application+<script>'

    const response = await callback(
      app,
      'github',
      { error: 'access_denied', error_description: description, state },
      { provider: 'github', state },
    )
    const body = await response.text()

    assert.equal(response.status, 403)
    assert.deepEqual(JSON.parse(body), {
      error: 'Sign-in was cancelled or refused by the provider.',
    })
    assert.equal(body.includes('script'), false)
    assert.equal(provider.calls.length, 0)
    assert.deepEqual(fake.rows(oauthStates), [])
    assert.equal(cookieValue(response, 'adamant_session'), undefined)
  })

  it('refuses a declined callback that is not bound to this browser', async () => {
    const { fake, app } = setUp()
    const { state } = await authorize(app, 'github')

    const response = await callback(app, 'github', { error: 'access_denied', state }, undefined)

    assert.equal(response.status, 400)
    assert.equal(fake.rows(oauthStates).length, 1)
  })

  const failures: [string, ReturnType<typeof githubProvider>][] = [
    [
      'the token endpoint fails',
      githubProvider({ [GITHUB_TOKEN_URL]: () => new Response('', { status: 500 }) }),
    ],
    [
      'the code is rejected',
      githubProvider({
        [GITHUB_TOKEN_URL]: () =>
          Response.json({
            error: 'bad_verification_code',
            error_description: `The code ${CODE} passed is incorrect or expired.`,
          }),
      }),
    ],
    [
      'the token response is not JSON',
      githubProvider({
        [GITHUB_TOKEN_URL]: () =>
          new Response(
            `access_token=${PROVIDER_ACCESS_TOKEN}&scope=user%3Aemail&token_type=bearer`,
          ),
      }),
    ],
    [
      'the provider is unreachable',
      githubProvider({
        [GITHUB_TOKEN_URL]: () => {
          throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') })
        },
      }),
    ],
    [
      'the profile has no id',
      githubProvider({ [GITHUB_USER_URL]: () => Response.json({ login: 'octocat' }) }),
    ],
    [
      'the profile id is not a number',
      githubProvider({ [GITHUB_USER_URL]: () => Response.json({ id: '123', login: 'octocat' }) }),
    ],
    [
      'the profile is not JSON',
      githubProvider({ [GITHUB_USER_URL]: () => new Response('<html>rate limited</html>') }),
    ],
    [
      'the profile request fails',
      githubProvider({ [GITHUB_USER_URL]: () => new Response('{}', { status: 401 }) }),
    ],
  ]

  for (const [name, provider] of failures) {
    it(`answers 502 with no session and no secret when ${name}`, async (t) => {
      const logs = captureLogs(t)
      const { fake, app } = setUp(provider)

      const response = await signIn(app, 'github')
      const body = await response.text()

      assert.equal(response.status, 502)
      assert.deepEqual(JSON.parse(body), { error: 'OAuth authentication failed' })
      assert.equal(cookieValue(response, 'adamant_session'), undefined)
      assert.equal(fake.rows(sessions).length, 0)
      assertNoSecrets(body)
      assertNoSecrets(logs())
    })
  }

  it('answers 502 when the Google profile has no subject', async () => {
    const { app } = setUp(
      googleProvider({ [GOOGLE_USER_URL]: () => Response.json({ email: 'a@example.com' }) }),
    )
    assert.equal((await signIn(app, 'google')).status, 502)
  })

  it('sends the client secret and code only in the token request body', async () => {
    const { app, provider } = setUp()
    await signIn(app, 'github')

    const [exchange, ...lookups] = provider.calls
    assert.equal(exchange?.url, GITHUB_TOKEN_URL)
    assert.equal(exchange?.init?.method, 'POST')
    const sent = new URLSearchParams(String(exchange?.init?.body))
    assert.equal(sent.get('client_secret'), github.clientSecret)
    assert.equal(sent.get('code'), CODE)
    assert.match(sent.get('code_verifier') ?? '', /^[\w-]{43}$/)
    assert.ok(exchange?.init?.signal instanceof AbortSignal)
    for (const call of provider.calls) assertNoSecrets(call.url)
    for (const lookup of lookups) {
      assert.equal(String(lookup.init?.body ?? '').includes(github.clientSecret), false)
    }
  })
})

describe('OAuth identities', () => {
  const noEmail: [string, ReturnType<typeof githubProvider>][] = [
    ['has no addresses listed', githubProvider()],
    [
      'lists only unverified addresses',
      githubProvider({
        [GITHUB_EMAILS_URL]: () =>
          Response.json([{ email: 'octo@example.com', verified: false, primary: true }]),
      }),
    ],
    [
      'withholds the email list',
      githubProvider({ [GITHUB_EMAILS_URL]: () => new Response('{}', { status: 404 }) }),
    ],
    [
      'returns an email list of the wrong shape',
      githubProvider({ [GITHUB_EMAILS_URL]: () => Response.json({ email: 'octo@example.com' }) }),
    ],
  ]

  for (const [name, provider] of noEmail) {
    it(`signs in a GitHub user who ${name}, with no email`, async () => {
      const { fake, app } = setUp(provider)

      const response = await signIn(app, 'github')
      const token = cookieValue(response, 'adamant_session') ?? ''
      const me = await app.request('/me', { headers: { Authorization: `Bearer ${token}` } })

      assert.equal(response.status, 200)
      assert.deepEqual(await me.json(), {
        user: {
          id: fake.rows(users)[0]?.id,
          username: 'github_octocat',
          email: null,
          providers: ['github'],
        },
      })
      assert.equal(fake.rows(userIdentities)[0]?.email, null)
    })
  }

  it('keeps the primary verified GitHub address, lowercased', async () => {
    const { fake, app } = setUp(
      githubProvider({
        [GITHUB_EMAILS_URL]: () =>
          Response.json([
            { email: 'other@example.com', verified: true, primary: false },
            { email: 'unverified@example.com', verified: false, primary: false },
            { email: 'Octo@Example.COM', verified: true, primary: true },
          ]),
      }),
    )

    assert.equal((await signIn(app, 'github')).status, 200)
    assert.equal(fake.rows(users)[0]?.email, 'octo@example.com')
    assert.equal(fake.rows(userIdentities)[0]?.email, 'octo@example.com')
  })

  for (const verified of [false, 'true', 'false', undefined]) {
    it(`does not trust a Google address whose email_verified is ${JSON.stringify(verified)}`, async () => {
      const { fake, app } = setUp(
        googleProvider({
          [GOOGLE_USER_URL]: () =>
            Response.json({
              sub: 'google-sub-1',
              email: 'victim@example.com',
              email_verified: verified,
              name: 'Mallory',
            }),
        }),
      )

      assert.equal((await signIn(app, 'google')).status, 200)
      assert.equal(fake.rows(users)[0]?.email, null)
      assert.equal(fake.rows(userIdentities)[0]?.email, null)
      assert.equal(fake.rows(users)[0]?.username, 'google_Mallory')
    })
  }

  it('keeps a verified Google address, lowercased', async () => {
    const { fake, app } = setUp(googleProvider())

    assert.equal((await signIn(app, 'google')).status, 200)
    assert.equal(fake.rows(users)[0]?.email, 'person@example.com')
  })

  it('refuses with 409, and no session, a Google email that a GitHub account holds unvouched', async () => {
    const { fake, app } = setUp(
      googleProvider({
        [GOOGLE_USER_URL]: () =>
          Response.json({ sub: 'attacker', email: 'victim@example.com', email_verified: true }),
      }),
    )
    const victim = fake.add(users, { username: 'github_victim', email: 'victim@example.com' })
    // GitHub no longer vouches for the address on the victim's account.
    fake.add(userIdentities, {
      userId: victim.id,
      provider: 'github',
      providerUserId: '1',
      email: 'new@example.com',
    })

    const response = await signIn(app, 'google')

    assert.equal(response.status, 409)
    const { error } = (await response.json()) as { error: string }
    assert.match(error, /belongs to another Adamant account/)
    assert.equal(cookieValue(response, 'adamant_session'), undefined)
    assert.equal(fake.rows(sessions).length, 0)
    assert.equal(fake.rows(userIdentities).length, 1)
  })

  it('hands a browser its session only as a non-cacheable HttpOnly cookie', async () => {
    const { fake, app } = setUp()

    const response = await signIn(app, 'github')
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('adamant_session='))
    const token = cookieValue(response, 'adamant_session') ?? ''
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(body), { authenticated: true })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.match(cookie ?? '', /HttpOnly/i)
    assert.match(cookie ?? '', /Secure/i)
    assert.match(cookie ?? '', /SameSite=Lax/i)
    assert.match(cookie ?? '', /Path=\//)
    assert.match(cookie ?? '', /Max-Age=2592000/)
    assert.equal(fake.rows(sessions)[0]?.tokenHash, sha256(token))
    assert.equal(body.includes(token), false)
    assertNoSecrets(body)
  })
})
