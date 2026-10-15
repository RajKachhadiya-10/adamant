import { createHash, randomInt } from 'node:crypto'

import { CLI_LOGIN_CODE_ALPHABET } from '@adamant/contract'
import { and, eq, gt, sql } from 'drizzle-orm'

import { type Db } from '../../db/client.ts'
import { cliLogins } from '../../db/schema/index.ts'

export type CliLoginStatus = 'pending' | 'authorized' | 'confirmed' | 'consumed' | 'cancelled'

export type NewCliLogin = {
  loginId: string
  pollSecret: string
  userCode: string
  expiresAt: Date
}

export type CliLoginTake =
  | { status: 'pending' }
  | { status: 'cancelled' }
  | { status: 'missing' }
  | { status: 'ready'; userId: string }

export type CliLoginDecision = 'confirm' | 'cancel'

/**
 * A terminal sign-in's state machine (see server/db/schema/cliLogins.ts). Every
 * step is one conditional write, so a step taken twice, late or out of order
 * changes nothing, and the session it leads to is minted by whoever wins `take`.
 */
export type CliLoginStore = {
  /** False when too many logins are already waiting. */
  create(login: NewCliLogin): Promise<boolean>
  /** Points a pending login at the OAuth state its browser is about to use. The latest wins. */
  bind(loginId: string, state: string): Promise<boolean>
  /**
   * After GitHub names the user: pending -> authorized, confirmable only with
   * `confirmSecret`. The code to show, or undefined when no live login waits on `state`.
   */
  authorize(
    state: string,
    userId: string,
    confirmSecret: string,
  ): Promise<{ userCode: string } | undefined>
  /** The code of the authorized login `confirmSecret` names, while it waits for a decision. */
  awaiting(confirmSecret: string): Promise<{ userCode: string } | undefined>
  /** authorized -> confirmed or cancelled. False when nothing was waiting. */
  decide(confirmSecret: string, decision: CliLoginDecision): Promise<boolean>
  /** Ends a pending login whose browser side failed, so its next poll stops at once. */
  cancel(state: string): Promise<void>
  /** confirmed -> consumed for exactly one caller, who then mints the session. */
  take(loginId: string, pollSecret: string): Promise<CliLoginTake>
}

const CODE_LENGTH = 8

/** XXXX-XXXX from CLI_LOGIN_CODE_ALPHABET; `randomInt` draws without modulo bias. */
export function generateUserCode(): string {
  const letters = Array.from(
    { length: CODE_LENGTH },
    () => CLI_LOGIN_CODE_ALPHABET[randomInt(CLI_LOGIN_CODE_ALPHABET.length)] ?? '',
  ).join('')
  return `${letters.slice(0, 4)}-${letters.slice(4)}`
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** What a poll with the right secret learns about a login that is not ready. */
function pollStatus(status: string): CliLoginTake {
  if (status === 'pending' || status === 'authorized') return { status: 'pending' }
  if (status === 'cancelled') return { status: 'cancelled' }
  return { status: 'missing' }
}

// The memory store needs no session to grow, so it is bounded: past this, a flood
// of starts is refused rather than allowed to grow the heap for 15 minutes each.
const MAX_PENDING_LOGINS = 10_000

type MemoryLogin = {
  pollSecretHash: string
  userCode: string
  stateHash?: string
  confirmHash?: string
  status: CliLoginStatus
  userId?: string
  expiresAt: number
}

/**
 * The same state machine in this process, for tests. It keeps the same hashes the
 * Postgres store does, and like any in-memory store it forgets every login on
 * restart and is not shared between instances.
 */
export function createMemoryCliLoginStore(
  now: () => number = Date.now,
  maxPending: number = MAX_PENDING_LOGINS,
): CliLoginStore {
  const logins = new Map<string, MemoryLogin>()

  const live = () => {
    const time = now()
    for (const [key, login] of logins) {
      if (login.expiresAt <= time) logins.delete(key)
    }
    return logins
  }
  const find = (match: (login: MemoryLogin) => boolean) => [...live().values()].find(match)

  return {
    async create(login) {
      if (live().size >= maxPending) return false
      logins.set(digest(login.loginId), {
        pollSecretHash: digest(login.pollSecret),
        userCode: login.userCode,
        status: 'pending',
        expiresAt: login.expiresAt.getTime(),
      })
      return true
    },
    async bind(loginId, state) {
      const login = live().get(digest(loginId))
      if (login?.status !== 'pending') return false
      login.stateHash = digest(state)
      return true
    },
    async authorize(state, userId, confirmSecret) {
      const stateHash = digest(state)
      const login = find((entry) => entry.stateHash === stateHash && entry.status === 'pending')
      if (!login) return undefined
      Object.assign(login, { status: 'authorized', userId, confirmHash: digest(confirmSecret) })
      return { userCode: login.userCode }
    },
    async awaiting(confirmSecret) {
      const confirmHash = digest(confirmSecret)
      const login = find(
        (entry) => entry.confirmHash === confirmHash && entry.status === 'authorized',
      )
      return login ? { userCode: login.userCode } : undefined
    },
    async decide(confirmSecret, decision) {
      const confirmHash = digest(confirmSecret)
      const login = find(
        (entry) => entry.confirmHash === confirmHash && entry.status === 'authorized',
      )
      if (!login) return false
      login.status = decision === 'confirm' ? 'confirmed' : 'cancelled'
      return true
    },
    async cancel(state) {
      const stateHash = digest(state)
      const login = find((entry) => entry.stateHash === stateHash && entry.status === 'pending')
      if (login) login.status = 'cancelled'
    },
    async take(loginId, pollSecret) {
      const login = live().get(digest(loginId))
      if (!login || login.pollSecretHash !== digest(pollSecret)) return { status: 'missing' }
      if (login.status !== 'confirmed' || !login.userId) return pollStatus(login.status)
      login.status = 'consumed'
      return { status: 'ready', userId: login.userId }
    },
  }
}

export function createPostgresCliLoginStore(db: Db): CliLoginStore {
  const unexpired = gt(cliLogins.expiresAt, sql`now()`)

  return {
    async create(login) {
      await db.insert(cliLogins).values({
        loginIdHash: digest(login.loginId),
        pollSecretHash: digest(login.pollSecret),
        userCode: login.userCode,
        expiresAt: login.expiresAt,
      })
      // Bounded by the start route's rate limit and the hourly cleanup, not a count.
      return true
    },
    async bind(loginId, state) {
      const bound = await db
        .update(cliLogins)
        .set({ stateHash: digest(state) })
        .where(
          and(
            eq(cliLogins.loginIdHash, digest(loginId)),
            eq(cliLogins.status, 'pending'),
            unexpired,
          ),
        )
        .returning({ id: cliLogins.id })
      return bound.length > 0
    },
    async authorize(state, userId, confirmSecret) {
      const authorized = await db
        .update(cliLogins)
        .set({ status: 'authorized', userId, confirmHash: digest(confirmSecret) })
        .where(
          and(eq(cliLogins.stateHash, digest(state)), eq(cliLogins.status, 'pending'), unexpired),
        )
        .returning({ userCode: cliLogins.userCode })
      return authorized[0]
    },
    async awaiting(confirmSecret) {
      const rows = await db
        .select({ userCode: cliLogins.userCode })
        .from(cliLogins)
        .where(
          and(
            eq(cliLogins.confirmHash, digest(confirmSecret)),
            eq(cliLogins.status, 'authorized'),
            unexpired,
          ),
        )
        .limit(1)
      return rows[0]
    },
    async decide(confirmSecret, decision) {
      const decided = await db
        .update(cliLogins)
        .set({ status: decision === 'confirm' ? 'confirmed' : 'cancelled' })
        .where(
          and(
            eq(cliLogins.confirmHash, digest(confirmSecret)),
            eq(cliLogins.status, 'authorized'),
            unexpired,
          ),
        )
        .returning({ id: cliLogins.id })
      return decided.length > 0
    },
    async cancel(state) {
      await db
        .update(cliLogins)
        .set({ status: 'cancelled' })
        .where(and(eq(cliLogins.stateHash, digest(state)), eq(cliLogins.status, 'pending')))
    },
    async take(loginId, pollSecret) {
      const owned = and(
        eq(cliLogins.loginIdHash, digest(loginId)),
        eq(cliLogins.pollSecretHash, digest(pollSecret)),
        unexpired,
      )
      // The database decides who gets the session: one UPDATE moves the row out of
      // `confirmed`, and every other poll, racing or late, finds nothing to move.
      const consumed = await db
        .update(cliLogins)
        .set({ status: 'consumed' })
        .where(and(owned, eq(cliLogins.status, 'confirmed')))
        .returning({ userId: cliLogins.userId })
      const userId = consumed[0]?.userId
      if (userId) return { status: 'ready', userId }

      const rows = await db
        .select({ status: cliLogins.status })
        .from(cliLogins)
        .where(owned)
        .limit(1)
      return rows[0] ? pollStatus(rows[0].status) : { status: 'missing' }
    },
  }
}

/** One batch of expired logins, whatever their status, as the OAuth-state sweep deletes states. */
export async function deleteExpiredCliLogins(db: Db): Promise<number> {
  const result = await db.execute(sql`
    with expired as (
      select id
      from cli_logins
      where expires_at < now()
      order by expires_at
      limit 1000
    )
    delete from cli_logins
    using expired
    where cli_logins.id = expired.id
  `)
  return result.rowCount ?? 0
}
