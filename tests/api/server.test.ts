import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { RunDetailSchema, RunSummarySchema, type RunSummary } from '@adamant/contract'
import { createServerApp, type ServerOptions, shutdownGracefully } from '../../server/api/server.ts'
import { createActivityService } from '../../server/api/services/activityService.ts'
import { type RunApiStore } from '../../server/api/services/runStore.ts'

const session = 'secret'
const seedUserId = '00000000-0000-0000-0000-000000000001'
const webhookSecret = 'server-webhook-secret'

const store = {
  create: async (input) => ({
    run: {
      id: 'run-1',
      repositoryId: input.repositoryId,
      sourceSha: input.sourceSha,
      targetBranch: 'adamant/run-1',
      status: 'queued',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } satisfies RunSummary,
    created: true,
  }),
  list: async () => [],
  detail: async () => null,
} satisfies RunApiStore

function authenticatedApp(runStore?: RunApiStore, options: ServerOptions = {}) {
  return createServerApp(runStore, {
    ...options,
    authenticate: async (token) =>
      token === session ? { sessionId: 'session-1', userId: seedUserId } : null,
  })
}

describe('composed API', () => {
  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET
  })
  it('leaves health open and protects runs', async () => {
    const app = authenticatedApp(store)
    assert.equal((await app.request('/health')).status, 200)

    const blocked = await app.request('/runs', {
      method: 'POST',
      body: JSON.stringify({ repositoryId: 'repo-1', sourceSha: 'a'.repeat(40) }),
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' },
    })
    assert.equal(blocked.status, 401)

    const created = await app.request('/runs', {
      method: 'POST',
      body: JSON.stringify({ repositoryId: 'repo-1', sourceSha: 'a'.repeat(40) }),
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'key-1',
        ADAMANT_SESSION: session,
      },
    })
    assert.equal(created.status, 202)
    const body = (await created.json()) as { run: { status: string } }
    assert.equal(body.run.status, 'queued')

    const activity = await app.request('/activity', {
      headers: { ADAMANT_SESSION: session },
    })
    assert.equal(activity.status, 200)
  })

  it('requires a session for every schema resource, not only /runs', async () => {
    const app = authenticatedApp()

    const blockedRead = await app.request('/sessions')
    assert.equal(blockedRead.status, 401)

    const blockedForgedSandboxPass = await app.request('/sandbox-results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        run_id: 'run-1',
        attempt_number: 1,
        candidate_hash: 'fake',
        base_sha: 'abc123',
        commands: ['npm test'],
        verdict: 'pass',
        exit_code: 0,
        artifact_ref: 'fake',
      }),
    })
    assert.equal(blockedForgedSandboxPass.status, 401)

    const allowed = await app.request('/sandbox-results', {
      headers: { ADAMANT_SESSION: session },
    })
    assert.equal(allowed.status, 200)
  })

  it('serves the CLI run contract without a database', async () => {
    const activityService = createActivityService()
    const app = authenticatedApp(undefined, { activityService })
    // What the CLI sends: a bearer token and camelCase fields.
    const headers = {
      Authorization: `Bearer ${session}`,
      'content-type': 'application/json',
      'idempotency-key': 'key-1',
    }
    const body = JSON.stringify({ repositoryId: 'repo-1', sourceSha: 'a'.repeat(40) })

    const created = await app.request('/runs', { method: 'POST', headers, body })
    assert.equal(created.status, 202)
    const createdBody = (await created.json()) as { run: unknown }
    assert.deepEqual(Object.keys(createdBody), ['run'])
    const run = RunSummarySchema.parse(createdBody.run)
    assert.equal(run.status, 'queued')
    assert.equal(run.targetBranch, `adamant/${run.id}`)

    const replayed = await app.request('/runs', { method: 'POST', headers, body })
    assert.equal(replayed.status, 200)
    assert.equal(((await replayed.json()) as { run: RunSummary }).run.id, run.id)

    const listBody = (await (await app.request('/runs', { headers })).json()) as { runs: unknown[] }
    assert.deepEqual(Object.keys(listBody), ['runs'])
    assert.deepEqual(
      listBody.runs.map((listed) => RunSummarySchema.parse(listed).id),
      [run.id],
    )

    const detail = RunDetailSchema.parse(
      await (await app.request(`/runs/${run.id}`, { headers })).json(),
    )
    assert.deepEqual(
      detail.auditEvents.map((event) => [event.eventType, event.actorUserId]),
      [['run.queued', seedUserId]],
    )

    // `adamant watch` sees the run start.
    const history = await activityService.getHistory()
    assert.ok(
      history.some((event) => event.type === 'audit:run.queued' && event.payload.runId === run.id),
    )

    // The schema CRUD no longer answers under /runs.
    const patched = await app.request(`/runs/${run.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'succeeded' }),
    })
    assert.equal(patched.status, 404)
  })

  it('accepts a signed GitHub delivery without a CLI session', async () => {
    process.env.GITHUB_WEBHOOK_SECRET = webhookSecret
    const app = createServerApp()
    const body = JSON.stringify({ zen: 'hello' })
    const signature = `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`
    const response = await app.request('/webhooks/github', {
      method: 'POST',
      body,
      headers: {
        'x-github-delivery': 'composed-ping',
        'x-github-event': 'ping',
        'x-hub-signature-256': signature,
      },
    })

    assert.equal(response.status, 202)
  })
})

describe('graceful shutdown', () => {
  function fakeServer() {
    const calls: string[] = []
    let onClosed: ((error?: Error) => void) | undefined
    const server = {
      close(callback?: (error?: Error) => void) {
        calls.push('close')
        onClosed = callback
      },
      closeIdleConnections() {
        calls.push('closeIdleConnections')
      },
      closeAllConnections() {
        calls.push('closeAllConnections')
      },
    }
    return { server, calls, closed: (error?: Error) => onClosed?.(error) }
  }

  it('stops listening, lets in-flight requests finish, then exits', () => {
    const { server, calls, closed } = fakeServer()
    let exitCode: number | undefined
    shutdownGracefully(server, { timeoutMs: 10_000, exit: (code) => (exitCode = code) })

    assert.deepEqual(calls, ['close', 'closeIdleConnections'])
    assert.equal(exitCode, undefined, 'waits for the server to drain')

    closed()
    assert.equal(exitCode, 0)
  })

  it('cuts connections still open at the deadline, such as SSE streams', async () => {
    const { server, calls } = fakeServer()
    let exits = 0
    shutdownGracefully(server, { timeoutMs: 5, exit: () => (exits += 1) })

    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.ok(calls.includes('closeAllConnections'))
    assert.equal(exits, 1)
  })
})
