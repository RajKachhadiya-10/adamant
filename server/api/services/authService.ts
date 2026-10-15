import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm'

import { type Db } from '../../db/client.ts'
import { oauthStates, sessions, userIdentities, users } from '../../db/schema/index.ts'
import { deleteExpiredCliLogins } from './cliLogin.ts'

export type OAuthProvider = 'github' | 'google'

export type OAuthIdentityInput = {
  provider: OAuthProvider
  providerUserId: string
  email?: string
  username: string
}

export type AuthenticatedSession = {
  sessionId: string
  userId: string
}

/**
 * A verified provider email that already belongs to another Adamant user who
 * cannot be shown to own it too. Linking would hand that account to whoever
 * controls the email at this provider today.
 */
export class OAuthAccountConflictError extends Error {
  constructor() {
    super('The email belongs to another Adamant account')
  }
}

// `last_used_at` is for spotting stale sessions, not an access log. Writing it
// on every request turned each authenticated read into a row update.
const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

function generateOAuthState(): string {
  return randomBytes(32).toString('base64url')
}

function generateUsername(provider: OAuthProvider, username: string): string {
  return `${provider}_${username}`
}

/** RFC 7636 S256: base64url(SHA-256(verifier)), the only method the authorize redirect sends. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * A state for one trip to the provider, with its PKCE verifier kept beside it. The
 * caller sends only the challenge; the verifier leaves this server once, in the
 * body of the code exchange, so a code stolen on the way back cannot be redeemed.
 */
export async function createOAuthState(
  db: Db,
  provider: OAuthProvider,
): Promise<{ state: string; codeChallenge: string }> {
  const state = generateOAuthState()
  // 32 random bytes are 43 base64url characters: RFC 7636's minimum length, from its alphabet.
  const codeVerifier = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

  await db.insert(oauthStates).values({
    id: randomUUID(),
    state,
    provider,
    codeVerifier,
    createdAt: new Date(),
    expiresAt,
  })

  return { state, codeChallenge: pkceChallenge(codeVerifier) }
}

/**
 * Spends the state in one delete. Its PKCE verifier, or undefined when the state
 * was unknown, expired, another provider's, already spent, or issued before PKCE
 * (which is spent all the same, but cannot be exchanged).
 */
export async function consumeOAuthState(
  db: Db,
  provider: OAuthProvider,
  state: string,
): Promise<{ codeVerifier: string } | undefined> {
  const deleted = await db
    .delete(oauthStates)
    .where(
      and(
        eq(oauthStates.state, state),
        eq(oauthStates.provider, provider),
        gt(oauthStates.expiresAt, sql`now()`),
      ),
    )
    .returning({ codeVerifier: oauthStates.codeVerifier })

  const codeVerifier = deleted[0]?.codeVerifier
  return codeVerifier ? { codeVerifier } : undefined
}

/**
 * One batch of expired sign-in state: OAuth states and terminal logins. Both ride
 * the worker's hourly `cleanup_oauth_states` task, which repeats this while it
 * returns a full batch; the sum is a full batch whenever either table had one.
 */
export async function deleteExpiredOAuthStates(db: Db): Promise<number> {
  const [states, logins] = await Promise.all([
    deleteExpiredOAuthStateRows(db),
    deleteExpiredCliLogins(db),
  ])
  return states + logins
}

async function deleteExpiredOAuthStateRows(db: Db): Promise<number> {
  const result = await db.execute(sql`
    with expired as (
      select id
      from oauth_states
      where expires_at < now()
      order by expires_at
      limit 1000
    )
    delete from oauth_states
    using expired
    where oauth_states.id = expired.id
  `)
  return result.rowCount ?? 0
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

function identityMatches(input: OAuthIdentityInput) {
  return and(
    eq(userIdentities.provider, input.provider),
    eq(userIdentities.providerUserId, input.providerUserId),
  )
}

async function findIdentityUser(tx: Tx, input: OAuthIdentityInput): Promise<string | undefined> {
  const rows = await tx
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(identityMatches(input))
    .limit(1)
  return rows[0]?.userId
}

/**
 * The user who holds `email`, and whether this sign-in may join them. It may
 * only when another provider also reports the address as verified for that
 * user today: `users.email` is a snapshot from sign-up, and a mailbox can
 * change hands (a reassigned work address, a re-registered domain). The same
 * provider under a new account id is exactly that case, so it never links.
 */
async function findEmailOwner(
  tx: Tx,
  input: OAuthIdentityInput,
  email: string,
): Promise<{ userId: string; linkable: boolean } | undefined> {
  const owners = await tx
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1)
  const owner = owners[0]
  if (!owner) return undefined

  const vouching = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, owner.id),
        ne(userIdentities.provider, input.provider),
        sql`lower(${userIdentities.email}) = ${email}`,
      ),
    )
    .limit(1)
  return { userId: owner.id, linkable: vouching.length > 0 }
}

/** Inserts the identity for `userId`, or returns whoever a concurrent callback attached it to. */
async function attachIdentity(
  tx: Tx,
  userId: string,
  input: OAuthIdentityInput,
  email: string | undefined,
): Promise<string | undefined> {
  const inserted = await tx
    .insert(userIdentities)
    .values({
      userId,
      provider: input.provider,
      providerUserId: input.providerUserId,
      email: email ?? null,
    })
    .onConflictDoNothing({
      target: [userIdentities.provider, userIdentities.providerUserId],
    })
    .returning({ userId: userIdentities.userId })
  return inserted[0]?.userId
}

export async function upsertOAuthIdentity(
  db: Db,
  input: OAuthIdentityInput,
): Promise<{ userId: string }> {
  const normalizedEmail = input.email?.trim().toLowerCase() || undefined
  const username = generateUsername(input.provider, input.username)
  const existingIdentity = await db
    .select({
      userId: userIdentities.userId,
    })
    .from(userIdentities)
    .where(identityMatches(input))
    .limit(1)

  const identity = existingIdentity[0]

  if (identity) {
    await db
      .update(userIdentities)
      .set({
        email: normalizedEmail ?? null,
        updatedAt: new Date(),
      })
      .where(identityMatches(input))

    // A renamed GitHub login is the same account (the id is stable). Only a
    // username this provider generated follows it, so a GitHub sign-in does
    // not rename an account whose name came from Google, and the reverse.
    await db
      .update(users)
      .set({ username, updatedAt: new Date() })
      .where(
        and(
          eq(users.id, identity.userId),
          sql`starts_with(${users.username}, ${`${input.provider}_`})`,
          ne(users.username, username),
        ),
      )

    return { userId: identity.userId }
  }

  return db.transaction(async (tx) => {
    if (normalizedEmail) {
      const owner = await findEmailOwner(tx, input, normalizedEmail)
      if (owner) {
        if (!owner.linkable) throw new OAuthAccountConflictError()
        const userId =
          (await attachIdentity(tx, owner.userId, input, normalizedEmail)) ??
          (await findIdentityUser(tx, input))
        if (!userId) throw new Error('Failed to create or find OAuth identity')
        return { userId }
      }
    }

    const createdUser = await tx
      .insert(users)
      .values({
        username,
        email: normalizedEmail ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: users.id })
    const createdUserId = createdUser[0]?.id

    if (!createdUserId) {
      // Only the email index conflicts here: a concurrent sign-in claimed the
      // address after the lookup above. It may be this very identity; if not,
      // the same linking rule applies to whoever won.
      const winner = await findIdentityUser(tx, input)
      if (winner) return { userId: winner }
      const owner = normalizedEmail && (await findEmailOwner(tx, input, normalizedEmail))
      if (!owner) throw new Error('Failed to create or find Adamant user')
      if (!owner.linkable) throw new OAuthAccountConflictError()
      const userId = await attachIdentity(tx, owner.userId, input, normalizedEmail)
      if (!userId) throw new Error('Failed to create or find OAuth identity')
      return { userId }
    }

    const insertedUserId = await attachIdentity(tx, createdUserId, input, normalizedEmail)
    if (insertedUserId) {
      return { userId: insertedUserId }
    }

    await tx.delete(users).where(eq(users.id, createdUserId))

    const winningUserId = await findIdentityUser(tx, input)
    if (!winningUserId) {
      throw new Error('Failed to create or find OAuth identity')
    }

    return { userId: winningUserId }
  })
}

export async function createSession(
  db: Db,
  userId: string,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = generateSessionToken()
  const tokenHash = hashSessionToken(token)

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const createdSession = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash,
      expiresAt,
    })
    .returning({
      id: sessions.id,
    })

  const session = createdSession[0]

  if (!session) {
    throw new Error('Failed to create session')
  }

  return {
    token,
    sessionId: session.id,
    expiresAt,
  }
}

export async function authenticateSession(
  db: Db,
  token: string,
): Promise<AuthenticatedSession | null> {
  const tokenHash = hashSessionToken(token)

  const result = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      revokedAt: sessions.revokedAt,
      expiresAt: sessions.expiresAt,
      lastUsedAt: sessions.lastUsedAt,
    })
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1)

  const session = result[0]

  if (!session) {
    return null
  }

  if (session.revokedAt) {
    return null
  }

  // Valid while expires_at > now(), so the expiry instant itself is already out.
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    return null
  }

  const lastUsed = session.lastUsedAt ? new Date(session.lastUsedAt).getTime() : 0
  if (Date.now() - lastUsed >= LAST_USED_RESOLUTION_MS) {
    await db
      .update(sessions)
      .set({
        lastUsedAt: new Date(),
      })
      .where(eq(sessions.id, session.sessionId))
  }

  return {
    sessionId: session.sessionId,
    userId: session.userId,
  }
}

/**
 * Revokes the one session this token names and no other session of its user.
 * `revoked_at IS NULL` keeps the first revocation time when logout is repeated.
 */
export async function revokeSessionToken(db: Db, token: string): Promise<boolean> {
  const revoked = await db
    .update(sessions)
    .set({
      revokedAt: new Date(),
    })
    .where(and(eq(sessions.tokenHash, hashSessionToken(token)), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id })
  return revoked.length > 0
}

export async function getUserAuthInfo(
  db: Db,
  userId: string,
): Promise<{
  id: string
  username: string
  email: string | null
  providers: OAuthProvider[]
} | null> {
  const userResult = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const user = userResult[0]

  if (!user) {
    return null
  }

  const identities = await db
    .select({
      provider: userIdentities.provider,
    })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))

  const providers = identities
    .map((identity) => identity.provider)
    .filter((provider): provider is OAuthProvider => provider === 'github' || provider === 'google')

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    providers,
  }
}
