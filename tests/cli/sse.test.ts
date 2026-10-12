import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSseFrames } from '../../cli/src/sse.ts'

describe('Adamant CLI SSE parsing', () => {
  it('parses complete event frames and ignores heartbeat comments', () => {
    const parsed = parseSseFrames(
      ': ping\n\nid: audit_1\nevent: audit:run.queued\ndata: {"runId":"run_1"}\n\n',
    )

    assert.deepEqual(parsed.frames, [
      {
        id: 'audit_1',
        type: 'audit:run.queued',
        data: '{"runId":"run_1"}',
      },
    ])
    assert.equal(parsed.remainder, '')
  })

  it('retains an incomplete frame for the following read', () => {
    const parsed = parseSseFrames(
      'id: wh_1\nevent: webhook:workflow_run\ndata: {"deliveryId":"d1"}',
    )

    assert.deepEqual(parsed.frames, [])
    assert.equal(
      parsed.remainder,
      'id: wh_1\nevent: webhook:workflow_run\ndata: {"deliveryId":"d1"}',
    )
  })
})
