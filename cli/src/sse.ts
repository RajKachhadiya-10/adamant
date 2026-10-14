import { ApiError, type AdamantApi } from './api.ts'

export type ActivityEvent = {
  id: string
  type: string
  payload: Record<string, unknown>
  receivedAt: string
}

export type ActivityConnectionState =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; attempt: number; delayMs: number }

type ParsedFrame = {
  id?: string
  type?: string
  data?: string
}

// The API sends a comment every 20 s. Two missed heartbeats means the socket
// is gone even though no error arrived (a laptop that slept, a NAT that
// forgot the mapping); without this `watch` sat on a dead connection forever.
const IDLE_TIMEOUT_MS = 45_000
const CONNECT_TIMEOUT_MS = 10_000

// Ids already delivered. A resume whose Last-Event-ID has aged out of the
// API's history replays all of it; those events would otherwise show twice.
const SEEN_EVENT_LIMIT = 2_000

function parseFrame(frame: string): ParsedFrame | undefined {
  const parsed: ParsedFrame = {}
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const field = line.slice(0, separator)
    const value = line.slice(separator + 1).replace(/^ /, '')
    if (field === 'id') parsed.id = value
    if (field === 'event') parsed.type = value
    if (field === 'data') parsed.data = parsed.data ? `${parsed.data}\n${value}` : value
  }
  return parsed.id && parsed.type && parsed.data ? parsed : undefined
}

export function parseSseFrames(chunk: string): { frames: ParsedFrame[]; remainder: string } {
  const normalized = chunk.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  const remainder = blocks.pop() ?? ''
  return {
    frames: blocks.flatMap((block) => {
      const parsed = parseFrame(block)
      return parsed ? [parsed] : []
    }),
    remainder,
  }
}

function toActivityEvent(frame: ParsedFrame): ActivityEvent | undefined {
  if (!frame.id || !frame.type || !frame.data) return undefined
  try {
    const payload = JSON.parse(frame.data)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
    return {
      id: frame.id,
      type: frame.type,
      payload,
      receivedAt: new Date().toISOString(),
    }
  } catch {
    return undefined
  }
}

/** 0.5 s, 1 s, 2 s … up to 15 s, jittered so restarted APIs are not stampeded. */
export function backoffDelay(attempt: number): number {
  const base = Math.min(500 * 2 ** Math.max(0, attempt - 1), 15_000)
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

/** A refusal retrying cannot fix: a bad session, a wrong URL. */
function isFatal(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  )
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, delayMs)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
  })
}

export type FollowActivityOptions = {
  signal: AbortSignal
  onEvent(event: ActivityEvent): void
  onConnection(state: ActivityConnectionState): void
  onError(error: Error): void
  connectTimeoutMs?: number
  idleTimeoutMs?: number
}

/**
 * Follows `GET /activity` until `signal` aborts, reconnecting with
 * Last-Event-ID after a drop. Returns early only for a refusal retrying
 * cannot fix, after reporting it through `onError`.
 */
export async function followActivity(
  api: AdamantApi,
  options: FollowActivityOptions,
): Promise<void> {
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const seen = new Set<string>()
  let lastEventId: string | undefined
  let attempt = 0

  while (!options.signal.aborted) {
    const delayMs = backoffDelay(attempt)
    options.onConnection(
      attempt === 0 ? { kind: 'connecting' } : { kind: 'reconnecting', attempt, delayMs },
    )
    if (attempt > 0) await wait(delayMs, options.signal)
    if (options.signal.aborted) break

    const connection = new AbortController()
    const cancel = () => connection.abort()
    options.signal.addEventListener('abort', cancel, { once: true })
    let stalled = false
    let connected = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const expectDataWithin = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stalled = true
        connection.abort()
      }, ms)
    }

    try {
      expectDataWithin(connectTimeoutMs)
      const response = await api.openActivity(lastEventId, connection.signal)
      const reader = response.body?.getReader()
      if (!reader) throw new Error('The activity stream ended before it started.')
      expectDataWithin(idleTimeoutMs)
      connected = true
      options.onConnection({ kind: 'connected' })

      const decoder = new TextDecoder()
      let remainder = ''
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        // Backoff resets on data, not on headers: something that accepts the
        // request and hangs up at once must not be retried twice a second.
        attempt = 0
        expectDataWithin(idleTimeoutMs)
        const parsed = parseSseFrames(remainder + decoder.decode(next.value, { stream: true }))
        remainder = parsed.remainder
        for (const frame of parsed.frames) {
          const event = toActivityEvent(frame)
          if (!event) continue
          lastEventId = event.id
          if (seen.has(event.id)) continue
          seen.add(event.id)
          if (seen.size > SEEN_EVENT_LIMIT) {
            const oldest = seen.values().next().value
            if (oldest !== undefined) seen.delete(oldest)
          }
          options.onEvent(event)
        }
      }
      // The API ended the stream (a restart or deploy); come back quickly.
      attempt = Math.max(1, attempt + 1)
    } catch (error) {
      if (options.signal.aborted) break
      if (isFatal(error)) {
        options.onError(error)
        return
      }
      // A stream that went quiet is reported by the reconnect itself.
      if (stalled && !connected) {
        options.onError(
          new Error(
            `${api.origin} did not answer within ${Math.round(connectTimeoutMs / 1_000)} s.`,
          ),
        )
      } else if (!stalled) {
        options.onError(error instanceof Error ? error : new Error('Activity connection failed.'))
      }
      attempt = Math.max(1, attempt + 1)
    } finally {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', cancel)
      connection.abort()
    }
  }
}
