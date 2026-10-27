import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { auditEvent } from '../../server/api/services/activityService.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date('2026-10-27T00:00:00.000Z')
const FIXED_ISO = FIXED_DATE.toISOString() // '2026-10-27T00:00:00.000Z'

/** A fully-populated row with no nulls. */
function makeRow(overrides: {
  id?: string
  runId?: string | null
  eventType?: string
  payload?: unknown
  actorUserId?: string | null
  createdAt?: Date
}) {
  return {
    id: 'row-1',
    runId: 'run-abc',
    eventType: 'run.queued',
    payload: { sourceSha: 'deadbeef' } as unknown,
    actorUserId: 'user-1',
    createdAt: FIXED_DATE,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auditEvent', () => {
  // 1. Event id is prefixed with audit_
  it('prefixes the event id with audit_', () => {
    const event = auditEvent(makeRow({ id: 'row-42' }))
    assert.equal(event.id, 'audit_row-42')
  })

  // 2. Event type is prefixed with audit:
  it('prefixes the event type with audit:', () => {
    const event = auditEvent(makeRow({ eventType: 'run.succeeded' }))
    assert.equal(event.type, 'audit:run.succeeded')
  })

  // 3. Timestamp is the ISO string derived from createdAt
  it('sets timestamp to the ISO string of createdAt', () => {
    const event = auditEvent(makeRow({ createdAt: FIXED_DATE }))
    assert.equal(event.timestamp, FIXED_ISO)
  })

  // 4. payload.id is the raw database row id, not the prefixed event id
  it('payload.id is the original row id, not the audit_-prefixed event id', () => {
    const event = auditEvent(makeRow({ id: 'row-99' }))
    assert.equal(event.payload['id'], 'row-99')
    assert.notEqual(event.payload['id'], event.id)
  })

  // 5. null runId passes through as null
  it('payload.runId is null when the row runId is null', () => {
    const event = auditEvent(makeRow({ runId: null }))
    assert.equal(event.payload['runId'], null)
  })

  // 6. null actorUserId passes through as null
  it('payload.actorUserId is null when the row actorUserId is null', () => {
    const event = auditEvent(makeRow({ actorUserId: null }))
    assert.equal(event.payload['actorUserId'], null)
  })

  // 7. null payload row falls back to empty object
  it('payload.payload falls back to {} when the row payload is null', () => {
    const event = auditEvent(makeRow({ payload: null }))
    assert.deepEqual(event.payload['payload'], {})
  })

  // 8. payload.createdAt equals the event timestamp
  it('payload.createdAt equals the event timestamp', () => {
    const event = auditEvent(makeRow({ createdAt: FIXED_DATE }))
    assert.equal(event.payload['createdAt'], event.timestamp)
  })

  // Bonus: nominal row — full shape is correct end-to-end
  it('formats a fully-populated row with the correct event shape', () => {
    const event = auditEvent(
      makeRow({
        id: 'row-1',
        runId: 'run-abc',
        eventType: 'run.queued',
        payload: { sourceSha: 'deadbeef' },
        actorUserId: 'user-1',
        createdAt: FIXED_DATE,
      }),
    )

    assert.deepEqual(event, {
      id: 'audit_row-1',
      type: 'audit:run.queued',
      timestamp: FIXED_ISO,
      payload: {
        id: 'row-1',
        runId: 'run-abc',
        eventType: 'run.queued',
        payload: { sourceSha: 'deadbeef' },
        actorUserId: 'user-1',
        createdAt: FIXED_ISO,
      },
    })
  })
})
