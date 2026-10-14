import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AdamantApi, ApiError } from '../../cli/src/api.ts'
import { loadCliConfig } from '../../cli/src/config.ts'

const config = loadCliConfig({
  ADAMANT_API_URL: 'https://adamant.example',
  ADAMANT_SESSION: 'session-secret',
})

const run = {
  id: 'run_1',
  repositoryId: 'repo_1',
  sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  targetBranch: 'main',
  status: 'queued',
  version: 0,
  createdAt: '2026-10-12T12:00:00.000Z',
  updatedAt: '2026-10-12T12:00:00.000Z',
}

/** A fetch that never answers on its own, like a hung API; it honours abort. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    // A hung request holds its socket open, which keeps the process alive;
    // AbortSignal.timeout's own timer does not, so this stands in for the socket.
    const socket = setTimeout(() => {}, 60_000)
    init?.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(socket)
        reject(init.signal?.reason)
      },
      { once: true },
    )
  })

describe('Adamant API client', () => {
  it('sends the session as a bearer token and the idempotency key when triggering a run', async () => {
    let request: Request | undefined
    const api = new AdamantApi(config, async (input, init) => {
      request = new Request(input, init)
      return Response.json({ run }, { status: 202 })
    })

    const result = await api.createRun({
      repositoryId: 'repo_1',
      sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      idempotencyKey: 'request-1',
    })

    assert.equal(result.created, true)
    // Not the ADAMANT_SESSION header: proxies drop header names with underscores.
    assert.equal(request?.headers.get('Authorization'), 'Bearer session-secret')
    assert.equal(request?.headers.get('ADAMANT_SESSION'), null)
    assert.equal(request?.headers.get('Idempotency-Key'), 'request-1')
    assert.deepEqual(await request?.json(), {
      repositoryId: 'repo_1',
      sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
  })

  it('says what to do about a rejected session', async () => {
    const api = new AdamantApi(config, async () =>
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    )

    await assert.rejects(api.listRuns(), (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 401)
      assert.match(error.message, /rejected ADAMANT_SESSION/)
      assert.match(error.message, /session:create/)
      return true
    })
  })

  it('names the API it could not reach and why', async () => {
    const api = new AdamantApi(config, async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    })

    await assert.rejects(
      api.health(),
      /Could not reach the Adamant API at https:\/\/adamant\.example \(connection refused\)/,
    )
  })

  it('gives up on a hung API instead of waiting forever', async () => {
    const api = new AdamantApi(config, hangingFetch, { timeoutMs: 20 })

    await assert.rejects(api.listRuns(), /did not answer within/)
  })

  it('leaves a cancellation by the caller as a cancellation', async () => {
    const api = new AdamantApi(config, hangingFetch)
    const controller = new AbortController()
    const pending = api.listRuns(controller.signal)
    controller.abort()

    await assert.rejects(pending, { name: 'AbortError' })
  })

  it('reports a response it does not understand without dumping the schema', async () => {
    // The shape the schema CRUD used to answer /runs with.
    const api = new AdamantApi(config, async () => Response.json({ data: [] }))

    await assert.rejects(api.listRuns(), (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.match(error.message, /GET \/runs on https:\/\/adamant\.example returned a response/)
      assert.doesNotMatch(error.message, /invalid_type|expected/)
      return true
    })
  })

  it('does not time out the activity stream, which stays open by design', async () => {
    let signal: AbortSignal | null | undefined
    const api = new AdamantApi(
      config,
      async (_input, init) => {
        signal = init?.signal
        return new Response(new ReadableStream(), { status: 200 })
      },
      { timeoutMs: 1 },
    )

    const response = await api.openActivity('evt-1')
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.ok(response.body)
    assert.notEqual(signal?.aborted, true)
  })
})
