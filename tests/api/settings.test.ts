import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAuthMiddleware } from '../../server/api/middleware/auth.ts'
import { createSettingsRoute } from '../../server/api/routes/settings.ts'
import { createGithubInstallRoute } from '../../server/api/routes/githubInstall.ts'
import { throttle } from '../../server/api/services/jobs.ts'
import { createMemorySettingsStore } from '../../server/api/services/settingsStore.ts'
import { createServerApp } from '../../server/api/server.ts'

const session = 'secret'
const userId = '00000000-0000-0000-0000-000000000001'
const authed = { Authorization: `Bearer ${session}` }
const auth = createAuthMiddleware({
  authenticate: async (token) => (token === session ? { sessionId: 's', userId } : null),
})

const put = (body: unknown) => ({
  method: 'PUT',
  headers: { ...authed, 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

describe('settings route', () => {
  it('needs a session', async () => {
    const app = createSettingsRoute(createMemorySettingsStore(), auth)
    assert.equal((await app.request('/')).status, 401)
    assert.equal(
      (await app.request('/', { ...put({ autoMerge: false }), headers: {} })).status,
      401,
    )
  })

  it('defaults to auto and saves the mode for the session user', async () => {
    const store = createMemorySettingsStore()
    const app = createSettingsRoute(store, auth)
    assert.deepEqual(await (await app.request('/', { headers: authed })).json(), {
      autoMerge: true,
    })
    const saved = await app.request('/', put({ autoMerge: false }))
    assert.equal(saved.status, 200)
    assert.deepEqual(await saved.json(), { autoMerge: false })
    assert.deepEqual(store.saved.get(userId), { autoMerge: false })
    assert.deepEqual(await (await app.request('/', { headers: authed })).json(), {
      autoMerge: false,
    })
  })

  it('rejects anything but a boolean autoMerge', async () => {
    const store = createMemorySettingsStore()
    const app = createSettingsRoute(store, auth)
    for (const body of [
      {},
      { autoMerge: 'no' },
      { autoMerge: 0 },
      { autoMerge: true, extra: 1 },
      '[',
      null,
    ]) {
      const response = await app.request('/', put(body))
      assert.equal(response.status, 400, JSON.stringify(body))
    }
    assert.equal(store.saved.size, 0)
  })

  it('answers 404 when the session user is gone', async () => {
    const app = createSettingsRoute({ read: async () => null, write: async () => null }, auth)
    assert.equal((await app.request('/', { headers: authed })).status, 404)
    assert.equal((await app.request('/', put({ autoMerge: true }))).status, 404)
  })

  it('is 503 without Postgres, behind the session check', async () => {
    const app = createServerApp(undefined, {
      authenticate: async (token) => (token === session ? { sessionId: 's', userId } : null),
    })
    assert.equal((await app.request('/settings', put({ autoMerge: true }))).status, 503)
    assert.equal((await app.request('/settings', { method: 'PUT' })).status, 401)
  })
})

describe('install status asks for a GitHub sync', () => {
  const route = (requestSync: () => Promise<void>, found = false) =>
    createGithubInstallRoute(
      {
        findRepository: async () =>
          found ? { owner: 'acme', name: 'eval', defaultBranch: 'main' } : null,
        listRepositories: async () => [],
        readAppSlug: () => 'adamant',
        requestSync,
      },
      auth,
    )

  it('only while the repository is not bound yet', async () => {
    let asked = 0
    const missing = route(async () => {
      asked += 1
    })
    const response = await missing.request('/installations/status?owner=acme&name=eval', {
      headers: authed,
    })
    assert.equal(response.status, 404)
    assert.equal(asked, 1)

    const bound = route(async () => {
      asked += 1
    }, true)
    assert.equal(
      (await bound.request('/installations/status?owner=acme&name=eval', { headers: authed }))
        .status,
      200,
    )
    assert.equal(asked, 1)
  })

  it('still answers 404 when the request fails', async () => {
    const app = route(async () => {
      throw new Error('graphile_worker schema missing')
    })
    const response = await app.request('/installations/status?owner=acme&name=eval', {
      headers: authed,
    })
    assert.equal(response.status, 404)
  })

  it('is throttled so a 2 s poll does not read GitHub every 2 s', async () => {
    let clock = 0
    let runs = 0
    const ask = throttle(
      async () => {
        runs += 1
      },
      10_000,
      () => clock,
    )
    await ask()
    clock = 2_000
    await ask()
    clock = 9_999
    await ask()
    assert.equal(runs, 1)
    clock = 10_000
    await ask()
    assert.equal(runs, 2)
  })
})
