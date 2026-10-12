import { type AdamantApi } from './api.ts'

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

function backoffDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.min(attempt, 5), 15_000)
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

export async function followActivity(
  api: AdamantApi,
  options: {
    signal: AbortSignal
    onEvent(event: ActivityEvent): void
    onConnection(state: ActivityConnectionState): void
    onError(error: Error): void
  },
): Promise<void> {
  let lastEventId: string | undefined
  let attempt = 0

  while (!options.signal.aborted) {
    options.onConnection(
      attempt === 0
        ? { kind: 'connecting' }
        : {
            kind: 'reconnecting',
            attempt,
            delayMs: backoffDelay(attempt),
          },
    )
    if (attempt > 0) await wait(backoffDelay(attempt), options.signal)
    if (options.signal.aborted) break

    try {
      const response = await api.openActivity(lastEventId, options.signal)
      options.onConnection({ kind: 'connected' })
      attempt = 0

      const reader = response.body?.getReader()
      if (!reader) throw new Error('The activity stream ended before it started.')

      const decoder = new TextDecoder()
      let remainder = ''
      while (!options.signal.aborted) {
        const next = await reader.read()
        if (next.done) break
        const parsed = parseSseFrames(remainder + decoder.decode(next.value, { stream: true }))
        remainder = parsed.remainder
        for (const frame of parsed.frames) {
          const event = toActivityEvent(frame)
          if (!event) continue
          lastEventId = event.id
          options.onEvent(event)
        }
      }
      reader.releaseLock()
      if (!options.signal.aborted) attempt = 1
    } catch (error) {
      if (options.signal.aborted) break
      options.onError(error instanceof Error ? error : new Error('Activity connection failed.'))
      attempt = Math.max(1, attempt + 1)
    }
  }
}
