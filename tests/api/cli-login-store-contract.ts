import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { it } from 'node:test'

import {
  generateUserCode,
  type CliLoginStore,
  type NewCliLogin,
} from '../../server/api/services/cliLogin.ts'

export type CliLoginStoreHarness = {
  store: CliLoginStore
  /** A user a login may be authorized for (Postgres checks the foreign key). */
  user: () => Promise<string>
  /** Ends the login's lifetime now, as fifteen minutes passing would. */
  expire: (loginId: string) => Promise<void>
  /** The store's clock, which new logins expire against. */
  now: () => number
}

const secret = () => randomBytes(32).toString('base64url')

function newLogin(h: CliLoginStoreHarness): NewCliLogin {
  return {
    loginId: secret(),
    pollSecret: secret(),
    userCode: generateUserCode(),
    expiresAt: new Date(h.now() + 15 * 60 * 1000),
  }
}

/**
 * The state machine every CliLoginStore keeps (server/db/schema/cliLogins.ts),
 * run against the memory store here and against Postgres in auth-db.test.ts.
 */
export function cliLoginStoreContract(harness: () => Promise<CliLoginStoreHarness>) {
  /** A login GitHub has named a user for, waiting on the browser's confirmation. */
  async function authorized(h: CliLoginStoreHarness) {
    const login = newLogin(h)
    const state = secret()
    const confirm = secret()
    const userId = await h.user()
    assert.equal(await h.store.create(login), true)
    assert.equal(await h.store.bind(login.loginId, state), true)
    assert.deepEqual(await h.store.authorize(state, userId, confirm), {
      userCode: login.userCode,
    })
    return { login, state, confirm, userId }
  }

  it('waits for GitHub, then for the confirmation, then issues once', async () => {
    const h = await harness()
    const login = newLogin(h)
    const state = secret()
    const confirm = secret()
    const userId = await h.user()
    const take = () => h.store.take(login.loginId, login.pollSecret)

    await h.store.create(login)
    assert.deepEqual(await take(), { status: 'pending' })
    await h.store.bind(login.loginId, state)
    assert.deepEqual(await take(), { status: 'pending' })
    await h.store.authorize(state, userId, confirm)
    // GitHub alone is not enough: the browser has not said the code matches.
    assert.deepEqual(await take(), { status: 'pending' })
    assert.deepEqual(await h.store.awaiting(confirm), { userCode: login.userCode })

    assert.equal(await h.store.decide(confirm, 'confirm'), true)
    assert.equal(await h.store.awaiting(confirm), undefined)
    assert.deepEqual(await take(), { status: 'ready', userId })
    assert.deepEqual(await take(), { status: 'missing' })
  })

  it('answers a wrong poll secret as an unknown login, and the login goes on', async () => {
    const h = await harness()
    const { login, confirm } = await authorized(h)
    await h.store.decide(confirm, 'confirm')

    assert.deepEqual(await h.store.take(login.loginId, secret()), { status: 'missing' })
    assert.deepEqual(await h.store.take(secret(), login.pollSecret), { status: 'missing' })
    assert.equal((await h.store.take(login.loginId, login.pollSecret)).status, 'ready')
  })

  it('binds only a pending login, and the newest trip to GitHub wins', async () => {
    const h = await harness()
    const login = newLogin(h)
    const [first, second] = [secret(), secret()]
    const userId = await h.user()
    await h.store.create(login)

    assert.equal(await h.store.bind(secret(), first), false)
    assert.equal(await h.store.bind(login.loginId, first), true)
    assert.equal(await h.store.bind(login.loginId, second), true)

    assert.equal(await h.store.authorize(first, userId, secret()), undefined)
    assert.ok(await h.store.authorize(second, userId, secret()))
    assert.equal(await h.store.bind(login.loginId, secret()), false)
  })

  it('authorizes once, and only through the bound state', async () => {
    const h = await harness()
    const { state, userId } = await authorized(h)

    assert.equal(await h.store.authorize(state, userId, secret()), undefined)
    assert.equal(await h.store.authorize(secret(), userId, secret()), undefined)
  })

  it('lets only the confirmation secret decide, and only once', async () => {
    const h = await harness()
    const { login, confirm } = await authorized(h)

    assert.equal(await h.store.awaiting(secret()), undefined)
    assert.equal(await h.store.decide(secret(), 'confirm'), false)
    assert.equal(await h.store.decide(confirm, 'confirm'), true)
    assert.equal(await h.store.decide(confirm, 'confirm'), false)
    assert.equal(await h.store.decide(confirm, 'cancel'), false)
    assert.equal((await h.store.take(login.loginId, login.pollSecret)).status, 'ready')
  })

  it('tells the poll a login the browser cancelled, and it cannot be confirmed after', async () => {
    const h = await harness()
    const { login, confirm } = await authorized(h)

    assert.equal(await h.store.decide(confirm, 'cancel'), true)
    assert.equal(await h.store.decide(confirm, 'confirm'), false)
    assert.deepEqual(await h.store.take(login.loginId, login.pollSecret), { status: 'cancelled' })
  })

  it('ends a pending login when its browser side fails, but not one GitHub already named', async () => {
    const h = await harness()
    const pending = newLogin(h)
    const state = secret()
    await h.store.create(pending)
    await h.store.bind(pending.loginId, state)
    await h.store.cancel(state)
    assert.deepEqual(await h.store.take(pending.loginId, pending.pollSecret), {
      status: 'cancelled',
    })
    assert.equal(await h.store.authorize(state, await h.user(), secret()), undefined)

    const named = await authorized(h)
    await h.store.cancel(named.state)
    assert.equal(await h.store.decide(named.confirm, 'confirm'), true)
  })

  it('gives the session to exactly one of several racing polls', async () => {
    const h = await harness()
    const { login, confirm, userId } = await authorized(h)
    await h.store.decide(confirm, 'confirm')

    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.store.take(login.loginId, login.pollSecret)),
    )

    assert.deepEqual(
      results.filter((result) => result.status === 'ready'),
      [{ status: 'ready', userId }],
    )
    assert.equal(results.filter((result) => result.status === 'missing').length, 7)
  })

  it('forgets an expired login at every step', async () => {
    const h = await harness()
    const fresh = newLogin(h)
    const state = secret()
    await h.store.create(fresh)
    await h.expire(fresh.loginId)
    assert.equal(await h.store.bind(fresh.loginId, state), false)
    assert.deepEqual(await h.store.take(fresh.loginId, fresh.pollSecret), { status: 'missing' })

    const named = await authorized(h)
    await h.expire(named.login.loginId)
    assert.equal(await h.store.awaiting(named.confirm), undefined)
    assert.equal(await h.store.decide(named.confirm, 'confirm'), false)

    const confirmed = await authorized(h)
    await h.store.decide(confirmed.confirm, 'confirm')
    await h.expire(confirmed.login.loginId)
    assert.deepEqual(await h.store.take(confirmed.login.loginId, confirmed.login.pollSecret), {
      status: 'missing',
    })
  })
}
