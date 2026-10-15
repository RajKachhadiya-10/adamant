import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Hono } from 'hono'

import { createAuthMiddleware, type AuthVariables } from '../../server/api/middleware/auth.ts'
import { createAuthRoute } from '../../server/api/routes/auth.ts'
import { createMemoryCliLoginStore } from '../../server/api/services/cliLogin.ts'
import { createRunsRoute } from '../../server/api/routes/runs.ts'
import {
  authenticateSession,
  consumeOAuthState,
  createSession,
  upsertOAuthIdentity,
  type AuthenticatedSession,
} from '../../server/api/services/authService.ts'
import { type RunApiStore } from '../../server/api/services/runStore.ts'
import { sessions, users, type Db } from '../../server/db/client.ts'
import {
  captureLogs,
  cliBrowser,
  cookieValue,
  createFakeAuthDb,
  github,
  githubProvider,
  sha256,
} from './auth-fakes.ts'

describe('session authentication', () => {
  it('accepts bearer tokens and exposes the authenticated context', async () => {
    let authenticatedUserId: string | undefined
    const store = {
      create: async () => {
        throw new Error('not used')
      },
      list: async (userId) => {
        authenticatedUserId = userId
        return []
      },
      detail: async () => null,
    } satisfies RunApiStore
    const app = createRunsRoute(
      store,
      createAuthMiddleware({
        authenticate: async (token) =>
          token === 'valid'
            ? {
                sessionId: 'session-1',
                userId: 'user-1',
              }
            : null,
      }),
    )

    assert.equal((await app.request('/')).status, 401)
    assert.equal(
      (
        await app.request('/', {
          headers: { Authorization: 'Basic valid' },
        })
      ).status,
      401,
    )

    const response = await app.request('/', {
      headers: { Authorization: 'Bearer valid' },
    })
    assert.equal(response.status, 200)
    assert.equal(authenticatedUserId, 'user-1')
  })

  it('accepts the HttpOnly browser-session cookie', async () => {
    let authenticatedToken: string | undefined
    const store = {
      create: async () => {
        throw new Error('not used')
      },
      list: async () => [],
      detail: async () => null,
    } satisfies RunApiStore
    const app = createRunsRoute(
      store,
      createAuthMiddleware({
        authenticate: async (token) => {
          authenticatedToken = token
          return { sessionId: 'session-1', userId: 'user-1' }
        },
      }),
    )

    const response = await app.request('/', {
      headers: { Cookie: 'adamant_session=cookie-token' },
    })

    assert.equal(response.status, 200)
    assert.equal(authenticatedToken, 'cookie-token')
  })

  it('refuses a token when no session store is configured', async () => {
    const store = {
      create: async () => {
        throw new Error('not used')
      },
      list: async () => [],
      detail: async () => null,
    } satisfies RunApiStore
    const app = createRunsRoute(store, createAuthMiddleware())

    const response = await app.request('/', { headers: { ADAMANT_SESSION: 'seed-token' } })
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'Server misconfiguration' })
  })

  it('ignores a session token in the query string', async () => {
    let authenticateCalls = 0
    const store = {
      create: async () => {
        throw new Error('not used')
      },
      list: async () => [],
      detail: async () => null,
    } satisfies RunApiStore
    const app = createRunsRoute(
      store,
      createAuthMiddleware({
        authenticate: async () => {
          authenticateCalls += 1
          return { sessionId: 'session-1', userId: 'user-1' }
        },
      }),
    )

    const response = await app.request('/?session=valid')

    assert.equal(response.status, 401)
    assert.equal(authenticateCalls, 0)
  })
})

describe('OAuth persistence', () => {
  it('consumes state with one delete and returns its PKCE verifier', async () => {
    let deleteCalls = 0
    let rows: { codeVerifier: string | null }[] = [{ codeVerifier: 'verifier' }]
    const database = {
      delete: () => {
        deleteCalls += 1
        return {
          where: () => ({
            returning: async () => rows,
          }),
        }
      },
    } as unknown as Db

    assert.deepEqual(await consumeOAuthState(database, 'github', 'state'), {
      codeVerifier: 'verifier',
    })
    rows = []
    assert.equal(await consumeOAuthState(database, 'github', 'state'), undefined)
    // A state from before PKCE is spent but cannot be exchanged.
    rows = [{ codeVerifier: null }]
    assert.equal(await consumeOAuthState(database, 'github', 'state'), undefined)
    assert.equal(deleteCalls, 3)
  })

  it('removes a newly created user when another callback wins the identity race', async () => {
    let insertCalls = 0
    let deletedUserId: string | undefined
    const transaction = {
      insert: () => {
        insertCalls += 1
        return {
          values: () => ({
            onConflictDoNothing: () => ({
              returning: async () => (insertCalls === 1 ? [{ id: 'created-user' }] : []),
            }),
          }),
        }
      },
      delete: () => ({
        where: (condition: unknown) => {
          assert.ok(condition)
          deletedUserId = 'created-user'
          return Promise.resolve()
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ userId: 'winning-user' }],
          }),
        }),
      }),
    }
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      transaction: async (callback: (tx: typeof transaction) => Promise<{ userId: string }>) =>
        callback(transaction),
    } as unknown as Db

    const result = await upsertOAuthIdentity(database, {
      provider: 'github',
      providerUserId: 'provider-user',
      username: 'octocat',
    })

    assert.deepEqual(result, { userId: 'winning-user' })
    assert.equal(deletedUserId, 'created-user')
  })
})

describe('OAuth routes', () => {
  it('does not expose missing configuration details', async () => {
    const app = createAuthRoute({} as Db, {})
    const response = await app.request('/github')

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: 'OAuth authentication is unavailable',
    })
  })

  it('binds the authorization state to the initiating browser', async () => {
    let storedState: string | undefined
    const database = {
      insert: () => ({
        values: async (value: { state: string }) => {
          storedState = value.state
        },
      }),
    } as unknown as Db
    const app = createAuthRoute(database, {
      github: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'http://localhost/callback',
      },
    })

    const response = await app.request('/github')
    const location = new URL(response.headers.get('location') ?? '')
    const state = location.searchParams.get('state')
    const cookie = response.headers.get('set-cookie')

    assert.equal(response.status, 302)
    assert.equal(state, storedState)
    assert.match(cookie ?? '', new RegExp(`adamant_oauth_github_state=${state}`))
    assert.match(cookie ?? '', /HttpOnly/i)
    assert.match(cookie ?? '', /Secure/i)
    assert.match(cookie ?? '', /SameSite=Lax/i)
    assert.match(cookie ?? '', /Path=\/auth\/github\/callback/i)
  })

  it('rejects callbacks not bound to the initiating browser before consuming state', async () => {
    let stateConsumptionAttempts = 0
    let providerRequests = 0
    const database = {
      delete: () => {
        stateConsumptionAttempts += 1
        return {
          where: () => ({
            returning: async () => [{ id: 'state-1' }],
          }),
        }
      },
    } as unknown as Db
    const app = createAuthRoute(
      database,
      {
        github: {
          clientId: 'client',
          clientSecret: 'secret',
          redirectUri: 'http://localhost/callback',
        },
      },
      {
        fetch: async () => {
          providerRequests += 1
          return Response.json({ access_token: 'provider-token' })
        },
      },
    )

    const missingCookie = await app.request('/github/callback?code=code&state=state')
    const mismatchedCookie = await app.request('/github/callback?code=code&state=state', {
      headers: { Cookie: 'adamant_oauth_github_state=another-state' },
    })

    assert.equal(missingCookie.status, 400)
    assert.equal(mismatchedCookie.status, 400)
    assert.equal(stateConsumptionAttempts, 0)
    assert.equal(providerRequests, 0)
  })

  it('bounds provider requests and hides callback failures', async () => {
    const database = {
      delete: () => ({
        where: () => ({
          returning: async () => [{ codeVerifier: 'verifier' }],
        }),
      }),
    } as unknown as Db
    let requestSignal: AbortSignal | null | undefined
    const app = createAuthRoute(
      database,
      {
        github: {
          clientId: 'client',
          clientSecret: 'secret',
          redirectUri: 'http://localhost/callback',
        },
      },
      {
        fetch: async (_input, init) => {
          requestSignal = init?.signal
          throw new Error('provider secret detail')
        },
        cliLogins: createMemoryCliLoginStore(),
      },
    )

    const response = await app.request('/github/callback?code=code&state=state', {
      headers: { Cookie: 'adamant_oauth_github_state=state' },
    })
    assert.ok(requestSignal instanceof AbortSignal)
    // The provider is upstream: its failure is a bad gateway, not this server's bug.
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), {
      error: 'OAuth authentication failed',
    })
  })

  it('hands the session to browsers only through a non-cacheable HttpOnly cookie', async () => {
    const database = {
      delete: () => ({
        where: () => ({
          returning: async () => [{ codeVerifier: 'verifier' }],
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ userId: 'user-1' }],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {},
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: async () => [{ id: 'session-1' }],
        }),
      }),
    } as unknown as Db
    const providerResponses = [
      Response.json({ access_token: 'provider-token' }),
      Response.json({ id: 123, login: 'octocat' }),
      Response.json([]),
    ]
    const app = createAuthRoute(
      database,
      {
        github: {
          clientId: 'client',
          clientSecret: 'secret',
          redirectUri: 'http://localhost/callback',
        },
      },
      {
        fetch: async () => {
          const response = providerResponses.shift()
          if (!response) throw new Error('unexpected provider request')
          return response
        },
        cliLogins: createMemoryCliLoginStore(),
      },
    )

    const response = await app.request('/github/callback?code=code&state=state', {
      headers: { Cookie: 'adamant_oauth_github_state=state' },
    })
    const cookie = response.headers.get('set-cookie')
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(JSON.parse(body), { authenticated: true })
    assert.match(cookie ?? '', /adamant_session=/)
    assert.match(cookie ?? '', /HttpOnly/i)
    assert.match(cookie ?? '', /Secure/i)
    assert.match(cookie ?? '', /SameSite=Lax/i)
    assert.doesNotMatch(body, /provider-token/)
  })
})

describe('CLI GitHub login', () => {
  it('fails closed when GitHub OAuth is not configured', async () => {
    const app = createAuthRoute({} as Db, {})
    const response = await app.request('/github/cli/start', { method: 'POST' })

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'OAuth authentication is unavailable' })
  })

  it('keeps the login in Postgres unless told otherwise', async () => {
    const fake = createFakeAuthDb()
    let inserted: Record<string, unknown> | undefined
    const database = {
      ...fake.db,
      insert: () => ({
        values: async (value: Record<string, unknown>) => {
          inserted = value
        },
      }),
    } as unknown as Db
    const app = createAuthRoute(database, { github })

    const started = await app.request('/github/cli/start', { method: 'POST' })
    const body = (await started.json()) as { loginId: string; pollSecret: string }

    assert.equal(started.status, 200)
    // Hashes only: neither value that carries authority is written as is.
    assert.equal(inserted?.loginIdHash, sha256(body.loginId))
    assert.equal(inserted?.pollSecretHash, sha256(body.pollSecret))
    assert.equal(JSON.stringify(inserted).includes(body.loginId), false)
    assert.equal(JSON.stringify(inserted).includes(body.pollSecret), false)
  })

  it('returns the session token once to the CLI, after the browser confirms, and never to a page', async () => {
    const fake = createFakeAuthDb()
    const provider = githubProvider()
    const app = createAuthRoute(
      fake.db,
      { github },
      { fetch: provider.fetch, cliLogins: createMemoryCliLoginStore() },
    )
    const poll = (pollSecret: string) =>
      app.request('/github/cli/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loginId: startBody.loginId, pollSecret }),
      })

    const started = await app.request('/github/cli/start', { method: 'POST' })
    assert.equal(started.status, 200)
    const startBody = (await started.json()) as {
      loginId: string
      pollSecret: string
      beginPath: string
      userCode: string
    }
    assert.match(startBody.beginPath, /^\/auth\/github\/cli\/begin\?login=[A-Za-z0-9_-]+$/)
    assert.equal(JSON.stringify(startBody).includes(github.clientSecret), false)

    assert.equal((await poll('wrong-secret')).status, 404)
    assert.equal((await poll(startBody.pollSecret)).status, 202)

    const { begin, callback, html, decided } = await cliBrowser(app).approve(startBody.beginPath)
    const location = new URL(begin.headers.get('location') ?? '')
    const pages = [html, await callback.text(), await decided.text()].join('\n')

    assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize')
    assert.equal(location.searchParams.get('client_id'), github.clientId)
    assert.equal(location.searchParams.has('client_secret'), false)
    assert.ok(html.includes(startBody.userCode))
    assert.match(decided.headers.get('content-type') ?? '', /text\/html/)
    assert.equal(decided.headers.get('cache-control'), 'no-store')
    // The terminal's session is not copied into the browser's cookie jar.
    for (const response of [callback, decided]) {
      assert.equal(cookieValue(response, 'adamant_session'), undefined)
    }

    const ready = await poll(startBody.pollSecret)
    assert.equal(ready.status, 200)
    const { token: sessionToken } = (await ready.json()) as { token: string }
    assert.equal(fake.rows(sessions)[0]?.tokenHash, sha256(sessionToken))
    assert.equal(pages.includes(sessionToken), false)
    assert.equal(pages.includes(startBody.pollSecret), false)
    assert.equal(pages.includes(github.clientSecret), false)

    assert.equal((await poll(startBody.pollSecret)).status, 404)
  })
})

/** A route behind the middleware that reports who it let in, and every token it was asked about. */
function guarded(lookup: Record<string, AuthenticatedSession | null> = {}) {
  const asked: string[] = []
  const app = new Hono<{ Variables: AuthVariables }>()
  app.use(
    '*',
    createAuthMiddleware({
      authenticate: async (token) => {
        asked.push(token)
        return lookup[token] ?? null
      },
    }),
  )
  app.get('/', (c) => c.json({ userId: c.get('userId'), sessionId: c.get('sessionId') }))
  return { app, asked }
}

const alice = { sessionId: 'session-alice', userId: 'user-alice' }
const bob = { sessionId: 'session-bob', userId: 'user-bob' }

describe('session credentials', () => {
  it('refuses a request with no credential without looking anything up', async () => {
    const { app, asked } = guarded({ valid: alice })
    const response = await app.request('/')

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Unauthorized' })
    assert.deepEqual(asked, [])
  })

  for (const header of ['Bearer', 'Bearer ', 'Bearer    ', 'bearer\t']) {
    it(`refuses ${JSON.stringify(header)} and does not fall back to the cookie`, async () => {
      const { app, asked } = guarded({ valid: alice })
      const response = await app.request('/', {
        headers: { Authorization: header, Cookie: 'adamant_session=valid' },
      })

      assert.equal(response.status, 401)
      assert.deepEqual(asked, [])
    })
  }

  it('accepts the Bearer scheme in any case and with extra spaces', async () => {
    const { app } = guarded({ valid: alice })

    for (const header of ['Bearer valid', 'bearer valid', 'BEARER valid', 'Bearer     valid']) {
      const response = await app.request('/', { headers: { Authorization: header } })
      assert.equal(response.status, 200, header)
      assert.deepEqual(await response.json(), alice)
    }
  })

  it('ignores schemes it does not issue, so the cookie still applies', async () => {
    const { app, asked } = guarded({ valid: alice })

    for (const header of ['Basic dmFsaWQ6', 'Token valid', 'Bearervalid']) {
      assert.equal((await app.request('/', { headers: { Authorization: header } })).status, 401)
    }
    const withCookie = await app.request('/', {
      headers: { Authorization: 'Basic dmFsaWQ6', Cookie: 'adamant_session=valid' },
    })
    assert.equal(withCookie.status, 200)
    assert.deepEqual(asked, ['valid'])
  })

  it('refuses a token with spaces, odd characters or no end before any lookup', async () => {
    const { app, asked } = guarded({ valid: alice })
    const tokens = ['valid extra', 'val\u00efd', 'a.b', 'x'.repeat(513), 'x'.repeat(100_000)]

    for (const token of tokens) {
      const response = await app.request('/', { headers: { Authorization: `Bearer ${token}` } })
      assert.equal(response.status, 401)
    }
    assert.equal((await app.request('/', { headers: { ADAMANT_SESSION: 'a b' } })).status, 401)
    assert.deepEqual(asked, [])
  })

  it('lets an explicit header win over the cookie, and never falls back when it is wrong', async () => {
    const { app } = guarded({ alice: alice, bob: bob })

    const headerWins = await app.request('/', {
      headers: { Authorization: 'Bearer bob', Cookie: 'adamant_session=alice' },
    })
    assert.deepEqual(await headerWins.json(), bob)

    // A stolen-cookie browser that also sends a wrong token gets nothing.
    const wrongHeader = await app.request('/', {
      headers: { Authorization: 'Bearer unknown', Cookie: 'adamant_session=alice' },
    })
    assert.equal(wrongHeader.status, 401)

    const sessionHeaderWins = await app.request('/', {
      headers: { ADAMANT_SESSION: 'alice', Authorization: 'Bearer bob' },
    })
    assert.deepEqual(await sessionHeaderWins.json(), alice)
  })

  it('treats an empty ADAMANT_SESSION as absent rather than masking the Bearer token', async () => {
    const { app } = guarded({ valid: alice })
    const response = await app.request('/', {
      headers: { ADAMANT_SESSION: '', Authorization: 'Bearer valid' },
    })

    assert.equal(response.status, 200)
  })

  it('refuses a token whose session lookup finds nothing (expired, revoked or user gone)', async () => {
    const { app, asked } = guarded({ valid: alice })
    const response = await app.request('/', { headers: { Authorization: 'Bearer stale' } })

    assert.equal(response.status, 401)
    assert.deepEqual(asked, ['stale'])
  })

  it('answers 503 when the database is down, not "Server misconfiguration"', async (t) => {
    const logs = captureLogs(t)
    const app = new Hono()
    const outages = [
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
      new Error('Failed query', { cause: new Error('Connection terminated unexpectedly') }),
      new Error('Failed query', {
        cause: Object.assign(new Error('the database system is starting up'), { code: '57P03' }),
      }),
      new AggregateError([Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })]),
    ]
    app.use(
      '*',
      createAuthMiddleware({
        authenticate: async () => {
          throw outages.shift()
        },
      }),
    )
    app.get('/', (c) => c.text('ok'))

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await app.request('/', { headers: { Authorization: 'Bearer tok_value' } })
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: 'The database is unavailable' })
    }
    assert.equal(logs().includes('tok_value'), false)
  })

  it('answers 500 when the lookup fails, without the token in the body or the log', async (t) => {
    const logs = captureLogs(t)
    const token = 'tok_secret-value-123'
    const app = new Hono()
    app.use(
      '*',
      createAuthMiddleware({
        authenticate: async () => {
          throw new Error('connection refused')
        },
      }),
    )
    app.get('/', (c) => c.text('ok'))

    const response = await app.request('/', { headers: { Authorization: `Bearer ${token}` } })
    const body = await response.text()

    assert.equal(response.status, 500)
    assert.equal(body.includes(token), false)
    assert.equal(logs().includes(token), false)
  })

  it('does not report a failing route as an authentication failure', async (t) => {
    const logs = captureLogs(t)
    const app = new Hono()
    app.use('*', createAuthMiddleware({ authenticate: async () => alice }))
    app.get('/', () => {
      throw new Error('route failed')
    })

    const response = await app.request('/', { headers: { Authorization: 'Bearer valid' } })

    assert.equal(response.status, 500)
    assert.doesNotMatch(logs(), /Failed to authenticate session/)
  })
})

describe('session tokens', () => {
  it('stores only the SHA-256 of a fresh random token', async () => {
    const fake = createFakeAuthDb()
    const first = await createSession(fake.db, 'user-1')
    const second = await createSession(fake.db, 'user-1')
    const stored = fake.rows(sessions)

    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/)
    assert.notEqual(first.token, second.token)
    assert.deepEqual(
      stored.map((row) => row.tokenHash),
      [sha256(first.token), sha256(second.token)],
    )
    for (const row of stored) {
      assert.equal(Object.values(row).includes(first.token), false)
      assert.equal(Object.values(row).includes(second.token), false)
    }
    // Thirty days, like the cookie.
    const days = (first.expiresAt.getTime() - Date.now()) / 86_400_000
    assert.ok(days > 29.9 && days <= 30)
  })

  it('finds a session by the hash of the presented token only', async () => {
    const fake = createFakeAuthDb()
    const { token, sessionId } = await createSession(fake.db, 'user-1')

    assert.deepEqual(await authenticateSession(fake.db, token), { sessionId, userId: 'user-1' })
    assert.equal(await authenticateSession(fake.db, sha256(token)), null)
    assert.equal(await authenticateSession(fake.db, `${token}x`), null)
  })

  it('treats the expiry instant as expired and a revoked session as gone', async (t) => {
    const fake = createFakeAuthDb()
    const expiring = await createSession(fake.db, 'user-1')
    const revoked = await createSession(fake.db, 'user-1')
    const [expiringRow, revokedRow] = fake.rows(sessions)
    assert.ok(expiringRow && revokedRow)
    revokedRow.revokedAt = new Date()

    t.mock.timers.enable({ apis: ['Date'], now: expiring.expiresAt.getTime() - 1 })
    assert.ok(await authenticateSession(fake.db, expiring.token))
    t.mock.timers.setTime(expiring.expiresAt.getTime())
    assert.equal(await authenticateSession(fake.db, expiring.token), null)

    assert.equal(await authenticateSession(fake.db, revoked.token), null)
  })

  it('records last use at most every five minutes', async (t) => {
    const fake = createFakeAuthDb()
    const { token } = await createSession(fake.db, 'user-1')
    const row = fake.rows(sessions)[0]
    assert.ok(row)

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    await authenticateSession(fake.db, token)
    const first = row.lastUsedAt
    assert.ok(first instanceof Date)

    t.mock.timers.tick(60_000)
    await authenticateSession(fake.db, token)
    assert.equal(row.lastUsedAt, first)

    t.mock.timers.tick(5 * 60_000)
    await authenticateSession(fake.db, token)
    assert.notEqual(row.lastUsedAt, first)
  })
})

describe('logout', () => {
  async function signedIn() {
    const fake = createFakeAuthDb()
    const user = fake.add(users, { username: 'github_octocat' })
    const mine = await createSession(fake.db, String(user.id))
    const other = await createSession(fake.db, String(user.id))
    const app = createAuthRoute(fake.db, { github })
    const me = (token: string) =>
      app.request('/me', { headers: { Authorization: `Bearer ${token}` } })
    return { fake, app, mine, other, me }
  }

  it("revokes only the presented session; the same user's other session stays", async () => {
    const { app, mine, other, me } = await signedIn()

    const response = await app.request('/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mine.token}` },
    })

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await me(mine.token)).status, 401)
    assert.equal((await me(other.token)).status, 200)
  })

  it('is idempotent, so a client holding a dead token can still sign out', async () => {
    const { fake, app, mine } = await signedIn()
    const logout = () =>
      app.request('/logout', { method: 'POST', headers: { Authorization: `Bearer ${mine.token}` } })

    assert.equal((await logout()).status, 200)
    const revokedAt = fake.rows(sessions)[0]?.revokedAt
    assert.ok(revokedAt instanceof Date)

    const again = await logout()
    assert.equal(again.status, 200)
    assert.deepEqual(await again.json(), { message: 'Logged out successfully' })
    // The first revocation time is kept.
    assert.equal(fake.rows(sessions)[0]?.revokedAt, revokedAt)

    assert.equal((await app.request('/logout', { method: 'POST' })).status, 200)
    const garbage = await app.request('/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer not a token' },
    })
    assert.equal(garbage.status, 200)
  })

  it('clears the browser cookie only for a request that carried it', async () => {
    const { app, mine, me } = await signedIn()

    const bearer = await app.request('/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mine.token}` },
    })
    assert.equal(cookieValue(bearer, 'adamant_session'), undefined)

    const browser = await app.request('/logout', {
      method: 'POST',
      headers: { Cookie: `adamant_session=${mine.token}` },
    })
    const cleared = browser.headers.getSetCookie().find((c) => c.startsWith('adamant_session='))
    assert.match(cleared ?? '', /Max-Age=0/i)
    assert.match(cleared ?? '', /Path=\//)
    assert.equal((await me(mine.token)).status, 401)
  })

  it('answers 500 if the revocation cannot be written, without the token in the log', async (t) => {
    const logs = captureLogs(t)
    const { fake, app, mine } = await signedIn()
    Object.assign(fake.db, {
      update: () => {
        throw new Error('database is down')
      },
    })

    const response = await app.request('/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mine.token}` },
    })

    assert.equal(response.status, 500)
    assert.equal((await response.text()).includes(mine.token), false)
    assert.equal(logs().includes(mine.token), false)
  })
})

describe('GET /auth/me', () => {
  it('shows a GitHub user with no email as having none, and never the token', async () => {
    const fake = createFakeAuthDb()
    const user = fake.add(users, { username: 'github_octocat' })
    const { token } = await createSession(fake.db, String(user.id))
    const app = createAuthRoute(fake.db, { github })

    const response = await app.request('/me', { headers: { Authorization: `Bearer ${token}` } })
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(JSON.parse(body), {
      user: { id: user.id, username: 'github_octocat', email: null, providers: [] },
    })
    assert.equal(body.includes(token), false)
  })

  it('answers 401 for a session whose user is gone, so the client signs in again', async () => {
    const fake = createFakeAuthDb()
    const { token } = await createSession(fake.db, 'deleted-user')
    const app = createAuthRoute(fake.db, { github })

    const response = await app.request('/me', { headers: { Authorization: `Bearer ${token}` } })

    assert.equal(response.status, 401)
  })

  it('needs a session', async () => {
    const app = createAuthRoute(createFakeAuthDb().db, { github })
    assert.equal((await app.request('/me')).status, 401)
  })
})
