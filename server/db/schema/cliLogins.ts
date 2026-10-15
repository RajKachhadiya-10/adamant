import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import { users } from './users.ts'

/**
 * A terminal sign-in, from `POST /auth/github/cli/start` to the one poll that
 * collects its session. In Postgres so a login survives an API restart and any
 * instance can answer any step of it.
 *
 * pending -> authorized (GitHub named the user) -> confirmed (that browser said
 * the code matches the terminal's) -> consumed (the terminal took its session).
 * pending and authorized can end cancelled. Past `expires_at` a row is dead
 * whatever its status; the hourly OAuth-state cleanup deletes it.
 *
 * Every value that carries authority is stored as its SHA-256 only: the login id
 * (it opens the browser half), the poll secret (it collects the session), the
 * OAuth state bound to the login and the browser's confirmation secret. The
 * session token is minted at the poll and never stored here.
 *
 * "Issued once" is the poll's conditional `UPDATE ... WHERE status = 'confirmed'
 * RETURNING user_id`: of any number of racing polls, one moves the row.
 */
export const cliLogins = pgTable(
  'cli_logins',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    loginIdHash: text('login_id_hash').notNull(),

    pollSecretHash: text('poll_secret_hash').notNull(),

    /** Shown in the terminal and on the confirmation page; it grants nothing alone. */
    userCode: text('user_code').notNull(),

    /** The OAuth state of the browser's latest trip to GitHub for this login. */
    stateHash: text('state_hash'),

    /** The HttpOnly cookie that lets that browser, and only it, confirm or cancel. */
    confirmHash: text('confirm_hash'),

    status: text('status').notNull().default('pending'),

    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('cli_logins_login_id_hash_uidx').on(table.loginIdHash),
    uniqueIndex('cli_logins_state_hash_uidx').on(table.stateHash),
    uniqueIndex('cli_logins_confirm_hash_uidx').on(table.confirmHash),
    index('cli_logins_expires_at_idx').on(table.expiresAt),
    check(
      'cli_logins_status_check',
      sql`${table.status} in ('pending', 'authorized', 'confirmed', 'consumed', 'cancelled')`,
    ),
    // A login past GitHub always knows whose session it may become.
    check(
      'cli_logins_user_check',
      sql`${table.status} in ('pending', 'cancelled') or ${table.userId} is not null`,
    ),
  ],
)
