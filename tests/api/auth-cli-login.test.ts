import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import { CliLoginStartSchema } from '@adamant/contract'
import { type MiddlewareHandler } from 'hono'

import { createAuthRoute } from '../../server/api/routes/auth.ts'
import {
  createMemoryCliLoginStore,
  type CliLoginStore,
} from '../../server/api/services/cliLogin.ts'
import { oauthStates, sessions } from '../../server/db/client.ts'
import { cliLoginStoreContract } from './cli-login-store-contract.ts'
import {
  captureLogs,
  cliBrowser,
  cookieValue,
  createFakeAuthDb,
  formToken,
  github,
  GITHUB_TOKEN_URL,
  githubProvider,
  sha256,
} from './auth-fakes.ts'

type Start = { loginId: string; pollSecret: string; beginPath: string; userCode: string }

const CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/
const letThrough: MiddlewareHandler = async (_c, next) => {
  await next()
}

function setUp(
  options: {
    cliLogins?: CliLoginStore
    provider?: ReturnType<typeof githubProvider>
    rateLimit?: MiddlewareHandler
  } = {},
) {
  const fake = createFakeAuthDb()
  const provider = options.provider ?? githubProvider()
  const app = createAuthRoute(
    fake.db,
    { github },
    {
      fetch: provider.fetch,
      cliLogins: options.cliLogins ?? createMemoryCliLoginStore(),
      rateLimit: options.rateLimit ?? letThrough,
    },
  )

  const start = async (): Promise<Start> => {
    const response = await app.request('/github/cli/start', { method: 'POST' })
    assert.equal(response.status, 200)
    return (await response.json()) as Start
  }
  const poll = (body: unknown) =>
    app.request('/github/cli/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  const pollFor = (login: Start) => poll({ loginId: login.loginId, pollSecret: login.pollSecret })
  return { fake, app, provider, start, poll, pollFor, browser: cliBrowser(app) }
}

describe('CLI login start', () => {
  it('returns two distinct unguessable values, a code to compare, and nothing secret', async () => {
    const { start } = setUp()
    const login = await start()

    assert.match(login.loginId, /^[\w-]{43}$/)
    assert.match(login.pollSecret, /^[\w-]{43}$/)
    assert.match(login.userCode, CODE_PATTERN)
    assert.notEqual(login.loginId, login.pollSecret)
    assert.equal(CliLoginStartSchema.safeParse(login).success, true)
    // The poll secret never travels in the URL the browser opens.
    assert.equal(login.beginPath.includes(login.pollSecret), false)
    assert.equal(JSON.stringify(login).includes(github.clientSecret), false)
  })

  it('gives each login its own code', async () => {
    const { start } = setUp()
    const codes = await Promise.all(
      Array.from({ length: 10 }, async () => (await start()).userCode),
    )

    for (const code of codes) assert.match(code, CODE_PATTERN)
    assert.ok(new Set(codes).size > 1)
  })

  it('writes no OAuth state until the browser opens the link', async () => {
    const { fake, start } = setUp()
    await start()

    assert.deepEqual(fake.rows(oauthStates), [])
  })

  it('fails closed when GitHub OAuth is not configured', async () => {
    const fake = createFakeAuthDb()
    const app = createAuthRoute(fake.db, {}, { cliLogins: createMemoryCliLoginStore() })

    const response = await app.request('/github/cli/start', { method: 'POST' })

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'OAuth authentication is unavailable' })
  })

  it('refuses new logins past the pending limit instead of growing without bound', async () => {
    const { start, app } = setUp({ cliLogins: createMemoryCliLoginStore(Date.now, 1) })
    await start()

    const refused = await app.request('/github/cli/start', { method: 'POST' })

    assert.equal(refused.status, 503)
    assert.deepEqual(await refused.json(), {
      error: 'Too many sign-ins are in progress. Try again shortly.',
    })
  })
})

describe('CLI login poll', () => {
  it('answers pending until the browser approves', async () => {
    const { start, pollFor } = setUp()
    const response = await pollFor(await start())

    assert.equal(response.status, 202)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { status: 'pending' })
  })

  it('answers a wrong poll secret exactly as it answers an unknown login', async () => {
    const { start, poll, pollFor } = setUp()
    const login = await start()

    const wrongSecret = await poll({ loginId: login.loginId, pollSecret: 'guess' })
    const unknownId = await poll({ loginId: 'no-such-login', pollSecret: 'guess' })

    assert.equal(wrongSecret.status, 404)
    assert.equal(unknownId.status, 404)
    assert.deepEqual(await wrongSecret.json(), await unknownId.json())
    // A wrong guess does not end the real login.
    assert.equal((await pollFor(login)).status, 202)
  })

  it('refuses a malformed poll', async () => {
    const { poll } = setUp()

    for (const body of [
      'not json',
      {},
      { loginId: 'a' },
      { loginId: '', pollSecret: 'b' },
      { loginId: 'a', pollSecret: 'b', extra: true },
      { loginId: 'a'.repeat(201), pollSecret: 'b' },
    ]) {
      assert.equal((await poll(body)).status, 400, JSON.stringify(body))
    }
  })

  it('issues the token once and mints one session, however often the CLI polls', async () => {
    const { fake, start, pollFor, browser } = setUp()
    const login = await start()

    const { decided } = await browser.approve(login.beginPath)
    assert.equal(decided.status, 200)
    assert.match(await decided.text(), /Return to the terminal/)

    const first = await pollFor(login)
    const { token } = (await first.json()) as { token: string }
    const second = await pollFor(login)

    assert.equal(first.status, 200)
    assert.equal(second.status, 404)
    assert.equal(fake.rows(sessions).length, 1)
    assert.equal(fake.rows(sessions)[0]?.tokenHash, sha256(token))
  })

  it('gives the token to exactly one of several racing polls', async () => {
    const { start, pollFor, browser } = setUp()
    const login = await start()

    const early = await Promise.all(Array.from({ length: 5 }, () => pollFor(login)))
    assert.deepEqual(
      early.map((response) => response.status),
      [202, 202, 202, 202, 202],
    )

    await browser.approve(login.beginPath)
    const racing = await Promise.all(Array.from({ length: 8 }, () => pollFor(login)))
    const statuses = racing.map((response) => response.status).sort()
    assert.deepEqual(statuses, [200, 404, 404, 404, 404, 404, 404, 404])
  })

  it('lets the session it issues sign in, and it is not the browser one', async () => {
    const { app, start, pollFor, browser } = setUp()
    const login = await start()
    const { callback, decided } = await browser.approve(login.beginPath)
    const { token } = (await (await pollFor(login)).json()) as { token: string }

    const me = await app.request('/me', { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(me.status, 200)
    assert.equal(cookieValue(callback, 'adamant_session'), undefined)
    assert.equal(cookieValue(decided, 'adamant_session'), undefined)
  })

  it('answers 503 when the database is down, without the poll secret in the log', async (t) => {
    const logs = captureLogs(t)
    const outage = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    })
    const down: CliLoginStore = {
      ...createMemoryCliLoginStore(),
      create: async () => {
        throw outage
      },
      take: async () => {
        throw outage
      },
    }
    const { app, poll } = setUp({ cliLogins: down })

    const started = await app.request('/github/cli/start', { method: 'POST' })
    const polled = await poll({ loginId: 'login', pollSecret: 'poll-secret-value' })

    for (const response of [started, polled]) {
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: 'The database is unavailable' })
    }
    assert.equal(logs().includes('poll-secret-value'), false)
  })
})

describe('CLI login confirmation', () => {
  it('gives no session on GitHub sign-in alone: the browser must confirm the code', async () => {
    const { fake, start, pollFor, browser } = setUp()
    const login = await start()

    const { callback, cookie } = await browser.signIn(login.beginPath)
    const setCookie = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith('adamant_cli_confirm='))

    assert.equal(callback.status, 303)
    assert.equal(callback.headers.get('location'), '/auth/github/cli/confirm')
    assert.match(cookie ?? '', /^[\w-]{43}$/)
    assert.match(setCookie ?? '', /HttpOnly/i)
    assert.match(setCookie ?? '', /Secure/i)
    assert.match(setCookie ?? '', /SameSite=Lax/i)
    assert.match(setCookie ?? '', /Path=\/auth\/github\/cli\/confirm/)
    assert.equal(cookieValue(callback, 'adamant_session'), undefined)
    assert.equal((await pollFor(login)).status, 202)
    assert.equal(fake.rows(sessions).length, 0)
  })

  it("shows the terminal's code on a page that cannot be framed and holds no secret", async () => {
    const { start, browser } = setUp()
    const login = await start()
    const { cookie } = await browser.signIn(login.beginPath)

    const shown = await browser.page(cookie)
    const html = await shown.text()
    const csp = shown.headers.get('content-security-policy') ?? ''

    assert.equal(shown.status, 200)
    assert.match(shown.headers.get('content-type') ?? '', /text\/html/)
    assert.equal(shown.headers.get('x-frame-options'), 'DENY')
    assert.match(csp, /frame-ancestors 'none'/)
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /form-action 'self'/)
    assert.equal(shown.headers.get('cache-control'), 'no-store')
    assert.equal(shown.headers.get('referrer-policy'), 'no-referrer')
    assert.ok(html.includes(login.userCode))
    assert.match(html, /This is the code in my terminal/)
    assert.match(html, /Cancel/)
    assert.match(html, /<form method="post" action="\/auth\/github\/cli\/confirm">/)
    for (const secret of [login.pollSecret, login.loginId, cookie ?? '', github.clientSecret]) {
      assert.equal(html.includes(secret), false)
    }
    assert.match(formToken(html), /^[\w-]{43}$/)
  })

  it('allows its one style block by a hash that matches it, and nothing else', async () => {
    const { start, browser } = setUp()
    const { cookie } = await browser.signIn((await start()).beginPath)
    const shown = await browser.page(cookie)
    const html = await shown.text()

    const styles = [...html.matchAll(/<style>([^<]*)<\/style>/g)].map((match) => match[1] ?? '')
    const allowed = /style-src 'sha256-([^']+)'/.exec(
      shown.headers.get('content-security-policy') ?? '',
    )?.[1]

    assert.equal(styles.length, 1)
    assert.equal(
      allowed,
      createHash('sha256')
        .update(styles[0] ?? '')
        .digest('base64'),
    )
    assert.equal(/<script|\son\w+=|style="/i.test(html), false)
  })

  it('escapes what it renders', async () => {
    const hostile = `<img src=x onerror="alert(1)">'&`
    const { app } = setUp({
      cliLogins: { ...createMemoryCliLoginStore(), awaiting: async () => ({ userCode: hostile }) },
    })

    const html = await (await cliBrowser(app).page('a'.repeat(43))).text()

    assert.equal(html.includes('<img'), false)
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;'))
  })

  it('changes nothing when the page is only viewed', async () => {
    const { start, pollFor, browser } = setUp()
    const login = await start()
    const { cookie } = await browser.signIn(login.beginPath)

    for (let view = 0; view < 3; view += 1) {
      assert.equal((await browser.page(cookie)).status, 200)
    }
    assert.equal((await pollFor(login)).status, 202)
  })

  it('ends the login when the browser cancels, and tells the terminal', async () => {
    const { fake, start, pollFor, browser } = setUp()
    const login = await start()

    const { cookie, html, decided } = await browser.approve(login.beginPath, 'cancel')
    const polled = await pollFor(login)
    const late = await browser.decide(cookie, { token: formToken(html), action: 'confirm' })

    assert.equal(decided.status, 200)
    assert.match(await decided.text(), /Sign-in cancelled/)
    assert.equal(polled.status, 403)
    assert.deepEqual(await polled.json(), {
      error: 'Sign-in was cancelled or failed in the browser.',
    })
    assert.equal(late.status, 400)
    assert.equal(fake.rows(sessions).length, 0)
  })

  it('confirms once: a replayed form post or a reopened link changes nothing', async () => {
    const { fake, app, start, pollFor, browser } = setUp()
    const login = await start()
    const { cookie, html } = await browser.approve(login.beginPath)

    const replay = await browser.decide(cookie, { token: formToken(html), action: 'confirm' })
    const reopened = await app.request(login.beginPath.replace(/^\/auth/, ''))

    assert.equal(replay.status, 400)
    assert.match(await replay.text(), /No sign-in is waiting/)
    assert.equal(reopened.status, 400)
    assert.equal((await pollFor(login)).status, 200)
    assert.equal(fake.rows(sessions).length, 1)
  })

  it('clears the confirmation cookie once the browser has answered', async () => {
    const { start, browser } = setUp()
    const { decided } = await browser.approve((await start()).beginPath)
    const cleared = decided.headers
      .getSetCookie()
      .find((value) => value.startsWith('adamant_cli_confirm='))

    assert.match(cleared ?? '', /Max-Age=0/i)
    assert.match(cleared ?? '', /Path=\/auth\/github\/cli\/confirm/)
  })

  it('refuses a confirmation that did not come from the page, and the login survives', async () => {
    const { start, pollFor, browser } = setUp()
    const login = await start()
    const { cookie } = await browser.signIn(login.beginPath)
    const token = formToken(await (await browser.page(cookie)).text())
    const otherCookie = (await browser.signIn((await start()).beginPath)).cookie

    const forgeries: [string, Promise<Response>][] = [
      ['no cookie', browser.decide(undefined, { token, action: 'confirm' })],
      ['no token', browser.decide(cookie, { action: 'confirm' })],
      ['a guessed token', browser.decide(cookie, { token: 'a'.repeat(43), action: 'confirm' })],
      [
        'the cookie as the token',
        browser.decide(cookie, { token: cookie ?? '', action: 'confirm' }),
      ],
      ["another login's cookie", browser.decide(otherCookie, { token, action: 'confirm' })],
      ['no action', browser.decide(cookie, { token })],
      ['an unknown action', browser.decide(cookie, { token, action: 'approve' })],
      [
        'a cross-site post',
        browser.decide(cookie, { token, action: 'confirm' }, { 'sec-fetch-site': 'cross-site' }),
      ],
      [
        'a same-site post',
        browser.decide(cookie, { token, action: 'confirm' }, { 'sec-fetch-site': 'same-site' }),
      ],
      [
        'a JSON body',
        browser.decide(
          cookie,
          {},
          { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        ),
      ],
    ]
    for (const [name, attempt] of forgeries) {
      const response = await attempt
      assert.equal(response.status, 403, name)
      assert.equal(response.headers.get('x-frame-options'), 'DENY', name)
    }

    assert.equal((await pollFor(login)).status, 202)
    // An older browser that sends no Sec-Fetch-Site still confirms with the real token.
    const real = await browser.decide(cookie, { token, action: 'confirm' })
    assert.equal(real.status, 200)
    assert.equal((await pollFor(login)).status, 200)
  })

  it('answers a browser with no waiting sign-in', async () => {
    const { browser } = setUp()

    for (const cookie of [undefined, 'short', 'a'.repeat(43), `${'a'.repeat(42)};`]) {
      const response = await browser.page(cookie)
      assert.equal(response.status, 400, String(cookie))
      assert.match(await response.text(), /No sign-in is waiting/)
      assert.equal(response.headers.get('x-frame-options'), 'DENY')
    }
  })

  it('cannot be confirmed once the login has expired', async () => {
    let now = Date.now()
    const { start, pollFor, browser } = setUp({ cliLogins: createMemoryCliLoginStore(() => now) })
    const login = await start()
    const { cookie } = await browser.signIn(login.beginPath)
    const html = await (await browser.page(cookie)).text()

    now += 15 * 60 * 1000 + 1
    const shown = await browser.page(cookie)
    const decided = await browser.decide(cookie, { token: formToken(html), action: 'confirm' })

    assert.equal(shown.status, 400)
    assert.equal(decided.status, 400)
    assert.equal((await pollFor(login)).status, 404)
  })
})

describe('CLI login browser link', () => {
  it('sends the browser to GitHub with PKCE and the narrow scope', async () => {
    const { start, browser } = setUp()
    const { begin } = await browser.signIn((await start()).beginPath)
    const location = new URL(begin.headers.get('location') ?? '')

    assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize')
    assert.equal(location.searchParams.get('scope'), 'user:email')
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256')
    assert.match(location.searchParams.get('code_challenge') ?? '', /^[\w-]{43}$/)
    assert.equal(begin.headers.get('referrer-policy'), 'no-referrer')
  })

  it('forgets an expired login: polls are 404 and the browser link is dead', async () => {
    let now = 1_000_000
    const { fake, app, start, pollFor } = setUp({
      cliLogins: createMemoryCliLoginStore(() => now),
    })
    const login = await start()

    now = Date.now() + 15 * 60 * 1000 + 1
    const polled = await pollFor(login)
    const begin = await app.request(login.beginPath.replace(/^\/auth/, ''))

    assert.equal(polled.status, 404)
    assert.equal(begin.status, 400)
    assert.deepEqual(await begin.json(), { error: 'Sign-in expired or unknown.' })
    // The state made for the dead link is spent at once, not left for the sweep.
    assert.deepEqual(fake.rows(oauthStates), [])
  })

  it('refuses to begin an unknown or oversized login id', async () => {
    const { app } = setUp()

    for (const path of [
      '/github/cli/begin',
      '/github/cli/begin?login=',
      '/github/cli/begin?login=unknown',
      `/github/cli/begin?login=${'a'.repeat(201)}`,
    ]) {
      const response = await app.request(path)
      assert.equal(response.status, 400, path)
      assert.equal(response.headers.get('location'), null)
    }
  })

  it('follows the newest visit when the link is opened twice', async () => {
    const { app, start, pollFor, browser } = setUp()
    const login = await start()
    const local = login.beginPath.replace(/^\/auth/, '')
    const stateOf = (response: Response) =>
      new URL(response.headers.get('location') ?? '').searchParams.get('state') ?? ''
    const first = stateOf(await app.request(local))

    const { callback } = await browser.signIn(login.beginPath)
    const stale = await app.request(`/github/callback?code=code&state=${first}`, {
      headers: { Cookie: `adamant_oauth_github_state=${first}` },
    })

    assert.equal(callback.status, 303)
    // The older tab's trip no longer speaks for the terminal; it signs in only itself.
    assert.equal(stale.status, 200)
    assert.ok(cookieValue(stale, 'adamant_session'))
    assert.equal((await pollFor(login)).status, 202)
  })

  it('ends the login at once when the user declines on GitHub', async () => {
    const { start, pollFor, browser } = setUp()
    const login = await start()

    const { callback } = await browser.signIn(login.beginPath, { error: 'access_denied' })

    assert.equal(callback.status, 403)
    assert.equal((await pollFor(login)).status, 403)
  })

  it('ends the login at once when GitHub fails, without leaking the poll secret', async (t) => {
    const logs = captureLogs(t)
    const { start, pollFor, browser } = setUp({
      provider: githubProvider({
        [GITHUB_TOKEN_URL]: () => new Response('', { status: 503 }),
      }),
    })
    const login = await start()

    const { callback } = await browser.signIn(login.beginPath)

    assert.equal(callback.status, 502)
    assert.equal((await pollFor(login)).status, 403)
    assert.equal(logs().includes(login.pollSecret), false)
  })

  it('signs the browser in normally if the CLI gave up before the callback', async () => {
    let now = 1_000_000
    const cliLogins = createMemoryCliLoginStore(() => now)
    const { app, start, pollFor } = setUp({ cliLogins })
    const login = await start()
    const begin = await app.request(login.beginPath.replace(/^\/auth/, ''))
    const state = new URL(begin.headers.get('location') ?? '').searchParams.get('state') ?? ''

    // The OAuth state is still live; only the CLI's wait has run out.
    now = Number.MAX_SAFE_INTEGER
    const response = await app.request(`/github/callback?code=code&state=${state}`, {
      headers: { Cookie: `adamant_oauth_github_state=${state}` },
    })

    assert.equal(response.status, 200)
    assert.ok(cookieValue(response, 'adamant_session'))
    assert.equal((await pollFor(login)).status, 404)
  })
})

describe('CLI login rate limit', () => {
  const from = (address: string) => ({ incoming: { socket: { remoteAddress: address } } })

  it('limits starts and browser links per client address, with the default bucket', async () => {
    const fake = createFakeAuthDb()
    const app = createAuthRoute(
      fake.db,
      { github },
      { fetch: githubProvider().fetch, cliLogins: createMemoryCliLoginStore() },
    )
    const startFrom = (address: string) =>
      app.request('/github/cli/start', { method: 'POST' }, from(address))

    const allowed = []
    for (let attempt = 0; attempt < 20; attempt += 1) {
      allowed.push((await startFrom('203.0.113.7')).status)
    }
    const limited = await startFrom('203.0.113.7')
    const begin = await app.request('/github/cli/begin?login=x', {}, from('203.0.113.7'))
    const neighbour = await startFrom('203.0.113.8')

    assert.deepEqual(new Set(allowed), new Set([200]))
    assert.equal(limited.status, 429)
    assert.ok(Number(limited.headers.get('retry-after')) >= 1)
    assert.deepEqual(await limited.json(), {
      error: 'Too many sign-in attempts. Try again shortly.',
    })
    assert.equal(begin.status, 429)
    assert.equal(neighbour.status, 200)
  })

  it('does not limit the poll or the confirmation page', async () => {
    const { app, poll, browser } = setUp({
      rateLimit: async (c) => c.json({ error: 'limited' }, 429),
    })

    assert.equal((await app.request('/github/cli/start', { method: 'POST' })).status, 429)
    assert.equal((await app.request('/github/cli/begin?login=x')).status, 429)
    assert.equal((await poll({ loginId: 'a', pollSecret: 'b' })).status, 404)
    assert.equal((await browser.page()).status, 400)
    assert.equal((await browser.decide(undefined, {})).status, 403)
  })
})

describe('CLI login memory store', () => {
  cliLoginStoreContract(async () => {
    let offset = 0
    const now = () => Date.now() + offset
    let users = 0
    return {
      store: createMemoryCliLoginStore(now),
      now,
      user: async () => `user-${(users += 1)}`,
      expire: async () => {
        offset += 15 * 60 * 1000 + 1
      },
    }
  })

  it('makes room again once old logins expire', async () => {
    let now = 1_000
    const store = createMemoryCliLoginStore(() => now, 1)
    const login = (loginId: string) => ({
      loginId,
      pollSecret: 's',
      userCode: 'BBBB-BBBB',
      expiresAt: new Date(2_000),
    })

    assert.equal(await store.create(login('a')), true)
    assert.equal(await store.create(login('b')), false)
    now = 2_000
    assert.equal(await store.create({ ...login('b'), expiresAt: new Date(3_000) }), true)
  })
})
