import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createActivityRoute } from '../../server/api/routes/activity.ts'
import {
  auditEvent,
  createActivityService,
  type ActivityEvent,
} from '../../server/api/services/activityService.ts'
import { Hono } from 'hono'

const waitTick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

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

describe('Stage Telemetry Activity SSE Stream', () => {
  it('formats and publishes all pipeline stage progress events to subscribers', async () => {
    const service = createActivityService()
    const received: ActivityEvent[] = []
    const unsubscribe = service.subscribe((event) => {
      received.push(event)
    })

    const stageEvents = [
      { eventType: 'run.diagnosing', payload: { stage: 'diagnose', attempt: 1 } },
      { eventType: 'run.diagnosed', payload: { stage: 'diagnose', attempt: 1, durationMs: 1400 } },
      { eventType: 'run.planning', payload: { stage: 'plan', attempt: 1 } },
      { eventType: 'run.planned', payload: { stage: 'plan', attempt: 1, durationMs: 900 } },
      { eventType: 'run.patching', payload: { stage: 'patch', attempt: 1 } },
      {
        eventType: 'run.patched',
        payload: { stage: 'patch', attempt: 1, candidateHash: 'abc', durationMs: 2500 },
      },
      {
        eventType: 'run.sandboxing',
        payload: { stage: 'sandbox', attempt: 1, candidateHash: 'abc' },
      },
      {
        eventType: 'run.sandboxed',
        payload: { stage: 'sandbox', attempt: 1, verdict: 'pass', durationMs: 15000 },
      },
      {
        eventType: 'run.publishing',
        payload: { stage: 'publish', attempt: 1, candidateHash: 'abc' },
      },
      {
        eventType: 'run.pr_opened',
        payload: {
          stage: 'publish',
          attempt: 1,
          prNumber: 42,
          prUrl: 'https://github.com/org/repo/pull/42',
          durationMs: 800,
        },
      },
    ]

    let counter = 1
    for (const { eventType, payload } of stageEvents) {
      const formatted = auditEvent({
        id: `audit-row-${counter++}`,
        runId: 'run-stage-test',
        eventType,
        payload,
        actorUserId: null,
        createdAt: new Date(Date.UTC(2026, 9, 31, 12, 0, counter)),
      })
      service.publish(formatted)
    }

    assert.equal(received.length, 10)
    assert.deepEqual(
      received.map((e) => e.type),
      [
        'audit:run.diagnosing',
        'audit:run.diagnosed',
        'audit:run.planning',
        'audit:run.planned',
        'audit:run.patching',
        'audit:run.patched',
        'audit:run.sandboxing',
        'audit:run.sandboxed',
        'audit:run.publishing',
        'audit:run.pr_opened',
      ],
    )

    unsubscribe()
    assert.equal(service.subscriberCount(), 0)
  })

  it('streams stage progress events over the SSE route with correct framing', async () => {
    const service = createActivityService()
    const route = createActivityRoute(service)
    const app = new Hono()
    app.route('/activity', route)

    const stageEvent = auditEvent({
      id: 'row-diagnose-1',
      runId: 'run-sse-test',
      eventType: 'run.diagnosed',
      payload: { stage: 'diagnose', attempt: 1, durationMs: 1250 },
      actorUserId: null,
      createdAt: new Date('2026-10-31T12:00:00.000Z'),
    })
    service.publish(stageEvent)

    const controller = new AbortController()
    try {
      const res = await app.request('/activity', {
        signal: controller.signal,
      })

      assert.equal(res.status, 200)
      assert.ok(res.body)
      const frame = await readStreamFrame(res.body)

      assert.match(frame, /id: audit_row-diagnose-1/)
      assert.match(frame, /event: audit:run\.diagnosed/)
      assert.match(frame, /"stage":"diagnose"/)
      assert.match(frame, /"durationMs":1250/)
      assert.match(frame, /"runId":"run-sse-test"/)
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(service.subscriberCount(), 0)
    }
  })

  it('delivers live stage events to an actively connected SSE client', async () => {
    const service = createActivityService()
    const route = createActivityRoute(service)
    const app = new Hono()
    app.route('/activity', route)

    const controller = new AbortController()
    try {
      const res = await app.request('/activity', {
        signal: controller.signal,
      })

      assert.equal(res.status, 200)
      assert.ok(res.body)

      // Publish live event after client is connected
      const sandboxingEvent = auditEvent({
        id: 'row-sb-1',
        runId: 'run-live-test',
        eventType: 'run.sandboxing',
        payload: { stage: 'sandbox', attempt: 1, candidateHash: 'hash-xyz' },
        actorUserId: null,
        createdAt: new Date('2026-10-31T12:05:00.000Z'),
      })
      service.publish(sandboxingEvent)

      const frame = await readStreamFrame(res.body)
      assert.match(frame, /id: audit_row-sb-1/)
      assert.match(frame, /event: audit:run\.sandboxing/)
      assert.match(frame, /"stage":"sandbox"/)
      assert.match(frame, /"candidateHash":"hash-xyz"/)
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(service.subscriberCount(), 0)
    }
  })
})
