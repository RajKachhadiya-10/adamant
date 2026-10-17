import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { type ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { type GitProvider, type SandboxProvider } from '../../server/agent/deps.ts'
import { createMemoryRecorder } from '../../server/agent/recorder.ts'
import { type OpenAiResponses } from '../../server/agent/openai.ts'
import {
  drainExpiredOAuthStates,
  graphStep,
  readConcurrency,
  readHealAgent,
  readSandboxCacheMaxAgeMs,
  readSandboxCacheRoot,
  readWorkspaceRoot,
  syncStep,
  type GraphStepDependencies,
} from '../../server/worker/index.ts'
import { type FinishedStatus, type HealRun } from '../../server/worker/runs.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const git = {
  fetch: async () => {},
  checkout: async () => {},
  applyPatch: async () => {},
  commit: async () => {},
  push: async () => {},
  openPr: async () => ({ number: 1, url: 'https://github.com/acme/demo/pull/1' }),
  mergePr: async () => {},
  getFailureLogs: async () => 'Error: boom at src/app.ts:10',
  readFile: async () => null,
  resetToBase: async () => {},
  listFiles: async () => [],
  search: async () => '',
} as GitProvider

const sandbox = {
  runValidation: async () => ({
    verdict: 'pass' as const,
    commands: ['pnpm test'],
    output: 'ok',
  }),
} as SandboxProvider

function recordingClient() {
  const calls: ResponseCreateParamsNonStreaming[] = []
  const client: OpenAiResponses = {
    create: async (body) => {
      calls.push(body)
      return { output_text: `step-${calls.length}` }
    },
  }
  return { calls, client }
}

function deps(overrides: Partial<GraphStepDependencies> = {}): GraphStepDependencies {
  return {
    loadRun: async () => ({
      runId: 'run-1',
      baseSha: 'abc',
      repositoryId: 'repo-1',
      owner: 'acme',
      name: 'demo',
      defaultBranch: 'main',
      installationId: '99',
    }),
    markRunning: async () => true,
    markFinished: async () => {},
    createTools: () => ({ git, sandbox, recorder: createMemoryRecorder() }),
    ...overrides,
  }
}

describe('worker', () => {
  it('invokes compileOpenAiHealGraph with thread_id set to the run', async () => {
    const { calls, client } = recordingClient()
    const checkpointer = new MemorySaver()
    const seen: string[] = []
    let finished: FinishedStatus | undefined

    await graphStep(
      { runId: 'run-1' },
      { logger: { info: () => {} } },
      deps({
        markRunning: async () => {
          seen.push('running')
          return true
        },
        markFinished: async (_runId, status) => {
          finished = status
        },
        llmOptions: { client, model: 'gpt-6' },
        checkpointer,
      }),
    )

    assert.equal(finished, 'succeeded')
    assert.deepEqual(seen, ['running'])
    assert.deepEqual(
      calls.map((call) => call.reasoning?.effort),
      ['low', 'low', 'high'],
    )
    assert.ok(checkpointer.storage['run-1'])
  })

  it('does not call the model when the run is missing', async () => {
    const { calls, client } = recordingClient()
    await assert.rejects(
      () =>
        graphStep(
          { runId: 'missing' },
          { logger: { info: () => {} } },
          deps({
            loadRun: async () => null,
            llmOptions: { client, model: 'gpt-6' },
          }),
        ),
      /graph_step run not found: missing/,
    )
    assert.equal(calls.length, 0)
  })

  it('ends a manual-mode run awaiting review, with its PR open and unmerged', async () => {
    const { client } = recordingClient()
    let finished: FinishedStatus | undefined
    const merged: number[] = []
    const asked: string[] = []
    await graphStep(
      { runId: 'run-1' },
      { logger: { info: () => {} } },
      deps({
        markFinished: async (_runId, status) => {
          finished = status
        },
        autoMerge: async (runId) => {
          asked.push(runId)
          return false
        },
        createTools: () => ({
          git: {
            ...git,
            mergePr: async (prNumber) => {
              merged.push(prNumber)
            },
          },
          sandbox,
          recorder: createMemoryRecorder(),
        }),
        llmOptions: { client, model: 'gpt-6' },
      }),
    )
    assert.equal(finished, 'awaiting_hitl')
    assert.deepEqual(asked, ['run-1'])
    assert.deepEqual(merged, [])
  })

  it('runs the autonomous agents unless told to use the classic steps', () => {
    assert.equal(readHealAgent({}), 'agents')
    assert.equal(readHealAgent({ ADAMANT_HEAL_AGENT: 'agents' }), 'agents')
    assert.equal(readHealAgent({ ADAMANT_HEAL_AGENT: 'classic' }), 'classic')
    assert.equal(readHealAgent({ ADAMANT_HEAL_AGENT: 'nonsense' }), 'agents')
  })

  it('skips the GitHub sync quietly when the App is not configured', async () => {
    const lines: string[] = []
    await syncStep(
      { logger: { info: (message) => lines.push(message) } },
      {
        github: null,
        store: {
          transaction: async () => {
            throw new Error('should not be called')
          },
          upsertInstallation: async () => 'i',
          upsertRepository: async () => 'r',
          createQueuedRun: async () => null,
          recordAudit: async () => {},
          awaitingReview: async () => [],
          finishReview: async () => false,
        },
      },
    )
    assert.deepEqual(lines, [])
  })

  it('does not start a second graph when the run is no longer queued', async () => {
    const { calls, client } = recordingClient()
    await graphStep(
      { runId: 'run-1' },
      { logger: { info: () => {} } },
      deps({
        markRunning: async () => false,
        llmOptions: { client, model: 'gpt-6' },
      }),
    )
    assert.equal(calls.length, 0)
  })

  it('reclaims a running run after a transient first-attempt failure', async () => {
    const { client } = recordingClient()
    const retryFlags: boolean[] = []
    let runStatus: 'queued' | 'running' | FinishedStatus = 'queued'
    let finished: FinishedStatus | undefined
    let fetchAttempts = 0
    const retryingGit = {
      ...git,
      fetch: async () => {
        fetchAttempts += 1
        if (fetchAttempts === 1) throw new Error('transient GitHub failure')
      },
    }
    const retryDeps = deps({
      markRunning: async (_runId, retry) => {
        retryFlags.push(retry)
        if (runStatus === 'queued' || (retry && runStatus === 'running')) {
          runStatus = 'running'
          return true
        }
        return false
      },
      markFinished: async (_runId, status) => {
        runStatus = status
        finished = status
      },
      createTools: () => ({
        git: retryingGit,
        sandbox,
        recorder: createMemoryRecorder(),
      }),
      llmOptions: { client, model: 'gpt-6' },
    })

    await assert.rejects(
      () =>
        graphStep(
          { runId: 'run-1' },
          { logger: { info: () => {} }, job: { attempts: 1, max_attempts: 3 } },
          retryDeps,
        ),
      /transient GitHub failure/,
    )
    assert.equal(runStatus, 'running')

    await graphStep(
      { runId: 'run-1' },
      { logger: { info: () => {} }, job: { attempts: 2, max_attempts: 3 } },
      retryDeps,
    )

    assert.deepEqual(retryFlags, [false, true])
    assert.equal(finished, 'succeeded')
  })

  it('does not let a duplicate first attempt reclaim a running run', async () => {
    const { calls, client } = recordingClient()
    const retryFlags: boolean[] = []

    await graphStep(
      { runId: 'run-1' },
      { logger: { info: () => {} }, job: { attempts: 1, max_attempts: 3 } },
      deps({
        markRunning: async (_runId, retry) => {
          retryFlags.push(retry)
          return false
        },
        llmOptions: { client, model: 'gpt-6' },
      }),
    )

    assert.deepEqual(retryFlags, [false])
    assert.equal(calls.length, 0)
  })

  it('disposes the run workspace whether the graph merges or throws', async () => {
    const { client } = recordingClient()
    const disposed: string[] = []

    await graphStep(
      { runId: 'run-1' },
      { logger: { info: () => {} } },
      deps({
        createTools: () => ({
          git,
          sandbox,
          recorder: createMemoryRecorder(),
          dispose: async () => void disposed.push('merged'),
        }),
        llmOptions: { client, model: 'gpt-6' },
      }),
    )

    await assert.rejects(() =>
      graphStep(
        { runId: 'run-1' },
        { logger: { info: () => {} } },
        deps({
          createTools: () => ({
            git: { ...git, fetch: async () => Promise.reject(new Error('403 from GitHub')) },
            sandbox,
            recorder: createMemoryRecorder(),
            dispose: async () => void disposed.push('threw'),
          }),
          llmOptions: { client, model: 'gpt-6' },
        }),
      ),
    )

    assert.deepEqual(disposed, ['merged', 'threw'])
  })

  it('disposes the run workspace when model configuration fails', async () => {
    const disposed: string[] = []

    await assert.rejects(
      () =>
        graphStep(
          { runId: 'run-1' },
          { logger: { info: () => {} } },
          deps({
            createTools: () => ({
              git,
              sandbox,
              recorder: createMemoryRecorder(),
              dispose: async () => void disposed.push('configuration failed'),
            }),
          }),
        ),
      /OPENAI_API_KEY is required/,
    )

    assert.deepEqual(disposed, ['configuration failed'])
  })

  it('marks the run failed when the run tools cannot be built on the last attempt', async () => {
    const finished: (string | undefined)[][] = []

    await assert.rejects(
      () =>
        graphStep(
          { runId: 'run-1' },
          { logger: { info: () => {} }, job: { attempts: 3, max_attempts: 3 } },
          deps({
            createTools: () => {
              throw new Error('workspace root is not writable')
            },
            markFinished: async (_runId, status, reason) => void finished.push([status, reason]),
          }),
        ),
      /workspace root is not writable/,
    )

    // The reason is what `adamant run` shows; the stack stays in the worker log.
    assert.deepEqual(finished, [['failed', 'workspace root is not writable']])
  })

  it('builds the run tools from the loaded run, not from the payload', async () => {
    const { client } = recordingClient()
    const seen: HealRun[] = []

    await graphStep(
      { runId: 'run-1' },
      { logger: { info: () => {} } },
      deps({
        createTools: (healRun) => {
          seen.push(healRun)
          return { git, sandbox, recorder: createMemoryRecorder() }
        },
        llmOptions: { client, model: 'gpt-6' },
      }),
    )

    assert.equal(seen[0]?.runId, 'run-1')
    assert.equal(seen[0]?.owner, 'acme')
    assert.equal(seen[0]?.defaultBranch, 'main')
  })

  it('rejects a payload without runId', async () => {
    await assert.rejects(
      () => graphStep({}, { logger: { info: () => {} } }, deps()),
      /graph_step payload must be an object with runId/,
    )
  })

  it('drains expired OAuth states until a partial batch', async () => {
    const batches = [1_000, 1_000, 17]
    const deleted = await drainExpiredOAuthStates(async () => batches.shift() ?? 0)

    assert.equal(deleted, 2_017)
    assert.equal(batches.length, 0)
  })

  it('caps OAuth state cleanup at fifty full batches', async () => {
    let calls = 0
    const deleted = await drainExpiredOAuthStates(async () => {
      calls += 1
      return 1_000
    })

    assert.equal(calls, 50)
    assert.equal(deleted, 50_000)
  })

  it('runs more than one heal at a time unless told otherwise', () => {
    assert.equal(readConcurrency({}), 2)
    assert.equal(readConcurrency({ ADAMANT_WORKER_CONCURRENCY: '6' }), 6)
    for (const bad of ['0', '-1', '1.5', 'many']) {
      assert.equal(readConcurrency({ ADAMANT_WORKER_CONCURRENCY: bad }), 2, bad)
    }
  })

  it('puts worktrees where the sandbox host can mount them when configured', () => {
    assert.equal(
      readWorkspaceRoot({ ADAMANT_WORKSPACE_ROOT: '/var/lib/adamant' }),
      '/var/lib/adamant',
    )
    assert.match(readWorkspaceRoot({}), /adamant-workspaces$/)
  })

  it('keeps package caches under the workspace root unless told otherwise', () => {
    assert.equal(readSandboxCacheRoot('/var/lib/adamant', {}), '/var/lib/adamant/.cache')
    assert.equal(
      readSandboxCacheRoot('/var/lib/adamant', { ADAMANT_SANDBOX_CACHE_ROOT: '/mnt/cache' }),
      '/mnt/cache',
    )
    assert.equal(
      readSandboxCacheRoot('/var/lib/adamant', { ADAMANT_SANDBOX_CACHE_ROOT: 'none' }),
      null,
    )
  })

  it('evicts idle caches after two weeks unless told otherwise', () => {
    const day = 24 * 60 * 60_000
    assert.equal(readSandboxCacheMaxAgeMs({}), 14 * day)
    assert.equal(readSandboxCacheMaxAgeMs({ ADAMANT_SANDBOX_CACHE_MAX_AGE_DAYS: '3' }), 3 * day)
    assert.equal(readSandboxCacheMaxAgeMs({ ADAMANT_SANDBOX_CACHE_MAX_AGE_DAYS: 'soon' }), 14 * day)
  })

  it('refuses to start without DATABASE_URL', async () => {
    const env: NodeJS.ProcessEnv = {}
    if (process.env.PATH) env.PATH = process.env.PATH
    if (process.env.HOME) env.HOME = process.env.HOME

    const proc = spawn(process.execPath, ['--experimental-strip-types', 'server/worker/index.ts'], {
      cwd: repoRoot,
      env,
    })
    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const code = await new Promise<number | null>((resolve) => proc.on('close', resolve))
    assert.equal(code, 1)
    assert.match(stderr, /DATABASE_URL is required to start @adamant\/worker/)
  })
})
