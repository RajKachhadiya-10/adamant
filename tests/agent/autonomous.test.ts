import { describe, it } from 'node:test'
import * as assert from 'node:assert'
import { Runner, Usage, type Model, type ModelRequest, type ModelResponse } from '@openai/agents'
import {
  ALLOWED_AGENT_TOOLS,
  createAutonomousLlm,
  defaultRunner,
  readTools,
  tryPatchTool,
  type Workbench,
} from '../../server/agent/autonomous.ts'
import {
  LlmTruncatedError,
  type LlmProvider,
  type SandboxOutcome,
} from '../../server/agent/deps.ts'
import { createMemoryRecorder } from '../../server/agent/recorder.ts'
import { SecureGitClient } from '../../server/agent/tools.ts'
import { type FailureContext } from '../../server/agent/triage.ts'

const failure: FailureContext = {
  firstError: 'AssertionError: expected 3 to equal 5',
  location: 'src/sum.ts:2',
  failingTests: ['sum adds'],
  excerpt: 'AssertionError: expected 3 to equal 5',
}

const SOURCE = 'export function sum(a, b) {\n  return a - b\n}\n'
const BAD =
  'diff --git a/src/sum.ts b/src/sum.ts\n--- a/src/sum.ts\n+++ b/src/sum.ts\n@@ -2 +2 @@\n-  return a - b\n+  return a * b\n'
const GOOD =
  'diff --git a/src/sum.ts b/src/sum.ts\n--- a/src/sum.ts\n+++ b/src/sum.ts\n@@ -2 +2 @@\n-  return a - b\n+  return a + b\n'

type Step = { call: string; args: Record<string, unknown> }[] | { final: Record<string, unknown> }

/** A model that plays back a script: tool calls, then a final structured answer. */
function scripted(steps: Step[], seen: ModelRequest[] = []): Runner {
  let index = 0
  const model: Model = {
    async getResponse(request): Promise<ModelResponse> {
      seen.push(request)
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      if (!step) throw new Error('script is empty')
      const output: ModelResponse['output'] =
        'final' in step
          ? [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: JSON.stringify(step.final) }],
              },
            ]
          : step.map((call, n) => ({
              type: 'function_call',
              callId: `call-${index}-${n}`,
              name: call.call,
              arguments: JSON.stringify(call.args),
              status: 'completed',
            }))
      return { usage: new Usage(), output }
    },
    getStreamedResponse() {
      throw new Error('not streamed')
    },
  }
  return new Runner({ modelProvider: { getModel: () => model }, tracingDisabled: true })
}

function bench(overrides: Partial<Workbench> = {}) {
  const journal = { applied: [] as string[], resets: 0, searched: [] as string[] }
  const workbench: Workbench = {
    listFiles: async () => ['package.json', 'src/sum.ts', 'test/sum.test.ts'],
    search: async (text) => {
      journal.searched.push(text)
      return 'src/sum.ts:1:export function sum(a, b) {\ntest/sum.test.ts:3:  expect(sum(2, 3)).toBe(5)\n'
    },
    readFile: async (path) => (path === 'src/sum.ts' ? { path, text: SOURCE } : null),
    applyPatch: async (patch) => {
      journal.applied.push(patch)
    },
    resetToBase: async () => {
      journal.resets += 1
    },
    ...overrides,
  }
  return { workbench, journal }
}

function sandbox(verdicts: SandboxOutcome['verdict'][]) {
  let runs = 0
  return {
    get runs() {
      return runs
    },
    async runValidation(): Promise<SandboxOutcome> {
      const verdict = verdicts[Math.min(runs, verdicts.length - 1)] ?? 'pass'
      runs += 1
      return {
        verdict,
        commands: ['npm test'],
        output:
          verdict === 'pass'
            ? 'ok'
            : 'FAIL sum adds: expected 6 to equal 5 token ghp_abcdefghijklmnopqrstuv',
      }
    },
  }
}

const toolOutputs = (requests: ModelRequest[]) =>
  requests.flatMap((request) =>
    (Array.isArray(request.input) ? request.input : [])
      .filter((item) => item.type === 'function_call_result')
      .map((item) => {
        const output = (item as { output: unknown }).output
        if (typeof output === 'string') return output
        // The SDK wraps a string result as { type: 'text', text }.
        const text = (output as { text?: unknown } | null)?.text
        return typeof text === 'string' ? text : JSON.stringify(output)
      }),
  )

describe('autonomous heal agents', () => {
  it('only exposes the allowlisted tools', () => {
    const { workbench } = bench()
    const names = [
      ...readTools(workbench),
      tryPatchTool(workbench, sandbox(['pass']), createMemoryRecorder(), 1),
    ].map((tool) => tool.name)
    assert.deepStrictEqual(names, [...ALLOWED_AGENT_TOOLS])
  })

  it('investigates with the tools, then hands back the diagnosis and its plan', async () => {
    const recorder = createMemoryRecorder()
    const { workbench, journal } = bench()
    const seen: ModelRequest[] = []
    const llm = createAutonomousLlm(workbench, sandbox(['pass']), recorder, {
      runner: scripted(
        [
          [{ call: 'list_files', args: { under: 'src' } }],
          [
            { call: 'read_file', args: { path: 'src/sum.ts', startLine: null, lineCount: null } },
            { call: 'search', args: { text: 'sum(' } },
          ],
          { final: { diagnosis: 'sum() subtracts at src/sum.ts:2', plan: 'Use + in sum()' } },
        ],
        seen,
      ),
    })

    const diagnosis = await llm.diagnose({ failure, sources: [], previousAttempt: null })
    assert.strictEqual(diagnosis, 'sum() subtracts at src/sum.ts:2')
    assert.strictEqual(
      await llm.plan({ failure, sources: [], diagnostics: diagnosis }),
      'Use + in sum()',
    )
    const outputs = toolOutputs(seen)
    assert.ok(
      outputs.some((text) => text === 'src/sum.ts'),
      outputs.join('\n---\n'),
    )
    assert.ok(outputs.some((text) => text.includes('    2    return a - b')))
    assert.deepStrictEqual(journal.searched, ['sum('])
    assert.ok(recorder.audits.some((audit) => audit.eventType === 'run.investigated'))
  })

  it('tries a diff, reads the failure, and returns the one that passed', async () => {
    const recorder = createMemoryRecorder()
    const { workbench, journal } = bench()
    const checks = sandbox(['fail', 'pass'])
    const seen: ModelRequest[] = []
    const llm = createAutonomousLlm(workbench, checks, recorder, {
      runner: scripted(
        [
          [{ call: 'try_patch', args: { patch: BAD } }],
          [{ call: 'try_patch', args: { patch: GOOD } }],
          { final: { patch: GOOD, checked: 'passed' } },
        ],
        seen,
      ),
    })

    const patch = await llm.patch({
      failure,
      sources: [],
      diagnostics: 'sum() subtracts',
      plan: 'Use +',
      previousAttempt: null,
    })
    assert.strictEqual(patch, GOOD)
    assert.strictEqual(checks.runs, 2)
    assert.deepStrictEqual(journal.applied, [BAD, GOOD])
    // Each try put the original code back, so later reads are of the base.
    assert.strictEqual(journal.resets, 2)
    assert.deepStrictEqual(
      recorder.audits.filter((a) => a.eventType === 'run.agent_tried').map((a) => a.payload),
      [
        { try: 1, verdict: 'fail' },
        { try: 2, verdict: 'pass' },
      ],
    )
    assert.strictEqual(recorder.tools.filter((t) => t.tool === 'sandbox_try_patch').length, 2)
    const outputs = toolOutputs(seen)
    assert.ok(outputs.some((text) => text.startsWith('fail: the checks did not pass.')))
    // Sandbox output goes back to the model redacted.
    assert.ok(!outputs.some((text) => text.includes('ghp_abcdefghijklmnopqrstuv')))
    assert.ok(outputs.some((text) => text === 'pass: the checks passed with this diff.'))
  })

  it('stops running the sandbox when the tries are spent', async () => {
    const { workbench } = bench()
    const checks = sandbox(['fail'])
    const seen: ModelRequest[] = []
    const llm = createAutonomousLlm(workbench, checks, createMemoryRecorder(), {
      tries: 1,
      runner: scripted(
        [
          [{ call: 'try_patch', args: { patch: BAD } }],
          [{ call: 'try_patch', args: { patch: GOOD } }],
          { final: { patch: GOOD, checked: 'not_run' } },
        ],
        seen,
      ),
    })
    await llm.patch({ failure, sources: [], diagnostics: 'd', plan: 'p', previousAttempt: null })
    assert.strictEqual(checks.runs, 1)
    assert.ok(toolOutputs(seen).some((text) => text.startsWith('No sandbox tries left (1 used)')))
  })

  it('reports a diff that does not apply without running the sandbox, and still resets', async () => {
    const recorder = createMemoryRecorder()
    const { workbench, journal } = bench({
      applyPatch: async () => {
        throw new Error('git apply failed (1): error: patch failed: src/sum.ts:2')
      },
    })
    const checks = sandbox(['pass'])
    const seen: ModelRequest[] = []
    const llm = createAutonomousLlm(workbench, checks, recorder, {
      runner: scripted(
        [
          [{ call: 'try_patch', args: { patch: BAD } }],
          { final: { patch: GOOD, checked: 'not_run' } },
        ],
        seen,
      ),
    })
    await llm.patch({ failure, sources: [], diagnostics: 'd', plan: 'p', previousAttempt: null })
    assert.strictEqual(checks.runs, 0)
    assert.strictEqual(journal.resets, 1)
    assert.ok(toolOutputs(seen).some((text) => text.startsWith('The diff did not apply')))
    assert.deepStrictEqual(
      recorder.audits.find((a) => a.eventType === 'run.agent_tried')?.payload,
      { try: 1, verdict: 'did not apply' },
    )
  })

  it('treats running out of turns as a spent attempt, not a crash', async () => {
    const { workbench } = bench()
    const llm = createAutonomousLlm(workbench, sandbox(['pass']), createMemoryRecorder(), {
      runner: scripted([[{ call: 'list_files', args: { under: null } }]]),
    })
    await assert.rejects(
      llm.patch({ failure, sources: [], diagnostics: 'd', plan: 'p', previousAttempt: null }),
      (error) => error instanceof LlmTruncatedError && /ran out of turns/.test(error.message),
    )
  })

  it('treats an empty diff as a spent attempt', async () => {
    const { workbench } = bench()
    const llm = createAutonomousLlm(workbench, sandbox(['pass']), createMemoryRecorder(), {
      runner: scripted([{ final: { patch: '  ', checked: 'not_run' } }]),
    })
    await assert.rejects(
      llm.patch({ failure, sources: [], diagnostics: 'd', plan: 'p', previousAttempt: null }),
      LlmTruncatedError,
    )
  })

  it('falls back to the one-shot provider when the investigator breaks', async () => {
    const calls: string[] = []
    const fallback: LlmProvider = {
      diagnose: async () => {
        calls.push('diagnose')
        return 'fallback diagnosis'
      },
      plan: async () => {
        calls.push('plan')
        return 'fallback plan'
      },
      patch: async () => GOOD,
    }
    const broken = new Runner({
      modelProvider: {
        getModel: () => ({
          getResponse: async () => {
            throw new Error('503 from the model API')
          },
          getStreamedResponse: () => {
            throw new Error('not streamed')
          },
        }),
      },
      tracingDisabled: true,
    })
    const { workbench } = bench()
    const llm = createAutonomousLlm(workbench, sandbox(['pass']), createMemoryRecorder(), {
      runner: broken,
      fallback,
    })
    const diagnosis = await llm.diagnose({ failure, sources: [], previousAttempt: null })
    assert.strictEqual(diagnosis, 'fallback diagnosis')
    assert.strictEqual(
      await llm.plan({ failure, sources: [], diagnostics: diagnosis }),
      'fallback plan',
    )
    assert.deepStrictEqual(calls, ['diagnose', 'plan'])
  })

  it('shows earlier failed candidates to the investigator', async () => {
    const { workbench } = bench()
    const seen: ModelRequest[] = []
    const llm = createAutonomousLlm(workbench, sandbox(['pass']), createMemoryRecorder(), {
      runner: scripted([{ final: { diagnosis: 'd2', plan: 'p2' } }], seen),
    })
    await llm.diagnose({
      failure,
      sources: [],
      previousAttempt: {
        attemptNumber: 1,
        patch: BAD,
        failure: 'still red: expected 6 to equal 5',
      },
    })
    const input = JSON.stringify(seen[0]?.input)
    assert.match(input, /Candidate 1 already failed/)
    assert.match(input, /still red: expected 6 to equal 5/)
  })

  it('reads through the run gateway, which logs each call with the run id', async () => {
    const recorder = createMemoryRecorder()
    const git = {
      fetch: async () => {},
      checkout: async () => {},
      applyPatch: async () => {},
      commit: async () => {},
      push: async () => {},
      openPr: async () => ({ number: 1, url: 'u' }),
      mergePr: async () => {},
      getFailureLogs: async () => '',
      readFile: async (path: string) => (path === 'src/sum.ts' ? { path, text: SOURCE } : null),
      resetToBase: async () => {},
      listFiles: async () => ['src/sum.ts'],
      search: async () => '',
    }
    const gateway = new SecureGitClient(git, 'run-42', recorder)
    const llm = createAutonomousLlm(gateway, sandbox(['pass']), recorder, {
      runner: scripted([
        [
          { call: 'list_files', args: { under: null } },
          {
            call: 'read_file',
            args: { path: '../../etc/passwd', startLine: null, lineCount: null },
          },
          { call: 'search', args: { text: '--force' } },
        ],
        { final: { diagnosis: 'd', plan: 'p' } },
      ]),
    })
    await llm.diagnose({ failure, sources: [], previousAttempt: null })
    assert.deepStrictEqual(
      recorder.tools.map((t) => t.tool),
      ['git_list_files', 'git_read_file', 'git_search'],
    )
  })

  it('never sends traces to OpenAI', () => {
    assert.strictEqual(defaultRunner('sk-test').config.tracingDisabled, true)
  })

  it('routes both agents of a run to one prompt cache and puts each run on the feed', async () => {
    const recorder = createMemoryRecorder()
    const { workbench } = bench()
    const seen: ModelRequest[] = []
    const llm = createAutonomousLlm(workbench, sandbox(['pass']), recorder, {
      runner: scripted(
        [{ final: { diagnosis: 'd', plan: 'p' } }, { final: { patch: GOOD, checked: 'passed' } }],
        seen,
      ),
    })

    const diagnosis = await llm.diagnose({ failure, sources: [], previousAttempt: null })
    await llm.patch({
      failure,
      sources: [],
      diagnostics: diagnosis,
      plan: 'p',
      previousAttempt: null,
    })

    const keys = seen.map((request) => request.modelSettings.providerData?.prompt_cache_key)
    assert.strictEqual(seen.length, 2)
    assert.match(String(keys[0]), /^[0-9a-f]{32}$/)
    assert.strictEqual(keys[0], keys[1], "the fixer reuses the investigator's cache")

    const runs = recorder.audits.filter((row) => row.eventType === 'agent.run')
    assert.deepStrictEqual(
      runs.map((row) => [row.payload.step, row.payload.requests]),
      [
        ['investigate', 1],
        ['fix', 1],
      ],
    )
    assert.deepStrictEqual(runs[0]?.payload.usage, { input: 0, cached: 0, output: 0, reasoning: 0 })
    assert.strictEqual(typeof runs[0]?.payload.durationMs, 'number')
  })

  it('tries a patch against the failing tests first', async () => {
    const { workbench } = bench()
    const inputs: { focus?: readonly string[] }[] = []
    const trying = {
      async runValidation(input: { focus?: readonly string[] }): Promise<SandboxOutcome> {
        inputs.push(input)
        return { verdict: 'pass', commands: ['npm test'], output: 'ok' }
      },
    }
    const llm = createAutonomousLlm(workbench, trying, createMemoryRecorder(), {
      runner: scripted([
        [{ call: 'try_patch', args: { patch: GOOD } }],
        { final: { patch: GOOD, checked: 'passed' } },
      ]),
    })

    await llm.patch({ failure, sources: [], diagnostics: 'd', plan: 'p', previousAttempt: null })

    assert.deepStrictEqual(
      inputs.map((input) => input.focus),
      [['sum adds']],
    )
  })
})
