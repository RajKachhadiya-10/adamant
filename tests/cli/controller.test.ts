import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AdamantApi } from '../../cli/src/api.ts'
import { loadCliConfig } from '../../cli/src/config.ts'
import { CommandController, formatActivity } from '../../cli/src/controller.ts'

const run = {
  id: '6611607f-117c-486e-9432-1bec481efacb',
  repositoryId: 'repo-1',
  sourceSha: 'e1745e2b5a13aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  targetBranch: 'adamant/6611607f-117c-486e-9432-1bec481efacb',
  status: 'failed',
  version: 3,
  createdAt: '2026-10-14T09:46:10.000Z',
  updatedAt: '2026-10-14T09:46:23.000Z',
}

/** Answers each path from `routes`; anything else is a 404. */
function controllerFor(routes: Record<string, () => Response>) {
  const api = new AdamantApi(
    loadCliConfig({ ADAMANT_API_URL: 'https://adamant.example', ADAMANT_SESSION: 's' }),
    async (input) => {
      const route = routes[new URL(String(input)).pathname]
      return route ? route() : Response.json({ error: 'Not found' }, { status: 404 })
    },
  )
  return new CommandController(api)
}

const texts = async (controller: CommandController, input: string) => {
  const result = await controller.execute(input)
  assert.equal(result.kind, 'output')
  return result.kind === 'output' ? result.lines : []
}

describe('Adamant CLI commands against the API', () => {
  it('reports a refused session from /status, which /health alone cannot see', async () => {
    const controller = controllerFor({
      '/health': () => Response.json({ status: 'ok' }),
      '/runs': () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const lines = await texts(controller, '/status')

    assert.match(lines[0]?.text ?? '', /Adamant API at https:\/\/adamant\.example is healthy/)
    assert.equal(lines[1]?.tone, 'error')
    assert.match(lines[1]?.text ?? '', /rejected ADAMANT_SESSION/)
  })

  it('confirms a working session', async () => {
    const controller = controllerFor({
      '/health': () => Response.json({ status: 'ok' }),
      '/runs': () => Response.json({ runs: [] }),
    })

    const lines = await texts(controller, '/status')

    assert.deepEqual(
      lines.map((line) => line.tone),
      ['success', 'success'],
    )
    assert.equal(lines[1]?.text, 'Session accepted.')
  })

  it('marks each /runs row with its run so it can be opened', async () => {
    const controller = controllerFor({ '/runs': () => Response.json({ runs: [run] }) })

    const lines = await texts(controller, '/runs')

    assert.match(lines[0]?.text ?? '', /^STATUS\s+SHA\s+CREATED\s+RUN ID$/)
    assert.equal(lines[1]?.runId, run.id)
    // The branch is always adamant/<id>; repeating the id made every row wrap.
    assert.equal(lines[1]?.text.split(run.id).length, 2)
    assert.match(lines[1]?.text ?? '', /^failed\s+e1745e2b5a13\s/)
  })

  it('shows why a run failed in its trail', async () => {
    const controller = controllerFor({
      [`/runs/${run.id}`]: () =>
        Response.json({
          run,
          auditEvents: [
            {
              id: 'e1',
              runId: run.id,
              eventType: 'run.failed',
              payload: { reason: 'OPENAI_API_KEY is required in the worker' },
              actorUserId: null,
              createdAt: '2026-10-14T09:46:23.000Z',
            },
          ],
        }),
    })

    const lines = await texts(controller, `/run ${run.id}`)
    const failed = lines.find((line) => line.text.includes('run.failed'))

    assert.equal(failed?.tone, 'error')
    assert.match(failed?.text ?? '', /run\.failed {2}OPENAI_API_KEY is required in the worker$/)
  })
})

describe('Activity rows', () => {
  it('show whether a delivery started anything', () => {
    const row = formatActivity({
      id: 'wh_1',
      type: 'webhook:pull_request',
      payload: { processingStatus: 'ignored', receivedAt: '2026-10-14T09:46:10.000Z' },
      receivedAt: '2026-10-14T09:46:10.000Z',
    })

    assert.match(row, /^\d\d:\d\d:\d\d {2}webhook:pull_request {2}ignored$/)
  })

  it('show the run and the detail that matters for an audit event', () => {
    const row = formatActivity({
      id: 'audit_1',
      type: 'audit:run.merge_failed',
      payload: {
        runId: run.id,
        createdAt: '2026-10-14T09:46:10.000Z',
        payload: { prNumber: 7, error: 'Base branch was modified' },
      },
      receivedAt: '2026-10-14T09:46:10.000Z',
    })

    assert.match(
      row,
      new RegExp(`audit:run\\.merge_failed {2}${run.id} {2}Base branch was modified$`),
    )
  })
})
