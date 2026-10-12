import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AdamantApi } from '../../cli/src/api.ts'
import { loadCliConfig } from '../../cli/src/config.ts'

const config = loadCliConfig({
  ADAMANT_API_URL: 'https://adamant.example',
  ADAMANT_SESSION: 'session-secret',
})

describe('Adamant API client', () => {
  it('sends the session header and idempotency key when triggering a run', async () => {
    let request: Request | undefined
    const api = new AdamantApi(config, async (input, init) => {
      request = new Request(input, init)
      return Response.json(
        {
          run: {
            id: 'run_1',
            repositoryId: 'repo_1',
            sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            targetBranch: 'main',
            status: 'queued',
            version: 0,
            createdAt: '2026-10-12T12:00:00.000Z',
            updatedAt: '2026-10-12T12:00:00.000Z',
          },
        },
        { status: 202 },
      )
    })

    const result = await api.createRun({
      repositoryId: 'repo_1',
      sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      idempotencyKey: 'request-1',
    })

    assert.equal(result.created, true)
    assert.equal(request?.headers.get('ADAMANT_SESSION'), 'session-secret')
    assert.equal(request?.headers.get('Idempotency-Key'), 'request-1')
    assert.deepEqual(await request?.json(), {
      repositoryId: 'repo_1',
      sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
  })
})
