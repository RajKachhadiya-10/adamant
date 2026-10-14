import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { type Pool } from 'pg'
import { createActivityRoute } from '../../server/api/routes/activity.ts'
import { createServerApp, type ServerOptions } from '../../server/api/server.ts'
import {
  ACTIVITY_CHANNEL,
  createActivityService,
  listenForActivity,
} from '../../server/api/services/activityService.ts'
import { webhookDeliveries, type Db } from '../../server/db/client.ts'

const SESSION = 'test-session-secret'

function authenticatedApp(runStore?: undefined, options: ServerOptions = {}) {
  return createServerApp(runStore, {
    ...options,
    authenticate: async (token) =>
      token === SESSION ? { sessionId: 'session-1', userId: 'user-1' } : null,
  })
}

const waitTick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms))

async function readStreamFrame(
  stream: ReadableStream<Uint8Array>,
  maxBytes = 8192,
): Promise<string> {
  const reader = stream.getReader()
  let text = ''
  const decoder = new TextDecoder()

  try {
    while (text.length < maxBytes) {
      const { done, value } = await reader.read()
      if (done || !value) break
      text += decoder.decode(value, { stream: true })
      if (text.includes('\n\n') || text.includes('\r\n\r\n')) {
        break
      }
    }
  } finally {
    reader.releaseLock()
  }

  return text
}

describe('Activity SSE Stream', () => {
  it('unauthenticated request returns 401', async () => {
    const app = authenticatedApp()
    const res = await app.request('/activity')
    assert.equal(res.status, 401)
  })

  it('authenticated request succeeds', async () => {
    const controller = new AbortController()
    try {
      const app = authenticatedApp()
      const res = await app.request('/activity', {
        headers: { ADAMANT_SESSION: SESSION },
        signal: controller.signal,
      })
      assert.equal(res.status, 200)
    } finally {
      controller.abort()
    }
  })

  it('SSE response headers/content type are correct', async () => {
    const controller = new AbortController()
    try {
      const app = authenticatedApp()
      const res = await app.request('/activity', {
        headers: { ADAMANT_SESSION: SESSION },
        signal: controller.signal,
      })
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
      assert.match(res.headers.get('cache-control') ?? '', /no-cache/)
    } finally {
      controller.abort()
    }
  })

  it('persisted activity is streamed with correct event IDs and types', async () => {
    const activityService = createActivityService()
    activityService.publish({
      id: 'wh_deliv-1',
      type: 'webhook:workflow_run',
      timestamp: '2026-09-29T10:00:00.000Z',
      payload: { deliveryId: 'deliv-1', status: 'completed' },
    })

    const controller = new AbortController()
    try {
      const app = authenticatedApp(undefined, { activityService })
      const res = await app.request('/activity', {
        headers: { ADAMANT_SESSION: SESSION },
        signal: controller.signal,
      })

      assert.equal(res.status, 200)
      assert.ok(res.body)
      const bodyText = await readStreamFrame(res.body)

      assert.match(bodyText, /id: wh_deliv-1/)
      assert.match(bodyText, /event: webhook:workflow_run/)
      assert.match(bodyText, /"deliveryId":"deliv-1"/)
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(activityService.subscriberCount(), 0)
    }
  })

  it('new activity reaches connected clients', async () => {
    const activityService = createActivityService()
    const app = authenticatedApp(undefined, { activityService })

    const controller = new AbortController()
    try {
      const res = await app.request('/activity', {
        headers: { ADAMANT_SESSION: SESSION },
        signal: controller.signal,
      })

      assert.equal(res.status, 200)
      assert.ok(res.body)
      const reader = res.body.getReader()

      // Publish new activity after connection established
      activityService.publish({
        id: 'audit_event-100',
        type: 'audit:run.queued',
        timestamp: new Date().toISOString(),
        payload: { runId: 'run-100', sourceSha: 'sha100' },
      })

      const chunk = await reader.read()
      assert.ok(!chunk.done)
      const text = new TextDecoder().decode(chunk.value)

      assert.match(text, /id: audit_event-100/)
      assert.match(text, /event: audit:run\.queued/)
      assert.match(text, /"runId":"run-100"/)

      reader.releaseLock()
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(activityService.subscriberCount(), 0)
    }
  })

  it('disconnect removes the subscription/listener', async () => {
    const activityService = createActivityService()
    const app = authenticatedApp(undefined, { activityService })

    assert.equal(activityService.subscriberCount(), 0)

    const controller = new AbortController()
    const res = await app.request('/activity', {
      headers: { ADAMANT_SESSION: SESSION },
      signal: controller.signal,
    })

    assert.equal(res.status, 200)
    assert.equal(activityService.subscriberCount(), 1)

    // Abort stream / disconnect client
    controller.abort()

    await waitTick()

    assert.equal(activityService.subscriberCount(), 0)
  })

  it('reconnect/replay using Last-Event-ID works and does not duplicate the boundary event', async () => {
    const activityService = createActivityService()
    activityService.publish({
      id: 'evt_1',
      type: 'audit:step_1',
      timestamp: '2026-09-29T10:00:00.000Z',
      payload: { step: 1 },
    })
    activityService.publish({
      id: 'evt_2',
      type: 'audit:step_2',
      timestamp: '2026-09-29T10:01:00.000Z',
      payload: { step: 2 },
    })
    activityService.publish({
      id: 'evt_3',
      type: 'audit:step_3',
      timestamp: '2026-09-29T10:02:00.000Z',
      payload: { step: 3 },
    })

    const controller = new AbortController()
    try {
      const app = authenticatedApp(undefined, { activityService })

      // Reconnect with Last-Event-ID: evt_2
      const res = await app.request('/activity', {
        headers: {
          ADAMANT_SESSION: SESSION,
          'Last-Event-ID': 'evt_2',
        },
        signal: controller.signal,
      })

      assert.equal(res.status, 200)
      assert.ok(res.body)
      const bodyText = await readStreamFrame(res.body)

      // Boundary event evt_2 and earlier event evt_1 must NOT be replayed
      assert.doesNotMatch(bodyText, /id: evt_1/)
      assert.doesNotMatch(bodyText, /id: evt_2/)

      // Subsequent event evt_3 MUST be replayed
      assert.match(bodyText, /id: evt_3/)
      assert.match(bodyText, /event: audit:step_3/)
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(activityService.subscriberCount(), 0)
    }
  })

  it('preserves and orders events that share the same timestamp by ID', async () => {
    const activityService = createActivityService()
    activityService.publish({
      id: 'evt_b',
      type: 'audit:step_b',
      timestamp: '2026-09-29T10:00:00.000Z',
      payload: { step: 'b' },
    })
    activityService.publish({
      id: 'evt_a',
      type: 'audit:step_a',
      timestamp: '2026-09-29T10:00:00.000Z',
      payload: { step: 'a' },
    })

    const controller = new AbortController()
    try {
      const app = authenticatedApp(undefined, { activityService })

      // Reconnect after evt_a: should still replay evt_b with identical timestamp
      const res = await app.request('/activity', {
        headers: {
          ADAMANT_SESSION: SESSION,
          'Last-Event-ID': 'evt_a',
        },
        signal: controller.signal,
      })

      assert.equal(res.status, 200)
      assert.ok(res.body)
      const bodyText = await readStreamFrame(res.body)

      assert.doesNotMatch(bodyText, /id: evt_a/)
      assert.match(bodyText, /id: evt_b/)
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(activityService.subscriberCount(), 0)
    }
  })

  it('bounds in-memory event retention', async () => {
    const activityService = createActivityService({ maxInMemoryEvents: 2 })
    activityService.publish({
      id: 'evt_1',
      type: 'audit:step_1',
      timestamp: '2026-09-29T10:00:00.000Z',
      payload: { step: 1 },
    })
    activityService.publish({
      id: 'evt_2',
      type: 'audit:step_2',
      timestamp: '2026-09-29T10:01:00.000Z',
      payload: { step: 2 },
    })
    activityService.publish({
      id: 'evt_3',
      type: 'audit:step_3',
      timestamp: '2026-09-29T10:02:00.000Z',
      payload: { step: 3 },
    })

    const history = await activityService.getHistory()
    assert.equal(history.length, 2)
    assert.equal(history[0]?.id, 'evt_2')
    assert.equal(history[1]?.id, 'evt_3')
  })

  it('propagates database query failure instead of swallowing it', async () => {
    const mockDb = {
      select: () => {
        throw new Error('Database connection failed')
      },
    } as unknown as Db

    const activityService = createActivityService({ database: mockDb })
    await assert.rejects(
      async () => {
        await activityService.getHistory()
      },
      {
        message: 'Database connection failed',
      },
    )
  })

  it('buffers live events during history replay and drains them in order without duplicating history', async () => {
    let unblockHistory!: () => void
    const historyBlocker = new Promise<void>((resolve) => {
      unblockHistory = resolve
    })

    const baseService = createActivityService()
    const customService = {
      ...baseService,
      async getHistory() {
        await historyBlocker
        return [
          {
            id: 'evt_hist_1',
            type: 'audit:hist_1',
            timestamp: '2026-09-29T10:00:00.000Z',
            payload: { hist: 1 },
          },
        ]
      },
    }

    const app = authenticatedApp(undefined, { activityService: customService })
    const controller = new AbortController()

    try {
      const resPromise = app.request('/activity', {
        headers: { ADAMANT_SESSION: SESSION },
        signal: controller.signal,
      })

      // Give connection time to subscribe and start waiting for history
      await waitTick(20)

      // Publish a live event while history is still pending
      customService.publish({
        id: 'evt_live_1',
        type: 'audit:live_1',
        timestamp: '2026-09-29T10:01:00.000Z',
        payload: { live: 1 },
      })

      // Also publish an event that matches history to test deduplication
      customService.publish({
        id: 'evt_hist_1',
        type: 'audit:hist_1',
        timestamp: '2026-09-29T10:00:00.000Z',
        payload: { hist: 1 },
      })

      // Now unblock history
      unblockHistory()

      const res = await resPromise
      assert.equal(res.status, 200)
      assert.ok(res.body)

      const reader = res.body.getReader()
      let fullText = ''
      const decoder = new TextDecoder()
      while (fullText.length < 8192) {
        const { done, value } = await reader.read()
        if (done || !value) break
        fullText += decoder.decode(value, { stream: true })
        if (fullText.includes('evt_live_1')) break
      }
      reader.releaseLock()

      // History event comes before live event
      const histPos = fullText.indexOf('id: evt_hist_1')
      const livePos = fullText.indexOf('id: evt_live_1')
      assert.ok(histPos !== -1, 'History event should be present')
      assert.ok(livePos !== -1, 'Live event should be present')
      assert.ok(histPos < livePos, 'History event should appear before live event')

      // History event should NOT be duplicated
      const secondHistPos = fullText.indexOf('id: evt_hist_1', histPos + 1)
      assert.equal(secondHistPos, -1, 'History event should not be duplicated')
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(customService.subscriberCount(), 0)
    }
  })
})

describe('Activity from the database', () => {
  type Row = Record<string, unknown>

  /** Answers the activity reads; ignores filters, so every poll sees every row. */
  function fakeDb(tables: { deliveries: Row[]; audits: Row[] }) {
    const reads = { count: 0, limits: [] as number[] }
    const database = {
      select: () => ({
        from: (table: unknown) => {
          const rows = table === webhookDeliveries ? tables.deliveries : tables.audits
          const chain = {
            where: () => chain,
            orderBy: () => chain,
            limit: async (limit: number) => {
              reads.count += 1
              reads.limits.push(limit)
              return [...rows]
            },
          }
          return chain
        },
      }),
    } as unknown as Db
    return { database, reads }
  }

  const audit = (id: string): Row => ({
    id,
    runId: 'run-1',
    eventType: 'run.merged',
    payload: { prNumber: 7 },
    actorUserId: null,
    createdAt: new Date(),
  })

  it('delivers rows another process wrote to connected clients, once each', async () => {
    const tables = { deliveries: [] as Row[], audits: [] as Row[] }
    const { database } = fakeDb(tables)
    const service = createActivityService({ database, pollIntervalMs: 5 })
    const received: string[] = []
    const unsubscribe = service.subscribe((event) => received.push(event.id))

    try {
      tables.audits.push(audit('a1'))
      await waitTick(40)
      tables.deliveries.push({
        id: 'd1',
        githubDeliveryId: 'gh-1',
        eventType: 'workflow_run',
        repositoryId: null,
        installationId: null,
        processingStatus: 'processed',
        receivedAt: new Date(),
      })
      await waitTick(40)

      assert.deepEqual(received, ['audit_a1', 'wh_d1'])
    } finally {
      unsubscribe()
    }
  })

  it('stops reading the database when the last client leaves', async () => {
    const { database, reads } = fakeDb({ deliveries: [], audits: [] })
    const service = createActivityService({ database, pollIntervalMs: 5 })

    const unsubscribe = service.subscribe(() => {})
    await waitTick(30)
    unsubscribe()
    await waitTick(10)
    const afterLeave = reads.count
    await waitTick(30)

    assert.ok(afterLeave > 0, 'polled while a client was connected')
    assert.equal(reads.count, afterLeave)
  })

  it('reads as soon as a change is signalled instead of at the next poll', async () => {
    const tables = { deliveries: [] as Row[], audits: [] as Row[] }
    const { database } = fakeDb(tables)
    let signal: (() => void) | undefined
    let stops = 0
    const service = createActivityService({
      database,
      // Far enough out that only the signal can explain a delivery.
      pollIntervalMs: 60_000,
      changes: (onChange) => {
        signal = onChange
        return () => {
          stops += 1
        }
      },
    })
    const received: string[] = []
    const unsubscribe = service.subscribe((event) => received.push(event.id))

    tables.audits.push(audit('a1'))
    signal?.()
    await waitTick(20)
    assert.deepEqual(received, ['audit_a1'])

    unsubscribe()
    assert.equal(stops, 1, 'stops listening with the last client')
  })

  it('reads again when a change lands during a read, so it is not left for the poll', async () => {
    const tables = { deliveries: [] as Row[], audits: [] as Row[] }
    let release: (() => void) | undefined
    const reads = { count: 0 }
    const database = {
      select: () => ({
        from: (table: unknown) => {
          const chain = {
            where: () => chain,
            orderBy: () => chain,
            limit: async () => {
              reads.count += 1
              // Hold the first read open until the test lets it finish.
              if (reads.count === 1) await new Promise<void>((resolve) => (release = resolve))
              return [...(table === webhookDeliveries ? tables.deliveries : tables.audits)]
            },
          }
          return chain
        },
      }),
    } as unknown as Db
    let signal: (() => void) | undefined
    const service = createActivityService({
      database,
      pollIntervalMs: 60_000,
      changes: (onChange) => {
        signal = onChange
        return () => {}
      },
    })
    const received: string[] = []
    const unsubscribe = service.subscribe((event) => received.push(event.id))

    try {
      signal?.()
      await waitTick(5)
      tables.audits.push(audit('late'))
      signal?.()
      release?.()
      await waitTick(20)
      assert.deepEqual(received, ['audit_late'])
    } finally {
      unsubscribe()
    }
  })

  it('bounds the history it reads on connect', async () => {
    const { database, reads } = fakeDb({ deliveries: [], audits: [audit('a1')] })
    const service = createActivityService({ database, historyLimit: 50 })

    const history = await service.getHistory()

    assert.deepEqual(reads.limits, [50, 50])
    assert.deepEqual(
      history.map((event) => event.id),
      ['audit_a1'],
    )
  })

  it('remembers only a window of sent ids per connection', async () => {
    const service = createActivityService()
    const app = createActivityRoute(service, { dedupeWindow: 2 })
    const controller = new AbortController()
    const publish = (id: string) =>
      service.publish({ id, type: 'audit:step', timestamp: new Date().toISOString(), payload: {} })

    try {
      const res = await app.request('/', { signal: controller.signal })
      assert.ok(res.body)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let text = ''
      // Reads up to a sentinel so a dropped event fails the count, not the read.
      const readUntil = async (sentinel: string) => {
        while (!text.includes(`id: ${sentinel}\n`)) {
          const { done, value } = await reader.read()
          if (done || !value) break
          text += decoder.decode(value, { stream: true })
        }
      }

      // A repeat inside the window is dropped, so the connection sees it once.
      publish('dup')
      publish('dup')
      publish('other-1')
      await readUntil('other-1')
      assert.equal((text.match(/^id: dup$/gm) ?? []).length, 1)

      // Once enough newer ids have gone out, the old id is forgotten rather
      // than held for the life of the connection.
      publish('other-2')
      publish('dup')
      publish('other-3')
      await readUntil('other-3')
      assert.equal((text.match(/^id: dup$/gm) ?? []).length, 2)
      reader.releaseLock()
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(service.subscriberCount(), 0)
    }
  })

  it('keeps an idle stream open with heartbeat comments', async () => {
    const app = createActivityRoute(createActivityService(), { heartbeatMs: 5 })
    const controller = new AbortController()
    // The heartbeat is unref'd so it never holds a process open; in production
    // the HTTP server does. Here nothing else would, so hold the loop meanwhile.
    const keepAlive = setTimeout(() => {}, 5_000)
    try {
      const res = await app.request('/', { signal: controller.signal })
      assert.ok(res.body)
      const frame = await readStreamFrame(res.body)
      assert.match(frame, /^: ping/m)
    } finally {
      clearTimeout(keepAlive)
      controller.abort()
    }
  })
})

describe('LISTEN for activity', () => {
  class FakeClient extends EventEmitter {
    readonly queries: string[] = []
    readonly released: unknown[] = []
    async query(sql: string) {
      this.queries.push(sql)
    }
    release(destroy?: unknown) {
      this.released.push(destroy ?? 'returned')
    }
  }

  function fakePool() {
    const clients: FakeClient[] = []
    const pool = {
      connect: async () => {
        const client = new FakeClient()
        clients.push(client)
        return client
      },
    } as unknown as Pool
    return { pool, clients }
  }

  it('wakes on its channel, catches up once listening, and hands the connection back', async () => {
    const { pool, clients } = fakePool()
    let changes = 0
    const stop = listenForActivity(pool)(() => (changes += 1))
    await waitTick()
    const client = clients[0]
    assert.ok(client)

    assert.deepEqual(client.queries, [`LISTEN ${ACTIVITY_CHANNEL}`])
    assert.equal(changes, 1, 'rows from before LISTEN are read once')

    client.emit('notification', { channel: ACTIVITY_CHANNEL, processId: 1 })
    client.emit('notification', { channel: 'something_else', processId: 1 })
    assert.equal(changes, 2)

    stop()
    await waitTick()
    assert.deepEqual(client.queries, [`LISTEN ${ACTIVITY_CHANNEL}`, `UNLISTEN ${ACTIVITY_CHANNEL}`])
    // Reused, not destroyed, and without our listeners left on a shared client.
    assert.deepEqual(client.released, ['returned'])
    assert.equal(client.listenerCount('notification'), 0)
    assert.equal(client.listenerCount('error'), 0)
  })

  it('destroys a broken connection and listens again on a new one', async () => {
    const { pool, clients } = fakePool()
    let changes = 0
    const stop = listenForActivity(pool, { retryMs: 5 })(() => (changes += 1))
    await waitTick()

    clients[0]?.emit('error', new Error('terminating connection'))
    clients[0]?.emit('end')
    await waitTick(30)
    stop()

    assert.deepEqual(clients[0]?.released, [true])
    assert.equal(clients.length, 2, 'one reconnect, not one per event')
    assert.deepEqual(clients[1]?.queries.slice(0, 1), [`LISTEN ${ACTIVITY_CHANNEL}`])
    assert.equal(changes, 2, 'catches up after reconnecting')
  })
})
