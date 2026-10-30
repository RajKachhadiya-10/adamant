import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import {
  type GitProvider,
  LlmTruncatedError,
  type SandboxProvider,
} from '../../server/agent/deps.ts'
import { createMemoryRecorder } from '../../server/agent/recorder.ts'
import {
  compileOpenAiHealGraph,
  createOpenAiLlm,
  type OpenAiResponses,
} from '../../server/agent/openai.ts'

const git = {
  fetch: async () => {},
  checkout: async () => {},
  applyPatch: async () => {},
  commit: async () => {},
  push: async () => 'ab12'.repeat(10),
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

const repository = {
  owner: 'acme',
  name: 'demo',
  installationId: '1',
  defaultBranch: 'main',
}

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

describe('OpenAI heal model', () => {
  it('requires the worker API key when no client is injected', () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = ''
    try {
      assert.throws(() => createOpenAiLlm(), /OPENAI_API_KEY is required in the worker/)
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  it('defaults to the configured heal model', async () => {
    const previousModel = process.env.OPENAI_MODEL
    const previousKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_MODEL
    process.env.OPENAI_API_KEY = 'test-key'

    try {
      const { calls, client } = recordingClient()
      await createOpenAiLlm({ client }).plan({
        failure: { firstError: null, location: null, failingTests: [], excerpt: '' },
        sources: [],
        diagnostics: 'd',
      })
      assert.equal(calls[0]?.model, 'gpt-6')
    } finally {
      if (previousModel === undefined) delete process.env.OPENAI_MODEL
      else process.env.OPENAI_MODEL = previousModel
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
    }
  })

  it('rejects a reply the model did not finish instead of returning the fragment', async () => {
    const client: OpenAiResponses = {
      create: async () => ({
        output_text: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-x',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    }

    await assert.rejects(
      createOpenAiLlm({ client }).patch({
        failure: { firstError: null, location: null, failingTests: [], excerpt: '' },
        sources: [],
        diagnostics: 'd',
        plan: 'p',
        previousAttempt: null,
      }),
      (error: unknown) =>
        error instanceof LlmTruncatedError && /cut off .*max_output_tokens/.test(error.message),
    )
  })

  it('surfaces a failed response instead of reporting an empty reply', async () => {
    const client: OpenAiResponses = {
      create: async () => ({
        output_text: '',
        status: 'failed',
        error: { message: 'server_error: try again' },
      }),
    }

    await assert.rejects(
      createOpenAiLlm({ client }).diagnose({
        failure: { firstError: null, location: null, failingTests: [], excerpt: '' },
        sources: [],
        previousAttempt: null,
      }),
      /server_error: try again/,
    )
  })

  it('runs diagnose and plan at low effort and the patch at high effort', async () => {
    const { calls, client } = recordingClient()
    const graph = compileOpenAiHealGraph(
      { git, sandbox, recorder: createMemoryRecorder() },
      { client, model: 'gpt-6' },
    )

    const finalState = await graph.invoke({
      runId: 'run-should-stay-out-of-the-prompt',
      repository,
      baseSha: 'abc',
    })

    assert.equal(finalState.status, 'completed')
    assert.equal(finalState.diagnostics, 'step-1')
    assert.equal(finalState.plan, 'step-2')
    // Normalized for `git apply`: the trimmed reply gets its final newline back.
    assert.equal(finalState.candidatePatch, 'step-3\n')
    assert.deepEqual(
      calls.map((call) => call.reasoning?.effort),
      ['low', 'low', 'high'],
    )

    const instructions = calls.map((call) => call.instructions)
    assert.equal(new Set(instructions).size, 1)
    for (const call of calls) {
      assert.equal(call.model, 'gpt-6')
      assert.equal(call.store, false)
      const input = typeof call.input === 'string' ? call.input : ''
      assert.equal(input.includes('run-should-stay-out-of-the-prompt'), false)
      assert.equal(String(call.instructions).includes('run-should-stay-out-of-the-prompt'), false)
    }
    const diagnoseInput = calls[0]?.input
    assert.equal(typeof diagnoseInput, 'string')
    assert.match(String(diagnoseInput), /src\/app\.ts:10/)
  })

  it('opens every step with the same failure and source block so the prefix caches', async () => {
    const { calls, client } = recordingClient()
    const sourceGit = {
      ...git,
      readFile: async () => ({ path: 'src/app.ts', text: 'export const answer = 41\n' }),
    } as GitProvider
    const graph = compileOpenAiHealGraph(
      { git: sourceGit, sandbox, recorder: createMemoryRecorder() },
      { client, model: 'gpt-6' },
    )

    await graph.invoke({ runId: 'run-cache', repository, baseSha: 'abc' })

    const inputs = calls.map((call) => String(call.input))
    const shared = inputs[0]?.slice(0, inputs[0].indexOf('\nTask:'))
    assert.ok(shared, 'diagnose has a shared block before its task')
    assert.match(shared, /Source src\/app\.ts \(lines 1-1\):\nexport const answer = 41/)
    for (const input of inputs) {
      assert.ok(input.startsWith(shared), 'every step starts with the identical block')
      assert.match(input.split('\n').at(-1) ?? '', /^Task: /, 'the task comes last')
    }
  })

  it('shows the rejected candidate to the next diagnose so the retry differs', async () => {
    const { calls, client } = recordingClient()
    let attempts = 0
    const failingSandbox = {
      runValidation: async () => {
        attempts += 1
        return {
          verdict: 'fail' as const,
          commands: ['pnpm test'],
          output: `assertion failed on attempt ${attempts}`,
        }
      },
    } as SandboxProvider

    const graph = compileOpenAiHealGraph(
      { git, sandbox: failingSandbox, recorder: createMemoryRecorder() },
      { client, model: 'gpt-6' },
    )

    await graph.invoke({ runId: 'run-retry', repository, baseSha: 'abc', maxAttempts: 2 })

    const secondDiagnose = String(calls[3]?.input)
    assert.match(secondDiagnose, /Candidate 1 was already tried and rejected/)
    assert.match(secondDiagnose, /assertion failed on attempt 1/)
    assert.match(secondDiagnose, /step-3/)
  })

  it('redacts a secret-shaped sandbox output before it reaches the next prompt', async () => {
    const { calls, client } = recordingClient()
    const failingSandbox = {
      runValidation: async () => ({
        verdict: 'fail' as const,
        commands: ['pnpm test'],
        output: 'assertion failed: leaked sk-abcdefghijklmnopqrstuvwx in test output',
      }),
    } as SandboxProvider

    const graph = compileOpenAiHealGraph(
      { git, sandbox: failingSandbox, recorder: createMemoryRecorder() },
      { client, model: 'gpt-6' },
    )

    await graph.invoke({
      runId: 'run-retry-secret',
      repository,
      baseSha: 'abc',
      maxAttempts: 2,
    })

    const secondDiagnose = String(calls[3]?.input)
    assert.equal(secondDiagnose.includes('sk-abcdefghijklmnopqrstuvwx'), false)
    assert.match(secondDiagnose, /\[redacted\]/)
  })

  it('keeps the raw job log out of the prompt', async () => {
    const { calls, client } = recordingClient()
    const noisyGit = {
      ...git,
      getFailureLogs: async () =>
        [
          '2024-01-01T00:00:00.0000000Z ##[group]Run actions/checkout@v4',
          `2024-01-01T00:00:00.0000000Z ::add-mask::${'x'.repeat(40)}`,
          '2024-01-01T00:00:00.0000000Z ##[endgroup]',
          ...Array.from({ length: 400 }, (_, index) => `noise line ${index}`),
          'Error: expected 2 to equal 3 at src/sum.ts:7',
        ].join('\n'),
    } as GitProvider

    const graph = compileOpenAiHealGraph(
      { git: noisyGit, sandbox, recorder: createMemoryRecorder() },
      { client, model: 'gpt-6' },
    )
    await graph.invoke({ runId: 'run-noise', repository, baseSha: 'abc' })

    const diagnoseInput = String(calls[0]?.input)
    assert.match(diagnoseInput, /src\/sum\.ts:7/)
    assert.equal(diagnoseInput.includes('noise line 0'), false)
    assert.equal(diagnoseInput.includes('##[group]'), false)
  })

  it('routes every step and attempt of a run to one prompt cache, without the run id', async () => {
    const { calls, client } = recordingClient()
    const failingSandbox = {
      runValidation: async () => ({ verdict: 'fail' as const, commands: [], output: 'no' }),
    } as SandboxProvider
    const graph = compileOpenAiHealGraph(
      { git, sandbox: failingSandbox, recorder: createMemoryRecorder() },
      { client, model: 'gpt-6' },
    )

    await graph.invoke({ runId: 'run-cache-key', repository, baseSha: 'abc', maxAttempts: 2 })

    const keys = calls.map((call) => call.prompt_cache_key)
    assert.equal(calls.length, 6)
    assert.equal(new Set(keys).size, 1, 'the key is the same for both attempts')
    assert.match(String(keys[0]), /^[0-9a-f]{32}$/)
    assert.equal(String(keys[0]).includes('run-cache-key'), false)
  })

  it('gives different runs different cache keys', async () => {
    const { calls, client } = recordingClient()
    const otherGit = {
      ...git,
      getFailureLogs: async () => 'Error: other at src/b.ts:3',
    } as GitProvider
    const recorder = createMemoryRecorder()

    await compileOpenAiHealGraph({ git, sandbox, recorder }, { client, model: 'gpt-6' }).invoke({
      runId: 'run-a',
      repository,
      baseSha: 'abc',
    })
    await compileOpenAiHealGraph(
      { git: otherGit, sandbox, recorder },
      { client, model: 'gpt-6' },
    ).invoke({ runId: 'run-b', repository, baseSha: 'abc' })

    assert.notEqual(calls[0]?.prompt_cache_key, calls[3]?.prompt_cache_key)
  })

  it('puts each model call on the feed with its timing and cache hits', async () => {
    const recorder = createMemoryRecorder()
    let n = 0
    const client: OpenAiResponses = {
      create: async () => {
        n += 1
        return {
          output_text: `step-${n}`,
          usage: {
            input_tokens: 1200,
            output_tokens: 80,
            input_tokens_details: { cached_tokens: n === 1 ? 0 : 1024 },
            output_tokens_details: { reasoning_tokens: 30 },
          },
        }
      },
    }
    const graph = compileOpenAiHealGraph({ git, sandbox, recorder }, { client, model: 'gpt-6' })

    await graph.invoke({ runId: 'run-usage', repository, baseSha: 'abc' })

    const modelCalls = recorder.audits.filter((row) => row.eventType === 'model.call')
    assert.deepEqual(
      modelCalls.map((row) => [row.payload.step, row.payload.effort, row.payload.status]),
      [
        ['diagnose', 'low', 'completed'],
        ['plan', 'low', 'completed'],
        ['patch', 'high', 'completed'],
      ],
    )
    assert.deepEqual(
      modelCalls.map((row) => row.payload.usage),
      [
        { input: 1200, cached: 0, output: 80, reasoning: 30 },
        { input: 1200, cached: 1024, output: 80, reasoning: 30 },
        { input: 1200, cached: 1024, output: 80, reasoning: 30 },
      ],
      'the counts survive the redaction of the audit payload',
    )
    for (const row of modelCalls) {
      assert.equal(typeof row.payload.durationMs, 'number')
    }
  })

  it('records a cut-off call before rejecting it', async () => {
    const seen: string[] = []
    const client: OpenAiResponses = {
      create: async () => ({
        output_text: '--- a',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    }

    await assert.rejects(
      createOpenAiLlm({ client, onCall: (call) => void seen.push(call.status) }).patch({
        failure: { firstError: null, location: null, failingTests: [], excerpt: '' },
        sources: [],
        diagnostics: 'd',
        plan: 'p',
        previousAttempt: null,
      }),
      LlmTruncatedError,
    )
    assert.deepEqual(seen, ['incomplete'])
  })
})
