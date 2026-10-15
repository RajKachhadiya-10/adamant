import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DrizzleQueryError } from 'drizzle-orm'
import { Hono } from 'hono'

import { clientKeyForAddress, createRateLimit } from '../../server/api/middleware/rateLimit.ts'
import {
  isDatabaseUnavailable,
  redactDatabaseError,
} from '../../server/api/services/databaseErrors.ts'

function limited(options: { burst: number; perMinute: number; maxClients?: number }) {
  let now = 0
  const app = new Hono()
  app.use(
    '*',
    createRateLimit({
      ...options,
      now: () => now,
      clientKey: (c) => c.req.header('x-client') ?? '',
    }),
  )
  app.post('/', (c) => c.json({ ok: true }))
  const send = async (client: string) =>
    (await app.request('/', { method: 'POST', headers: { 'x-client': client } })).status
  return {
    send,
    request: (client: string) =>
      app.request('/', { method: 'POST', headers: { 'x-client': client } }),
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('sign-in rate limit', () => {
  it('lets a burst through, then refuses with Retry-After until a token is earned back', async () => {
    const { send, request, advance } = limited({ burst: 3, perMinute: 6 })

    assert.deepEqual([await send('a'), await send('a'), await send('a')], [200, 200, 200])
    const refused = await request('a')
    assert.equal(refused.status, 429)
    assert.equal(refused.headers.get('retry-after'), '10')
    assert.equal(refused.headers.get('cache-control'), 'no-store')

    advance(9_000)
    assert.equal(await send('a'), 429)
    advance(1_100)
    assert.equal(await send('a'), 200)
    assert.equal(await send('a'), 429)
  })

  it('does not count a refused request against the client', async () => {
    const { send, advance } = limited({ burst: 1, perMinute: 60 })
    await send('a')
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(await send('a'), 429)

    advance(1_001)
    assert.equal(await send('a'), 200)
  })

  it('never banks more than the burst, however long a client was idle', async () => {
    const { send, advance } = limited({ burst: 2, perMinute: 60 })
    advance(60 * 60 * 1000)

    assert.deepEqual([await send('a'), await send('a'), await send('a')], [200, 200, 429])
  })

  it('keeps a bucket per client', async () => {
    const { send } = limited({ burst: 1, perMinute: 1 })

    assert.equal(await send('a'), 200)
    assert.equal(await send('a'), 429)
    assert.equal(await send('b'), 200)
  })

  it('remembers a bounded number of clients, forgetting the least recently seen', async () => {
    const { send } = limited({ burst: 1, perMinute: 1, maxClients: 2 })
    await send('a')
    await send('b')
    assert.equal(await send('a'), 429)

    await send('c')
    // b was seen least recently and is forgotten; a (seen just now) is still limited.
    assert.equal(await send('a'), 429)
    assert.equal(await send('b'), 200)
  })

  it('keys IPv4 by address and IPv6 by its /64', () => {
    assert.equal(clientKeyForAddress('203.0.113.7'), '203.0.113.7')
    assert.equal(clientKeyForAddress('::ffff:203.0.113.7'), '203.0.113.7')
    assert.equal(clientKeyForAddress('2001:db8:1:2::1'), '2001:db8:1:2::/64')
    assert.equal(clientKeyForAddress('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64')
    assert.equal(clientKeyForAddress('2001:0DB8:0001:0002::ffff'), '2001:db8:1:2::/64')
    assert.equal(clientKeyForAddress('::1'), '0:0:0:0::/64')
    assert.equal(clientKeyForAddress('fe80::1%en0'), 'fe80:0:0:0::/64')
    // Not an address this can parse: it keys as itself rather than as someone else.
    assert.equal(clientKeyForAddress('1::2::3'), '1::2::3')
    assert.equal(clientKeyForAddress('64:ff9b::192.0.2.1'), '64:ff9b::192.0.2.1')
  })
})

describe('database failures', () => {
  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })

  it('tells an outage from a bug', () => {
    const outages = [
      refused(),
      new AggregateError([refused(), refused()], 'connect failed'),
      new DrizzleQueryError('select 1', [], refused()),
      new Error('wrapped', { cause: new Error('Connection terminated unexpectedly') }),
      new Error('timeout exceeded when trying to connect'),
      Object.assign(new Error('terminating connection due to administrator command'), {
        code: '57P01',
      }),
      Object.assign(new Error('sorry, too many clients already'), { code: '53300' }),
      Object.assign(new Error('connection failure'), { code: '08006' }),
    ]
    const bugs = [
      new Error('relation "sessions" does not exist'),
      Object.assign(new Error('duplicate key value'), { code: '23505' }),
      new TypeError('x is not a function'),
      'a string',
      undefined,
    ]

    for (const error of outages) assert.equal(isDatabaseUnavailable(error), true, String(error))
    for (const error of bugs) assert.equal(isDatabaseUnavailable(error), false, String(error))
  })

  it('logs a failed query without its bound values or the row it conflicted with', () => {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      severity: 'ERROR',
      detail: 'Key (state)=(state-secret-value) already exists.',
    })
    const error = new DrizzleQueryError(
      'insert into "oauth_states" ("state", "code_verifier") values ($1, $2)',
      ['state-secret-value', 'verifier-secret-value'],
      cause,
    )

    const redacted = redactDatabaseError(error)
    const text = redacted instanceof Error ? `${redacted.stack}` : ''

    assert.ok(redacted instanceof Error)
    assert.match(text, /Failed query: insert into "oauth_states"/)
    assert.match(text, /23505/)
    assert.equal(text.includes('state-secret-value'), false)
    assert.equal(text.includes('verifier-secret-value'), false)
  })

  it('leaves other errors as they are', () => {
    const error = new Error('GitHub token exchange failed with 500')
    assert.equal(redactDatabaseError(error), error)
  })
})
