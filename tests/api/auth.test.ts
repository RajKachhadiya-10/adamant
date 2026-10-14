import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAuthMiddleware } from '../../server/api/middleware/auth.ts'
import { createAuthRoute } from '../../server/api/routes/auth.ts'
import { createCliLoginStore } from '../../server/api/services/cliLogin.ts'
import { createRunsRoute } from '../../server/api/routes/runs.ts'
import { consumeOAuthState, upsertOAuthIdentity } from '../../server/api/services/authService.ts'
import { type RunApiStore } from '../../server/api/services/runStore.ts'
import { type Db } from '../../server/db/client.ts'

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
  it('consumes state with one delete and returns whether a row was removed', async () => {
    let deleteCalls = 0
    const database = {
      delete: () => {
        deleteCalls += 1
        return {
          where: () => ({
            returning: async () => [{ id: 'state-1' }],
          }),
        }
      },
    } as unknown as Db

    assert.equal(await consumeOAuthState(database, 'github', 'state'), true)
    assert.equal(deleteCalls, 1)
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
          returning: async () => [{ id: 'state-1' }],
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
      },
    )

    const response = await app.request('/github/callback?code=code&state=state', {
      headers: { Cookie: 'adamant_oauth_github_state=state' },
    })
    assert.ok(requestSignal instanceof AbortSignal)
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), {
      error: 'OAuth authentication failed',
    })
  })

  it('hands the session to browsers only through a non-cacheable HttpOnly cookie', async () => {
    const database = {
      delete: () => ({
        where: () => ({
          returning: async () => [{ id: 'state-1' }],
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
  const github = {
    clientId: 'client',
    clientSecret: 'super-secret-value',
    redirectUri: 'http://localhost/callback',
  }

  it('fails closed when GitHub OAuth is not configured', async () => {
    const app = createAuthRoute({} as Db, {})
    const response = await app.request('/github/cli/start', { method: 'POST' })

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'OAuth authentication is unavailable' })
  })

  it('keeps the Adamant session in memory until the CLI reads it once', () => {
    const store = createCliLoginStore(() => 1_000)
    store.put({ loginId: 'lid', pollSecret: 'secret', state: 'state', expiresAt: 2_000 })

    assert.deepEqual(store.take('lid', 'other'), { status: 'missing' })
    assert.deepEqual(store.take('lid', 'secret'), { status: 'pending' })
    assert.equal(store.complete('state', 'session-token'), true)
    assert.deepEqual(store.take('lid', 'secret'), { status: 'ready', token: 'session-token' })
    assert.deepEqual(store.take('lid', 'secret'), { status: 'missing' })

    const expired = createCliLoginStore(() => 5_000)
    expired.put({ loginId: 'lid', pollSecret: 'secret', state: 'state', expiresAt: 4_000 })
    assert.equal(expired.begin('lid'), undefined)
  })

  it('returns the session token once to the CLI and not in the browser page', async () => {
    let storedState: string | undefined
    const database = {
      insert: () => ({
        values: (value: { state?: string }) => {
          if (value.state) storedState = value.state
          return { returning: async () => [{ id: 'session-1' }] }
        },
      }),
      delete: () => ({
        where: () => ({
          returning: async () => [{ id: 'state-1' }],
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
    } as unknown as Db
    const providerResponses = [
      Response.json({ access_token: 'provider-token' }),
      Response.json({ id: 123, login: 'octocat' }),
      Response.json([]),
    ]
    const app = createAuthRoute(
      database,
      { github },
      {
        fetch: async () => {
          const response = providerResponses.shift()
          if (!response) throw new Error('unexpected provider request')
          return response
        },
      },
    )

    const started = await app.request('/github/cli/start', { method: 'POST' })
    assert.equal(started.status, 200)
    const startBody = (await started.json()) as {
      loginId: string
      pollSecret: string
      beginPath: string
    }
    assert.match(startBody.beginPath, /^\/auth\/github\/cli\/begin\?login=[A-Za-z0-9_-]+$/)
    assert.equal(JSON.stringify(startBody).includes('super-secret-value'), false)
    assert.equal(JSON.stringify(startBody).includes('provider-token'), false)

    const pending = await app.request('/github/cli/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginId: startBody.loginId, pollSecret: 'wrong-secret' }),
    })
    assert.equal(pending.status, 404)

    const waiting = await app.request('/github/cli/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginId: startBody.loginId, pollSecret: startBody.pollSecret }),
    })
    assert.equal(waiting.status, 202)

    // This app is the /auth router. The CLI opens beginPath on the full API.
    const begin = await app.request(startBody.beginPath.replace(/^\/auth/, ''))
    assert.equal(begin.status, 302)
    const location = new URL(begin.headers.get('location') ?? '')
    const state = location.searchParams.get('state')
    const stateCookie = begin.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('adamant_oauth_github_state='))

    assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize')
    assert.equal(state, storedState)
    assert.equal(location.searchParams.get('client_id'), 'client')
    assert.equal(location.searchParams.has('client_secret'), false)
    assert.match(stateCookie ?? '', /HttpOnly/i)

    const callback = await app.request(`/github/callback?code=code&state=${state ?? ''}`, {
      headers: { Cookie: stateCookie?.split(';')[0] ?? '' },
    })
    const html = await callback.text()
    const sessionCookie = callback.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('adamant_session='))
    const sessionToken = sessionCookie?.match(/^adamant_session=([^;]+)/)?.[1]

    assert.equal(callback.status, 200)
    assert.match(callback.headers.get('content-type') ?? '', /text\/html/)
    assert.match(html, /Return to the terminal/)
    assert.equal(html.includes('provider-token'), false)
    assert.equal(html.includes('super-secret-value'), false)
    assert.ok(sessionToken)
    assert.equal(html.includes(sessionToken), false)

    const ready = await app.request('/github/cli/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginId: startBody.loginId, pollSecret: startBody.pollSecret }),
    })
    assert.equal(ready.status, 200)
    assert.deepEqual(await ready.json(), { token: sessionToken })

    const again = await app.request('/github/cli/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginId: startBody.loginId, pollSecret: startBody.pollSecret }),
    })
    assert.equal(again.status, 404)
  })
})
