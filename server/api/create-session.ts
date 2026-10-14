import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { asc, eq } from 'drizzle-orm'

import { createDb, users, type Db } from '../db/client.ts'
import { createSession } from './services/authService.ts'

/**
 * Mints a session for `adamant` against a Postgres-backed API. OAuth hands its
 * session to a browser as an HttpOnly cookie a terminal cannot read, and the
 * seeded ADAMANT_SESSION_SECRET applies only without a database, so without
 * this the CLI had no way in. The token is printed once; Postgres keeps only
 * its hash, it expires like an OAuth session, and POST /auth/logout revokes it.
 *
 *   export ADAMANT_SESSION=$(pnpm --silent --filter @adamant/server session:create)
 */
export async function createCliSession(
  db: Db,
  username: string,
): Promise<{ userId: string; token: string; expiresAt: Date }> {
  // `username` is not unique, so reuse the oldest match rather than adding a
  // user per session.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .orderBy(asc(users.createdAt))
    .limit(1)
  const userId =
    existing[0]?.id ??
    (await db.insert(users).values({ username }).returning({ id: users.id }))[0]?.id
  if (!userId) throw new Error(`Could not create the user ${username}`)

  const { token, expiresAt } = await createSession(db, userId)
  return { userId, token, expiresAt }
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required to create a session')

  const username = process.argv[2]?.trim() || 'cli'
  const db = createDb(url)
  try {
    const { userId, token, expiresAt } = await createCliSession(db, username)
    // Only the token goes to stdout, so `$(...)` captures it alone.
    process.stdout.write(`${token}\n`)
    process.stderr.write(
      `Session for ${username} (${userId}) until ${expiresAt.toISOString()}. Set it as ADAMANT_SESSION.\n`,
    )
  } finally {
    await db.$client.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
