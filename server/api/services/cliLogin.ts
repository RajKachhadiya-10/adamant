import { timingSafeEqual } from 'node:crypto'

export type CliLoginRecord = {
  loginId: string
  pollSecret: string
  state: string
  expiresAt: number
}

export type CliLoginTake =
  { status: 'pending' } | { status: 'missing' } | { status: 'ready'; token: string }

export type CliLoginStore = {
  put(record: CliLoginRecord): void
  begin(loginId: string): { state: string } | undefined
  /** Remember the Adamant session token until the CLI reads it once. */
  complete(state: string, token: string): boolean
  take(loginId: string, pollSecret: string): CliLoginTake
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The browser callback can only set an HttpOnly cookie. This map holds the
 * Adamant session token in memory until the CLI that started the login reads
 * it, then deletes it. It is not written to Postgres, and it never holds a
 * GitHub access token.
 */
export function createCliLoginStore(now: () => number = Date.now): CliLoginStore {
  const byId = new Map<string, CliLoginRecord & { token?: string }>()
  const byState = new Map<string, string>()

  const drop = (record: CliLoginRecord) => {
    byId.delete(record.loginId)
    byState.delete(record.state)
  }

  const sweep = () => {
    const time = now()
    for (const record of byId.values()) {
      if (record.expiresAt <= time) drop(record)
    }
  }

  return {
    put(record) {
      sweep()
      byId.set(record.loginId, { ...record })
      byState.set(record.state, record.loginId)
    },
    begin(loginId) {
      sweep()
      const record = byId.get(loginId)
      if (!record) return undefined
      return { state: record.state }
    },
    complete(state, token) {
      sweep()
      const loginId = byState.get(state)
      const record = loginId ? byId.get(loginId) : undefined
      if (!record || record.token) return false
      record.token = token
      return true
    },
    take(loginId, pollSecret) {
      sweep()
      const record = byId.get(loginId)
      if (!record || !safeEqual(record.pollSecret, pollSecret)) return { status: 'missing' }
      if (!record.token) return { status: 'pending' }
      const token = record.token
      drop(record)
      return { status: 'ready', token }
    },
  }
}
