import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AdamantApi } from '../../cli/src/api.ts'
import { loadCliConfig } from '../../cli/src/config.ts'
import {
  followActivity,
  parseSseFrames,
  type ActivityConnectionState,
  type ActivityEvent,
} from '../../cli/src/sse.ts'

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

const frame = (id: string) => `id: ${id}\nevent: audit:step\ndata: {"runId":"${id}"}\n\n`

type Connection = {
  /** Frames sent as soon as the stream opens. */
  frames?: string[]
  /** Keep the stream open after the frames, like a live feed. */
  hold?: boolean
  status?: number
  /** Never answer the request, like an API that is down behind a proxy. */
  hang?: boolean
}

/**
 * Serves one scripted connection per request and records each request's
 * Last-Event-ID. Aborting a request errors its body, as undici does.
 */
function scriptedApi(connections: Connection[]) {
  const requests: (string | null)[] = []
  const api = new AdamantApi(
    loadCliConfig({ ADAMANT_API_URL: 'https://adamant.example', ADAMANT_SESSION: 's' }),
    async (input, init) => {
      const request = new Request(input, init)
      requests.push(request.headers.get('Last-Event-ID'))
      const script = connections.shift() ?? { hold: true }
      const signal = init?.signal
      if (script.hang) {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      if (script.status) return Response.json({ error: 'nope' }, { status: script.status })
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of script.frames ?? [])
            controller.enqueue(new TextEncoder().encode(chunk))
          if (!script.hold) controller.close()
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  )
  return { api, requests }
}

function follow(
  api: AdamantApi,
  options: { idleTimeoutMs?: number; connectTimeoutMs?: number } = {},
) {
  const abort = new AbortController()
  const events: ActivityEvent[] = []
  const states: ActivityConnectionState['kind'][] = []
  const errors: string[] = []
  const done = followActivity(api, {
    signal: abort.signal,
    onEvent: (event) => events.push(event),
    onConnection: (state) => states.push(state.kind),
    onError: (error) => errors.push(error.message),
    ...options,
  })
  return { abort, events, states, errors, done }
}

const until = async (condition: () => boolean, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('Adamant CLI activity stream', () => {
  it('stops and says why when the session is refused, instead of retrying forever', async () => {
    const { api, requests } = scriptedApi([{ status: 401 }])
    const watch = follow(api)

    await watch.done

    assert.equal(requests.length, 1)
    assert.equal(watch.errors.length, 1)
    assert.match(watch.errors[0] ?? '', /rejected ADAMANT_SESSION/)
  })

  it('resumes from the last event and shows each event once across a reconnect', async () => {
    const { api, requests } = scriptedApi([
      { frames: [frame('a1'), frame('a2')] },
      // An API whose history no longer holds a2 replays everything.
      { frames: [frame('a1'), frame('a2'), frame('a3')], hold: true },
    ])
    const watch = follow(api)

    await until(() => watch.events.length === 3)
    watch.abort.abort()
    await watch.done

    assert.deepEqual(
      watch.events.map((event) => event.id),
      ['a1', 'a2', 'a3'],
    )
    assert.deepEqual(requests, [null, 'a2'])
    assert.deepEqual(watch.errors, [])
  })

  it('reconnects a stream that went quiet without reporting an error', async () => {
    const { api, requests } = scriptedApi([{ frames: [frame('a1')], hold: true }])
    const watch = follow(api, { idleTimeoutMs: 40 })

    await until(() => requests.length === 2)
    watch.abort.abort()
    await watch.done

    assert.deepEqual(requests, [null, 'a1'])
    assert.deepEqual(watch.states.slice(0, 4), [
      'connecting',
      'connected',
      'reconnecting',
      'connected',
    ])
    assert.deepEqual(watch.errors, [])
  })

  it('reports an API that never answers and keeps trying', async () => {
    const { api, requests } = scriptedApi([{ hang: true }, { hang: true }])
    const watch = follow(api, { connectTimeoutMs: 30 })

    await until(() => requests.length === 2)
    watch.abort.abort()
    await watch.done

    assert.match(watch.errors[0] ?? '', /https:\/\/adamant\.example did not answer/)
  })

  it('backs off from an endpoint that accepts the stream and hangs up at once', async () => {
    const { api, requests } = scriptedApi([{}, {}, {}])
    const abort = new AbortController()
    const attempts: number[] = []
    const done = followActivity(api, {
      signal: abort.signal,
      onEvent: () => {},
      onConnection: (state) => {
        if (state.kind === 'reconnecting') attempts.push(state.attempt)
      },
      onError: () => {},
    })

    await until(() => requests.length === 2 && attempts.length === 2)
    abort.abort()
    await done

    assert.deepEqual(attempts, [1, 2])
  })

  it('returns promptly when the watcher is closed', async () => {
    const { api } = scriptedApi([{ frames: [frame('a1')], hold: true }])
    const watch = follow(api)
    await until(() => watch.events.length === 1)

    const started = Date.now()
    watch.abort.abort()
    await watch.done

    assert.ok(Date.now() - started < 100)
    assert.deepEqual(watch.errors, [])
  })
})
