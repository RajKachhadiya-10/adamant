import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type RunSummary } from '@adamant/contract'
import { createAuthMiddleware } from '../../server/api/middleware/auth.ts'
import { createRunsRoute } from '../../server/api/routes/runs.ts'
import { type RunApiStore, UnknownRepositoryError } from '../../server/api/services/runStore.ts'

const session = 'cli-session'
const userId = '00000000-0000-0000-0000-000000000001'
const run: RunSummary = {
  id: 'run-1',
  repositoryId: 'repo-1',
  sourceSha: 'abc',
  targetBranch: 'adamant/run-1',
  status: 'queued',
  version: 1,
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
}

function routeFor(store: RunApiStore) {
  return createRunsRoute(
    store,
    createAuthMiddleware({
      authenticate: async (token) =>
        token === session ? { sessionId: 'session-1', userId } : null,
    }),
  )
}

describe('CLI run routes', () => {
  it('authenticates and creates, lists, and reads persisted runs', async () => {
    const store = {
      create: async () => ({ run, created: true }),
      list: async () => [run],
      detail: async () => ({ run, auditEvents: [] }),
    } satisfies RunApiStore
    const route = routeFor(store)
    assert.equal((await route.request('/')).status, 401)
    const headers = { ADAMANT_SESSION: session }
    assert.equal((await route.request('/', { headers })).status, 200)
    assert.equal(
      (
        await route.request('/', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'key-1' },
          body: JSON.stringify({ repositoryId: 'repo-1', sourceSha: 'a'.repeat(40) }),
        })
      ).status,
      202,
    )
    assert.equal((await route.request('/run-1', { headers })).status, 200)
  })

  it('rejects a source that is not a full commit SHA before it reaches git', async () => {
    let created = 0
    const store = {
      create: async () => {
        created += 1
        return { run, created: true }
      },
      list: async () => [],
      detail: async () => null,
    } satisfies RunApiStore
    const route = routeFor(store)

    for (const sourceSha of ['abc123', '--upload-pack=touch /tmp/x', 'HEAD']) {
      const response = await route.request('/', {
        method: 'POST',
        headers: {
          ADAMANT_SESSION: session,
          'content-type': 'application/json',
          'idempotency-key': `key-${sourceSha}`,
        },
        body: JSON.stringify({ repositoryId: 'repo-1', sourceSha }),
      })
      assert.equal(response.status, 400, sourceSha)
    }
    assert.equal(created, 0)
  })

  it('rejects fields that are not strings, even when they coerce to a valid SHA', async () => {
    let created = 0
    const store = {
      create: async () => {
        created += 1
        return { run, created: true }
      },
      list: async () => [],
      detail: async () => null,
    } satisfies RunApiStore
    const route = routeFor(store)
    const headers = {
      ADAMANT_SESSION: session,
      'content-type': 'application/json',
      'idempotency-key': 'key',
    }

    const bodies = [
      { repositoryId: 'repo-1', sourceSha: ['a'.repeat(40)] },
      { repositoryId: ['repo-1'], sourceSha: 'a'.repeat(40) },
      { repositoryId: { id: 'repo-1' }, sourceSha: 'a'.repeat(40) },
      { repositoryId: 'repo-1', sourceSha: 1 },
    ]
    for (const body of bodies) {
      const response = await route.request('/', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 400, JSON.stringify(body))
    }
    assert.equal(created, 0)
  })

  it('bounds the idempotency key and the request body', async () => {
    let created = 0
    const store = {
      create: async () => {
        created += 1
        return { run, created: true }
      },
      list: async () => [],
      detail: async () => null,
    } satisfies RunApiStore
    const route = routeFor(store)
    const valid = { repositoryId: 'repo-1', sourceSha: 'a'.repeat(40) }

    const longKey = await route.request('/', {
      method: 'POST',
      headers: {
        ADAMANT_SESSION: session,
        'content-type': 'application/json',
        'idempotency-key': 'k'.repeat(256),
      },
      body: JSON.stringify(valid),
    })
    assert.equal(longKey.status, 400)

    const oversized = await route.request('/', {
      method: 'POST',
      headers: {
        ADAMANT_SESSION: session,
        'content-type': 'application/json',
        'idempotency-key': 'key',
      },
      body: JSON.stringify({ ...valid, padding: 'x'.repeat(64 * 1024) }),
    })
    assert.equal(oversized.status, 413)
    assert.equal(created, 0)
  })

  it('answers 404, not 500, for a repository that does not exist', async () => {
    const store = {
      create: async () => {
        throw new UnknownRepositoryError()
      },
      list: async () => [],
      detail: async () => null,
    } satisfies RunApiStore
    const route = routeFor(store)

    const response = await route.request('/', {
      method: 'POST',
      headers: {
        ADAMANT_SESSION: session,
        'content-type': 'application/json',
        'idempotency-key': 'k',
      },
      body: JSON.stringify({ repositoryId: 'missing', sourceSha: 'a'.repeat(40) }),
    })

    assert.equal(response.status, 404)
  })

  it('limits how many runs one user starts, without slowing reads or other users', async () => {
    let created = 0
    const store = {
      create: async () => {
        created += 1
        return { run, created: true }
      },
      list: async () => [run],
      detail: async () => null,
    } satisfies RunApiStore
    const sessions: Record<string, string> = {
      alice: '00000000-0000-0000-0000-00000000000a',
      bob: '00000000-0000-0000-0000-00000000000b',
    }
    const route = createRunsRoute(
      store,
      createAuthMiddleware({
        authenticate: async (token) => {
          const id = sessions[token]
          return id ? { sessionId: `session-${token}`, userId: id } : null
        },
      }),
    )
    // A fresh key each time, as a script would send, so idempotency cannot absorb them.
    const start = (who: string, key: string) =>
      route.request('/', {
        method: 'POST',
        headers: {
          ADAMANT_SESSION: who,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({ repositoryId: 'repo-1', sourceSha: 'a'.repeat(40) }),
      })

    for (let index = 0; index < 10; index += 1) {
      assert.equal((await start('alice', `key-${index}`)).status, 202, `start ${index + 1}`)
    }
    const refused = await start('alice', 'key-10')

    assert.equal(refused.status, 429)
    assert.deepEqual(await refused.json(), {
      error: 'Too many runs started. Try again in a minute.',
    })
    assert.ok(Number(refused.headers.get('retry-after')) > 0)
    assert.equal(created, 10, 'the refused start never reached the store')
    assert.equal((await route.request('/', { headers: { ADAMANT_SESSION: 'alice' } })).status, 200)
    assert.equal((await start('bob', 'key-b')).status, 202, 'another user has their own budget')
  })
})
