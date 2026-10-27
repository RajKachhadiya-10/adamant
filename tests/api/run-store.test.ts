import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type ActivityEvent } from '../../server/api/services/activityService.ts'
import { createMemoryRunApiStore, RUN_LIST_LIMIT } from '../../server/api/services/runStore.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InputOverrides = {
  repositoryId?: string
  sourceSha?: string
  idempotencyKey?: string
  userId?: string
}

function makeInput(overrides: InputOverrides = {}) {
  return {
    repositoryId: 'repo-1',
    sourceSha: 'abc123',
    idempotencyKey: 'key-1',
    userId: 'user-1',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createMemoryRunApiStore', () => {
  // 1. First creation returns { run, created: true }
  it('returns a run summary and created: true on first create', async () => {
    const store = createMemoryRunApiStore()
    const result = await store.create(makeInput())

    assert.equal(result.created, true)
    assert.equal(result.run.status, 'queued')
    assert.equal(result.run.repositoryId, 'repo-1')
    assert.equal(result.run.sourceSha, 'abc123')
    assert.ok(typeof result.run.id === 'string' && result.run.id.length > 0)
  })

  // 2. Generated target branch and version
  it('sets targetBranch to adamant/{id} and version to 1', async () => {
    const store = createMemoryRunApiStore()
    const { run } = await store.create(makeInput())

    assert.equal(run.targetBranch, `adamant/${run.id}`)
    assert.equal(run.version, 1)
  })

  // 3. Initial run.queued audit event stored in detail
  it('detail includes a run.queued audit event with sourceSha in its payload', async () => {
    const store = createMemoryRunApiStore()
    const { run } = await store.create(makeInput())
    const detail = await store.detail('user-1', run.id)

    assert.ok(detail !== null)
    assert.equal(detail.auditEvents.length, 1)
    const event = detail.auditEvents[0]
    assert.ok(event !== undefined)
    assert.equal(event.eventType, 'run.queued')
    assert.deepEqual(event.payload, { sourceSha: 'abc123' })
    assert.equal(event.actorUserId, 'user-1')
    assert.equal(event.runId, run.id)
  })

  // 4. Idempotency — same key returns existing run
  it('returns the same run and created: false for the same repositoryId + idempotencyKey', async () => {
    const store = createMemoryRunApiStore()
    const first = await store.create(makeInput())
    const second = await store.create(makeInput())

    assert.equal(second.created, false)
    assert.equal(second.run.id, first.run.id)
  })

  // 4b. A replay keeps the first run as it was and announces nothing new
  it('a replay with a different sourceSha returns the original run and publishes once', async () => {
    const published: ActivityEvent[] = []
    const store = createMemoryRunApiStore({ activity: { publish: (e) => published.push(e) } })
    const first = await store.create(makeInput({ sourceSha: 'abc123' }))
    const replay = await store.create(makeInput({ sourceSha: 'fff999' }))

    assert.deepEqual(replay, { run: first.run, created: false })
    assert.equal(published.length, 1)
    assert.equal((await store.list('user-1')).length, 1)
  })

  // 4c. The key is scoped to the repository, like the Postgres unique index
  it('creates a separate run for the same idempotencyKey in another repository', async () => {
    const store = createMemoryRunApiStore()
    const first = await store.create(makeInput({ repositoryId: 'repo-1' }))
    const second = await store.create(makeInput({ repositoryId: 'repo-2' }))

    assert.equal(second.created, true)
    assert.notEqual(second.run.id, first.run.id)
  })

  // 5. Different idempotency key creates a separate run
  it('creates a separate run for a different idempotencyKey', async () => {
    const store = createMemoryRunApiStore()
    const first = await store.create(makeInput({ idempotencyKey: 'key-1' }))
    const second = await store.create(makeInput({ idempotencyKey: 'key-2' }))

    assert.equal(second.created, true)
    assert.notEqual(second.run.id, first.run.id)
  })

  // 6. list scoping — each user sees only their own runs
  it('list returns only runs belonging to the requesting user', async () => {
    const store = createMemoryRunApiStore()
    const r1 = await store.create(makeInput({ userId: 'user-1', idempotencyKey: 'k1' }))
    const r2 = await store.create(makeInput({ userId: 'user-2', idempotencyKey: 'k2' }))

    const list1 = await store.list('user-1')
    const list2 = await store.list('user-2')

    assert.equal(list1.length, 1)
    assert.equal(list1[0]?.id, r1.run.id)
    assert.equal(list2.length, 1)
    assert.equal(list2[0]?.id, r2.run.id)
  })

  // 7. list order — newest first (insertion-order reversal)
  it('list returns runs newest first', async () => {
    const store = createMemoryRunApiStore()
    const runA = (await store.create(makeInput({ idempotencyKey: 'a' }))).run
    const runB = (await store.create(makeInput({ idempotencyKey: 'b' }))).run

    const listed = await store.list('user-1')

    assert.equal(listed[0]?.id, runB.id)
    assert.equal(listed[1]?.id, runA.id)
  })

  // 8. list is capped at RUN_LIST_LIMIT
  it('list is capped at RUN_LIST_LIMIT', async () => {
    const store = createMemoryRunApiStore()
    const total = RUN_LIST_LIMIT + 1
    for (let i = 0; i < total; i++) {
      await store.create(makeInput({ idempotencyKey: `k${i}` }))
    }

    const listed = await store.list('user-1')
    assert.equal(listed.length, RUN_LIST_LIMIT)
  })

  // 9. detail — correct owner receives run + audit events
  it('detail returns the run and its audit events for the owner', async () => {
    const store = createMemoryRunApiStore()
    const { run } = await store.create(makeInput())
    const detail = await store.detail('user-1', run.id)

    assert.ok(detail !== null)
    assert.equal(detail.run.id, run.id)
    assert.ok(Array.isArray(detail.auditEvents))
  })

  // 9b. detail hands out a copy of the audit trail
  it('detail returns a copy, so changing it does not change the stored trail', async () => {
    const store = createMemoryRunApiStore()
    const { run } = await store.create(makeInput())
    const first = await store.detail('user-1', run.id)
    assert.ok(first !== null)
    first.auditEvents.length = 0

    assert.equal((await store.detail('user-1', run.id))?.auditEvents.length, 1)
  })

  // 10. detail — unknown run id returns null
  it('detail returns null for an unknown run id', async () => {
    const store = createMemoryRunApiStore()
    const result = await store.detail('user-1', 'does-not-exist')

    assert.equal(result, null)
  })

  // 11. detail — wrong user returns null
  it('detail returns null for a run owned by a different user', async () => {
    const store = createMemoryRunApiStore()
    const { run } = await store.create(makeInput({ userId: 'user-1' }))
    const result = await store.detail('user-2', run.id)

    assert.equal(result, null)
  })

  // 12. Eviction — oldest entry is dropped when capacity exceeds 1000
  it('drops the oldest entry when more than 1000 runs are stored', async () => {
    const store = createMemoryRunApiStore()

    // The first run to be evicted when the 1001st is inserted.
    const { run: first } = await store.create(makeInput({ idempotencyKey: 'first' }))
    const { run: second } = await store.create(makeInput({ idempotencyKey: 'second' }))

    // 999 more push the total to 1001, triggering eviction of `first` only.
    for (let i = 0; i < 999; i++) {
      await store.create(makeInput({ idempotencyKey: `evict-${i}` }))
    }

    assert.equal(await store.detail('user-1', first.id), null)
    assert.equal((await store.detail('user-1', second.id))?.run.id, second.id)

    // Eviction also forgets the key, so the same request starts a fresh run.
    const again = await store.create(makeInput({ idempotencyKey: 'first' }))
    assert.equal(again.created, true)
    assert.notEqual(again.run.id, first.id)
  })

  // 13. activity.publish — receives an audit:run.queued ActivityEvent
  it('calls activity.publish with an audit:run.queued event when option is set', async () => {
    const published: ActivityEvent[] = []
    const store = createMemoryRunApiStore({
      activity: { publish: (e) => published.push(e) },
    })

    await store.create(makeInput())

    assert.equal(published.length, 1)
    const event = published[0]
    assert.ok(event !== undefined)
    assert.equal(event.type, 'audit:run.queued')
    assert.ok(event.id.startsWith('audit_'))
    assert.equal(typeof event.timestamp, 'string')
    assert.equal(event.payload['eventType'], 'run.queued')
    assert.equal(event.payload['actorUserId'], 'user-1')
    assert.deepEqual(event.payload['payload'], { sourceSha: 'abc123' })
  })
})
