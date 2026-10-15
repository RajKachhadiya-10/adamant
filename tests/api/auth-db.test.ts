import assert from 'node:assert/strict'
import { randomBytes, randomInt } from 'node:crypto'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

import { createAuthRoute } from '../../server/api/routes/auth.ts'
import {
  authenticateSession,
  consumeOAuthState,
  createOAuthState,
  createSession,
  deleteExpiredOAuthStates,
  getUserAuthInfo,
  OAuthAccountConflictError,
  pkceChallenge,
  revokeSessionToken,
  upsertOAuthIdentity,
} from '../../server/api/services/authService.ts'
import {
  createPostgresCliLoginStore,
  generateUserCode,
  type CliLoginStore,
} from '../../server/api/services/cliLogin.ts'
import {
  cliLogins,
  createDb,
  oauthStates,
  sessions,
  userIdentities,
  users,
  type Db,
} from '../../server/db/client.ts'
import { cliLoginStoreContract } from './cli-login-store-contract.ts'
import {
  cliBrowser,
  cookieValue,
  formToken,
  github,
  GITHUB_EMAILS_URL,
  GITHUB_USER_URL,
  githubProvider,
  google,
  GOOGLE_USER_URL,
  googleProvider,
  sha256,
} from './auth-fakes.ts'

/**
 * The SQL half of auth: hashing, expiry, cascades, single-use state, the
 * case-insensitive email index and account linking. Runs only when
 * ADAMANT_TEST_DATABASE_URL names a scratch database, which it migrates and
 * writes to. Its rows carry this run's tag and are deleted afterwards, but
 * never point it at a database whose data matters.
 */
const url = process.env.ADAMANT_TEST_DATABASE_URL
const tag = `authtest${randomBytes(4).toString('hex')}`
const email = (name: string) => `${tag}-${name}@example.com`

function uniqueViolation(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ((cause as { code?: unknown }).code === '23505') return true
  }
  return false
}

describe('auth on Postgres', { skip: url ? false : 'ADAMANT_TEST_DATABASE_URL is not set' }, () => {
  let database: Db | undefined
  const issuedStates: string[] = []
  const issuedLogins: string[] = []
  const db = () => {
    if (!database) throw new Error('The database is not open')
    return database
  }

  before(async () => {
    database = createDb(url ?? '')
    await migrate(database, {
      migrationsFolder: path.resolve(import.meta.dirname, '../../server/db/drizzle'),
    })
  })

  after(async () => {
    if (!database) return
    // Identities and sessions go with their users (on delete cascade).
    await database.delete(users).where(like(users.username, `%${tag}%`))
    await database.delete(users).where(like(users.email, `${tag}-%`))
    if (issuedStates.length > 0) {
      await database.delete(oauthStates).where(inArray(oauthStates.state, issuedStates))
    }
    if (issuedLogins.length > 0) {
      await database
        .delete(cliLogins)
        .where(inArray(cliLogins.loginIdHash, issuedLogins.map(sha256)))
    }
    await database.$client.end()
  })

  async function addUser(name: string, address?: string): Promise<string> {
    const [row] = await db()
      .insert(users)
      .values({ username: `${name}-${tag}`, email: address ?? null })
      .returning({ id: users.id })
    if (!row) throw new Error('No user was created')
    return row.id
  }

  async function issueState(provider: 'github' | 'google') {
    const { state } = await createOAuthState(db(), provider)
    issuedStates.push(state)
    return state
  }

  /** The Postgres store, remembering every login it starts so `after` can delete it. */
  function loginStore(): CliLoginStore {
    const store = createPostgresCliLoginStore(db())
    return {
      ...store,
      create: async (login) => {
        issuedLogins.push(login.loginId)
        return store.create(login)
      },
    }
  }

  describe('sessions', () => {
    it('stores only the hash, and a token works until it expires or is revoked', async () => {
      const userId = await addUser('cli')
      const { token, sessionId } = await createSession(db(), userId)
      const [row] = await db().select().from(sessions).where(eq(sessions.id, sessionId))

      assert.equal(row?.tokenHash, sha256(token))
      assert.equal(JSON.stringify(row).includes(token), false)
      assert.deepEqual(await authenticateSession(db(), token), { sessionId, userId })
      const [used] = await db().select().from(sessions).where(eq(sessions.id, sessionId))
      assert.ok(used?.lastUsedAt instanceof Date)

      await db()
        .update(sessions)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(sessions.id, sessionId))
      assert.equal(await authenticateSession(db(), token), null)

      const second = await createSession(db(), userId)
      assert.equal(await revokeSessionToken(db(), second.token), true)
      assert.equal(await revokeSessionToken(db(), second.token), false)
      assert.equal(await authenticateSession(db(), second.token), null)
    })

    it('refuses the session of a deleted user', async () => {
      const userId = await addUser('gone')
      const { token, sessionId } = await createSession(db(), userId)

      await db().delete(users).where(eq(users.id, userId))

      assert.equal(await authenticateSession(db(), token), null)
      assert.deepEqual(await db().select().from(sessions).where(eq(sessions.id, sessionId)), [])
      assert.equal(await getUserAuthInfo(db(), userId), null)
    })

    it('keeps one user per email whatever its case', async () => {
      await addUser('case', `${tag}-Case@Example.com`)

      await assert.rejects(addUser('case-again', `${tag}-case@example.COM`), uniqueViolation)
    })
  })

  describe('OAuth state', () => {
    it('is spent once, only by its own provider, only before it expires', async () => {
      const state = await issueState('github')

      assert.equal(await consumeOAuthState(db(), 'google', state), undefined)
      assert.ok(await consumeOAuthState(db(), 'github', state))
      assert.equal(await consumeOAuthState(db(), 'github', state), undefined)
      assert.equal(await consumeOAuthState(db(), 'github', `${tag}-never-issued`), undefined)

      const expired = await issueState('github')
      await db()
        .update(oauthStates)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(oauthStates.state, expired))
      assert.equal(await consumeOAuthState(db(), 'github', expired), undefined)
    })

    it('keeps the PKCE verifier beside the state and hands it back once', async () => {
      const { state, codeChallenge } = await createOAuthState(db(), 'google')
      issuedStates.push(state)
      const [row] = await db().select().from(oauthStates).where(eq(oauthStates.state, state))

      assert.match(row?.codeVerifier ?? '', /^[A-Za-z0-9_-]{43}$/)
      assert.equal(codeChallenge, pkceChallenge(row?.codeVerifier ?? ''))
      assert.deepEqual(await consumeOAuthState(db(), 'google', state), {
        codeVerifier: row?.codeVerifier,
      })
      assert.equal(await consumeOAuthState(db(), 'google', state), undefined)
    })

    it('spends but refuses a state issued before PKCE', async () => {
      const state = `${tag}-pre-pkce`
      issuedStates.push(state)
      await db()
        .insert(oauthStates)
        .values({ state, provider: 'github', expiresAt: sql`now() + interval '1 minute'` })

      assert.equal(await consumeOAuthState(db(), 'github', state), undefined)
      assert.deepEqual(
        await db().select().from(oauthStates).where(eq(oauthStates.state, state)),
        [],
      )
    })

    it('is spent by exactly one of several racing callbacks', async () => {
      const state = await issueState('google')

      const spent = await Promise.all(
        Array.from({ length: 6 }, () => consumeOAuthState(db(), 'google', state)),
      )

      assert.equal(spent.filter((claim) => claim !== undefined).length, 1)
    })

    it('cleans up expired states and leaves live ones', async () => {
      const expired = await issueState('github')
      const live = await issueState('google')
      await db()
        .update(oauthStates)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(oauthStates.state, expired))

      assert.ok((await deleteExpiredOAuthStates(db())) >= 1)
      const left = await db()
        .select({ state: oauthStates.state })
        .from(oauthStates)
        .where(inArray(oauthStates.state, [expired, live]))
      assert.deepEqual(
        left.map((row) => row.state),
        [live],
      )
    })
  })

  describe('CLI login store', () => {
    cliLoginStoreContract(async () => ({
      store: loginStore(),
      now: Date.now,
      user: () => addUser(`cli-${randomInt(1, 2 ** 31)}`),
      expire: async (loginId) => {
        await db()
          .update(cliLogins)
          .set({ expiresAt: sql`now() - interval '1 second'` })
          .where(eq(cliLogins.loginIdHash, sha256(loginId)))
      },
    }))

    it('stores hashes of every value that carries authority, never the values', async () => {
      const store = loginStore()
      const secret = () => randomBytes(32).toString('base64url')
      const [loginId, pollSecret, state, confirm] = [secret(), secret(), secret(), secret()]
      const userCode = generateUserCode()
      await store.create({
        loginId,
        pollSecret,
        userCode,
        expiresAt: new Date(Date.now() + 60_000),
      })
      await store.bind(loginId, state)
      await store.authorize(state, await addUser('hashes'), confirm)

      const [row] = await db()
        .select()
        .from(cliLogins)
        .where(eq(cliLogins.loginIdHash, sha256(loginId)))
      assert.equal(row?.pollSecretHash, sha256(pollSecret))
      assert.equal(row?.stateHash, sha256(state))
      assert.equal(row?.confirmHash, sha256(confirm))
      assert.equal(row?.userCode, userCode)
      assert.equal(row?.status, 'authorized')
      for (const value of [loginId, pollSecret, state, confirm]) {
        assert.equal(JSON.stringify(row).includes(value), false)
      }
    })

    it('refuses a status outside the state machine, and a named status with no user', async () => {
      const row = (status: string) => ({
        loginIdHash: sha256(`${tag}-${randomInt(1, 2 ** 31)}`),
        pollSecretHash: 'x',
        userCode: 'BBBB-BBBB',
        status,
        expiresAt: new Date(Date.now() + 60_000),
      })

      await assert.rejects(db().insert(cliLogins).values(row('approved')))
      await assert.rejects(db().insert(cliLogins).values(row('confirmed')))
    })

    it('loses a login with its user', async () => {
      const store = loginStore()
      const secret = () => randomBytes(32).toString('base64url')
      const [loginId, pollSecret, state, confirm] = [secret(), secret(), secret(), secret()]
      const userId = await addUser('leaving')
      await store.create({
        loginId,
        pollSecret,
        userCode: generateUserCode(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      await store.bind(loginId, state)
      await store.authorize(state, userId, confirm)
      await store.decide(confirm, 'confirm')

      await db().delete(users).where(eq(users.id, userId))

      assert.deepEqual(await store.take(loginId, pollSecret), { status: 'missing' })
    })

    it('is swept with expired OAuth states, live ones left alone', async () => {
      const store = loginStore()
      const secret = () => randomBytes(32).toString('base64url')
      const [expired, live] = [secret(), secret()]
      for (const loginId of [expired, live]) {
        await store.create({
          loginId,
          pollSecret: secret(),
          userCode: generateUserCode(),
          expiresAt: new Date(Date.now() + 60_000),
        })
      }
      await db()
        .update(cliLogins)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(cliLogins.loginIdHash, sha256(expired)))

      assert.ok((await deleteExpiredOAuthStates(db())) >= 1)
      const left = await db()
        .select({ loginIdHash: cliLogins.loginIdHash })
        .from(cliLogins)
        .where(inArray(cliLogins.loginIdHash, [sha256(expired), sha256(live)]))
      assert.deepEqual(
        left.map((row) => row.loginIdHash),
        [sha256(live)],
      )
    })
  })

  describe('identities and linking', () => {
    const githubId = () => `${tag}-${randomInt(1, 2 ** 31)}`

    async function identitiesOf(userId: string) {
      return db()
        .select({ provider: userIdentities.provider, email: userIdentities.email })
        .from(userIdentities)
        .where(eq(userIdentities.userId, userId))
        .orderBy(userIdentities.provider)
    }

    it('creates a GitHub user with no email, and follows a renamed login', async () => {
      const providerUserId = githubId()
      const first = await upsertOAuthIdentity(db(), {
        provider: 'github',
        providerUserId,
        username: `octo-${tag}`,
      })
      const renamed = await upsertOAuthIdentity(db(), {
        provider: 'github',
        providerUserId,
        username: `renamed-${tag}`,
      })

      assert.equal(renamed.userId, first.userId)
      assert.deepEqual(await getUserAuthInfo(db(), first.userId), {
        id: first.userId,
        username: `github_renamed-${tag}`,
        email: null,
        providers: ['github'],
      })
      const owners = await db()
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.providerUserId, providerUserId))
      assert.equal(owners.length, 1)
      assert.deepEqual(
        await db()
          .select()
          .from(users)
          .where(like(users.username, `%octo-${tag}`)),
        [],
      )
    })

    it('links Google to a GitHub account when both verify the same email, in any case', async () => {
      const address = email('alice')
      const { userId } = await upsertOAuthIdentity(db(), {
        provider: 'github',
        providerUserId: githubId(),
        username: `alice-${tag}`,
        email: address,
      })

      const linked = await upsertOAuthIdentity(db(), {
        provider: 'google',
        providerUserId: githubId(),
        username: `Alice ${tag}`,
        email: address.toUpperCase(),
      })

      assert.equal(linked.userId, userId)
      assert.deepEqual(await identitiesOf(userId), [
        { provider: 'github', email: address },
        { provider: 'google', email: address },
      ])
    })

    it('does not let a GitHub rename overwrite a name that came from Google', async () => {
      const address = email('mixed')
      const { userId } = await upsertOAuthIdentity(db(), {
        provider: 'google',
        providerUserId: githubId(),
        username: `Mixed ${tag}`,
        email: address,
      })
      const providerUserId = githubId()
      for (const login of [`mixed-${tag}`, `mixed-renamed-${tag}`]) {
        const linked = await upsertOAuthIdentity(db(), {
          provider: 'github',
          providerUserId,
          username: login,
          email: address,
        })
        assert.equal(linked.userId, userId)
      }

      assert.equal((await getUserAuthInfo(db(), userId))?.username, `google_Mixed ${tag}`)
    })

    it('refuses to link once GitHub no longer vouches for the email (takeover attempt)', async () => {
      const address = email('bob')
      const providerUserId = githubId()
      const { userId } = await upsertOAuthIdentity(db(), {
        provider: 'github',
        providerUserId,
        username: `bob-${tag}`,
        email: address,
      })
      // Bob moved his GitHub account off the address; someone else now holds it.
      await upsertOAuthIdentity(db(), {
        provider: 'github',
        providerUserId,
        username: `bob-${tag}`,
      })

      await assert.rejects(
        upsertOAuthIdentity(db(), {
          provider: 'google',
          providerUserId: githubId(),
          username: `Mallory ${tag}`,
          email: address,
        }),
        OAuthAccountConflictError,
      )
      assert.deepEqual(await identitiesOf(userId), [{ provider: 'github', email: null }])
    })

    it('refuses to link an email that no provider vouches for on the account', async () => {
      await addUser('seeded', email('seeded'))

      await assert.rejects(
        upsertOAuthIdentity(db(), {
          provider: 'google',
          providerUserId: githubId(),
          username: `Seeded ${tag}`,
          email: email('seeded'),
        }),
        OAuthAccountConflictError,
      )
    })

    it('refuses a second account at the same provider for the same email', async () => {
      const address = email('reused')
      await upsertOAuthIdentity(db(), {
        provider: 'google',
        providerUserId: githubId(),
        username: `First ${tag}`,
        email: address,
      })

      await assert.rejects(
        upsertOAuthIdentity(db(), {
          provider: 'google',
          providerUserId: githubId(),
          username: `Second ${tag}`,
          email: address,
        }),
        OAuthAccountConflictError,
      )
    })

    for (const address of [undefined, email('race')]) {
      it(`creates one user for racing first sign-ins (${address ? 'with' : 'without'} email)`, async () => {
        const providerUserId = githubId()
        const login = `race-${address ? 'mail' : 'none'}-${tag}`

        const results = await Promise.all(
          Array.from({ length: 6 }, () =>
            upsertOAuthIdentity(db(), {
              provider: 'github',
              providerUserId,
              username: login,
              ...(address ? { email: address } : {}),
            }),
          ),
        )

        assert.equal(new Set(results.map((result) => result.userId)).size, 1)
        const created = await db()
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, `github_${login}`))
        assert.equal(created.length, 1)
        const identities = await db()
          .select()
          .from(userIdentities)
          .where(
            and(
              eq(userIdentities.provider, 'github'),
              eq(userIdentities.providerUserId, providerUserId),
            ),
          )
        assert.equal(identities.length, 1)
      })
    }
  })

  describe('routes', () => {
    type Provider = 'github' | 'google'

    function profile(id: number, login: string, emails: unknown[] = []) {
      return githubProvider({
        [GITHUB_USER_URL]: () => Response.json({ id, login }),
        [GITHUB_EMAILS_URL]: () => Response.json(emails),
      })
    }

    async function signIn(
      provider: Provider,
      fetchProvider: ReturnType<typeof githubProvider>,
    ): Promise<Response> {
      const app = createAuthRoute(db(), { github, google }, { fetch: fetchProvider.fetch })
      const authorize = await app.request(`/${provider}`)
      const state = new URL(authorize.headers.get('location') ?? '').searchParams.get('state') ?? ''
      issuedStates.push(state)
      return app.request(`/${provider}/callback?code=code&state=${state}`, {
        headers: { Cookie: `adamant_oauth_${provider}_state=${state}` },
      })
    }

    const app = () => createAuthRoute(db(), { github, google })
    const me = (token: string) =>
      app().request('/me', { headers: { Authorization: `Bearer ${token}` } })
    const logout = (token: string) =>
      app().request('/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })

    it('signs in a GitHub user with no email; logout ends only that session', async () => {
      const browser = profile(randomInt(1, 2 ** 31), `browser-${tag}`)
      const first = cookieValue(await signIn('github', browser), 'adamant_session') ?? ''
      const second = cookieValue(await signIn('github', browser), 'adamant_session') ?? ''

      const shown = (await (await me(first)).json()) as { user: Record<string, unknown> }
      assert.equal(shown.user.username, `github_browser-${tag}`)
      assert.equal(shown.user.email, null)
      assert.deepEqual(shown.user.providers, ['github'])

      assert.equal((await logout(first)).status, 200)
      const [revoked] = await db()
        .select({ revokedAt: sessions.revokedAt })
        .from(sessions)
        .where(eq(sessions.tokenHash, sha256(first)))
      assert.equal((await logout(first)).status, 200)
      const [still] = await db()
        .select({ revokedAt: sessions.revokedAt })
        .from(sessions)
        .where(eq(sessions.tokenHash, sha256(first)))

      assert.ok(revoked?.revokedAt)
      assert.equal(still?.revokedAt?.getTime(), revoked.revokedAt.getTime())
      assert.equal((await me(first)).status, 401)
      assert.equal((await me(second)).status, 200)
    })

    it('runs the CLI login end to end, across instances, and issues its token once', async () => {
      // Two routers over one database stand in for two API processes (or one
      // restarted by `node --watch`): each step may land on either.
      const fetchProvider = profile(randomInt(1, 2 ** 31), `cli-${tag}`).fetch
      const [first, second] = [0, 1].map(() =>
        createAuthRoute(db(), { github }, { fetch: fetchProvider }),
      )
      if (!first || !second) throw new Error('No router')
      const started = (await (
        await first.request('/github/cli/start', { method: 'POST' })
      ).json()) as { loginId: string; pollSecret: string; beginPath: string; userCode: string }
      issuedLogins.push(started.loginId)
      const poll = (route: typeof first) =>
        route.request('/github/cli/token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ loginId: started.loginId, pollSecret: started.pollSecret }),
        })

      assert.equal((await poll(second)).status, 202)
      const signedIn = await cliBrowser(second).signIn(started.beginPath)
      issuedStates.push(signedIn.state)
      assert.equal(signedIn.callback.status, 303)
      assert.equal((await poll(first)).status, 202)

      const html = await (await cliBrowser(first).page(signedIn.cookie)).text()
      const decided = await cliBrowser(second).decide(signedIn.cookie, {
        token: formToken(html),
        action: 'confirm',
      })
      assert.ok(html.includes(started.userCode))
      assert.equal(decided.status, 200)

      const racing = await Promise.all([first, second, first, second].map(poll))
      const ready = racing.filter((response) => response.status === 200)
      assert.equal(ready.length, 1)
      const { token } = (await ready[0]?.json()) as { token: string }

      assert.equal(cookieValue(signedIn.callback, 'adamant_session'), undefined)
      assert.equal((await me(token)).status, 200)
      assert.equal((await poll(first)).status, 404)
    })

    it('gives an unverified Google email its own account beside a GitHub one', async () => {
      const address = email('carol')
      const githubLogin = await signIn(
        'github',
        profile(randomInt(1, 2 ** 31), `carol-${tag}`, [
          { email: address, verified: true, primary: true },
        ]),
      )
      const googleLogin = await signIn(
        'google',
        googleProvider({
          [GOOGLE_USER_URL]: () =>
            Response.json({ sub: `${tag}-carol`, email: address, email_verified: false }),
        }),
      )

      const carol = (await (
        await me(cookieValue(githubLogin, 'adamant_session') ?? '')
      ).json()) as { user: { id: string; providers: string[] } }
      const other = (await (
        await me(cookieValue(googleLogin, 'adamant_session') ?? '')
      ).json()) as { user: { id: string; email: string | null } }

      assert.equal(googleLogin.status, 200)
      assert.notEqual(other.user.id, carol.user.id)
      assert.equal(other.user.email, null)
      assert.deepEqual(carol.user.providers, ['github'])
    })

    it('links a verified Google email to the GitHub account that verifies it, and 409s once it stops', async () => {
      const address = email('dave')
      const githubId = randomInt(1, 2 ** 31)
      const verified = [{ email: address, verified: true, primary: true }]
      const googleProfile = (sub: string) =>
        googleProvider({
          [GOOGLE_USER_URL]: () =>
            Response.json({ sub, email: address, email_verified: true, name: `Dave ${tag}` }),
        })

      const dave = await signIn('github', profile(githubId, `dave-${tag}`, verified))
      const linked = await signIn('google', googleProfile(`${tag}-dave`))
      const shown = (await (await me(cookieValue(linked, 'adamant_session') ?? '')).json()) as {
        user: { providers: string[]; username: string }
      }

      assert.equal(dave.status, 200)
      assert.equal(linked.status, 200)
      assert.deepEqual(shown.user.providers.sort(), ['github', 'google'])
      assert.equal(shown.user.username, `github_dave-${tag}`)

      // Dave's GitHub drops the address; a new Google account claiming it must not get in.
      await signIn('github', profile(githubId, `dave-${tag}`, []))
      const takeover = await signIn('google', googleProfile(`${tag}-mallory`))

      assert.equal(takeover.status, 409)
      assert.equal(cookieValue(takeover, 'adamant_session'), undefined)
    })
  })
})
