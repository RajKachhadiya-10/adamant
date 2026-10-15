import { createHash } from 'node:crypto'
import { type BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import {
  Agent,
  MaxTurnsExceededError,
  OpenAIProvider,
  Runner,
  tool,
  type FunctionTool,
} from '@openai/agents'
import OpenAI from 'openai'
import { z } from 'zod'
import {
  type GitProvider,
  type LlmProvider,
  LlmTruncatedError,
  type PreviousAttempt,
  type SandboxProvider,
  type SourceExcerpt,
} from './deps.ts'
import { compileHealGraph } from './graph.ts'
import { createOpenAiLlm } from './openai.ts'
import { normalizePatch } from './patch.ts'
import { redactText, type RunRecorder } from './recorder.ts'
import { describeSources } from './sources.ts'
import { SecureGitClient } from './tools.ts'
import { describeFailure, type FailureContext } from './triage.ts'

/**
 * The heal's model steps as OpenAI Agents SDK agents that work the repository
 * themselves. The one-shot provider (openai.ts) saw only the log and the files the
 * log named, and wrote a diff blind. Here an investigator lists, reads and searches
 * the checkout before it names a cause, and a fixer can try its diff in the sandbox
 * and revise it before handing it back.
 *
 * What stays out of the model's reach: the graph still applies the returned diff,
 * runs the sandbox itself, records that verdict, and only then pushes, opens the PR
 * and merges through the gateway. A try here is evidence for the model, never the
 * merge gate. Every tool goes through SecureGitClient (allowlisted, logged with the
 * run id) or is logged here, and tool output is redacted and bounded.
 */
export const ALLOWED_AGENT_TOOLS = ['list_files', 'read_file', 'search', 'try_patch'] as const

const DEFAULT_MODEL = 'gpt-6'
/** Turns are model calls; each tool round trip is one. */
const INVESTIGATE_TURNS = 24
const FIX_TURNS = 30
/** Sandbox runs per patch request. Each is an install and a test run. */
const DEFAULT_TRIES = 3
const MAX_LISTED = 400
const MAX_READ_LINES = 400
const MAX_SEARCH_LINES = 120
const MAX_LINE_CHARS = 300
const MAX_TRY_OUTPUT_CHARS = 8_000
const MAX_INPUT_CHARS = 24_000

/** The checkout, through the gateway. SecureGitClient is one. */
export interface Workbench {
  listFiles(): Promise<string[]>
  search(text: string): Promise<string>
  readFile(path: string): Promise<{ path: string; text: string } | null>
  applyPatch(patch: string): Promise<void>
  resetToBase(): Promise<void>
}

export interface AutonomousOptions {
  readonly apiKey?: string
  readonly model?: string
  /** Tests pass a runner whose model is scripted. */
  readonly runner?: Runner
  readonly tries?: number
  /** The one-shot provider, used when an agent run breaks rather than fails. */
  readonly fallback?: LlmProvider
}

const Findings = z.object({
  diagnosis: z
    .string()
    .describe('The root cause, with the evidence: file:line and what the code does there.'),
  plan: z.string().describe('The smallest code change that fixes it, file by file.'),
})

const Fix = z.object({
  patch: z.string().describe('The final unified diff against the original code.'),
  checked: z
    .enum(['passed', 'failed', 'not_run'])
    .describe('What the last try_patch of this exact diff returned.'),
})

const SHARED_RULES = [
  'Never repeat secrets, tokens, credentials or environment values.',
  'Do not weaken, skip or delete tests, and do not edit CI workflows to hide the failure.',
  'If the failure is infrastructure, a missing secret, or a flaky network, say so plainly.',
]

const INVESTIGATOR_INSTRUCTIONS = [
  "You are Adamant's investigator. A GitHub Actions check failed on the default branch.",
  'Find the root cause in this repository before you answer. Use list_files, search and',
  'read_file to look at the code the failure touches and the code that calls it; do not guess.',
  'When an earlier candidate is shown, it already failed: explain why and plan differently.',
  ...SHARED_RULES,
].join('\n')

const FIXER_INSTRUCTIONS = [
  "You are Adamant's fixer. Write the smallest unified diff that implements the plan and",
  'makes the failing check pass.',
  'Read each file with read_file before you change it: context and removed lines must match',
  'it character for character. Paths in the diff are relative to the repository root',
  '(a/src/x.ts, b/src/x.ts).',
  "Then call try_patch with the whole diff: it applies it to the original code and runs the project's",
  'checks in the sandbox. Read the output, fix the diff, and try again until it passes or no',
  'tries are left. Every try starts from the original code; send the full diff each time.',
  'Return the last diff you tried, and whether it passed.',
  ...SHARED_RULES,
].join('\n')

function bounded(text: string, max = MAX_INPUT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`
}

function clip(line: string): string {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}…`
}

function previous(attempt: PreviousAttempt | null): string {
  if (!attempt) return ''
  return [
    `## Candidate ${attempt.attemptNumber} already failed`,
    attempt.patch ? `\`\`\`diff\n${bounded(attempt.patch, 8_000)}\n\`\`\`` : '(no usable diff)',
    'Why it failed:',
    bounded(redactText(attempt.failure), 6_000),
  ].join('\n')
}

function brief(failure: FailureContext, sources: readonly SourceExcerpt[]): string {
  return [describeFailure(failure), describeSources(sources)].filter(Boolean).join('\n\n')
}

/** list_files, read_file and search. Read-only; both agents get them. */
export function readTools(bench: Workbench): FunctionTool<unknown, never, string>[] {
  const listFiles = tool({
    name: 'list_files',
    description: 'List tracked files in the repository, or only those under one directory.',
    parameters: z.object({
      under: z
        .string()
        .max(300)
        .nullable()
        .describe('A directory such as "src/", or null for the whole repository.'),
    }),
    async execute({ under }) {
      const prefix = under ? under.replace(/^\.\//, '').replace(/\/?$/, '/') : ''
      const files = (await bench.listFiles()).filter((file) => file.startsWith(prefix))
      if (files.length === 0) return `No tracked files under ${under ?? 'the root'}.`
      const shown = files.slice(0, MAX_LISTED).join('\n')
      return files.length > MAX_LISTED
        ? `${shown}\n… ${files.length - MAX_LISTED} more; narrow it with "under".`
        : shown
    },
  })

  const readFile = tool({
    name: 'read_file',
    description: 'Read a file from the repository, with line numbers.',
    parameters: z.object({
      path: z.string().min(1).max(500).describe('Path from the repository root.'),
      startLine: z.number().int().min(1).nullable().describe('First line, 1-based; null for 1.'),
      lineCount: z
        .number()
        .int()
        .min(1)
        .max(MAX_READ_LINES)
        .nullable()
        .describe(`How many lines; null for up to ${MAX_READ_LINES}.`),
    }),
    async execute({ path, startLine, lineCount }) {
      const file = await bench.readFile(path)
      if (!file) return `No such file in the repository: ${path}`
      const lines = file.text.split('\n')
      const from = Math.min(startLine ?? 1, Math.max(lines.length, 1))
      const to = Math.min(lines.length, from - 1 + (lineCount ?? MAX_READ_LINES))
      const body = lines
        .slice(from - 1, to)
        .map((line, index) => `${String(from + index).padStart(5)}  ${clip(line)}`)
        .join('\n')
      return redactText(`${file.path} (lines ${from}-${to} of ${lines.length})\n${body}`)
    },
  })

  const search = tool({
    name: 'search',
    description: 'Find lines in tracked files that contain this exact text.',
    parameters: z.object({ text: z.string().min(2).max(200) }),
    async execute({ text }) {
      const lines = (await bench.search(text)).split('\n').filter(Boolean)
      if (lines.length === 0) return 'No matches.'
      const shown = lines.slice(0, MAX_SEARCH_LINES).map(clip).join('\n')
      return redactText(
        lines.length > MAX_SEARCH_LINES
          ? `${shown}\n… ${lines.length - MAX_SEARCH_LINES} more matches; search for something narrower.`
          : shown,
      )
    },
  })

  return [listFiles, readFile, search] as FunctionTool<unknown, never, string>[]
}

/**
 * try_patch: apply a candidate to the clean base, run the sandbox, put the base back.
 * Bounded per patch request, logged as a tool call, and put on the feed so the
 * terminal shows the agent working.
 */
export function tryPatchTool(
  bench: Workbench,
  sandbox: SandboxProvider,
  recorder: RunRecorder,
  tries: number,
): FunctionTool<unknown, never, string> {
  let used = 0
  return tool({
    name: 'try_patch',
    description:
      "Apply a unified diff to the original code and run the project's checks in the sandbox. Returns pass, or the failure output.",
    parameters: z.object({ patch: z.string().min(1).max(200_000) }),
    async execute({ patch }) {
      if (used >= tries) {
        return `No sandbox tries left (${tries} used). Return your best diff now.`
      }
      used += 1
      const attempt = used
      const diff = normalizePatch(patch)
      const startedAt = new Date()
      try {
        try {
          await bench.applyPatch(diff)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          await recorder.audit('run.agent_tried', { try: attempt, verdict: 'did not apply' })
          return `The diff did not apply: ${redactText(reason)}\nRead the files again and match their lines exactly.`
        }
        const outcome = await sandbox.runValidation({
          attemptNumber: 0,
          candidateHash: createHash('sha256').update(diff).digest('hex'),
        })
        await recorder.toolInvocation({
          tool: 'sandbox_try_patch',
          args: { try: attempt, bytes: diff.length, verdict: outcome.verdict },
          outcome: 'ok',
          startedAt,
        })
        await recorder.audit('run.agent_tried', { try: attempt, verdict: outcome.verdict })
        if (outcome.verdict === 'pass') return 'pass: the checks passed with this diff.'
        const output = redactText(outcome.output)
        return `${outcome.verdict}: the checks did not pass.\n${output.slice(-MAX_TRY_OUTPUT_CHARS)}`
      } finally {
        // The next read_file must see the original code, not this candidate.
        await bench.resetToBase()
      }
    },
  }) as FunctionTool<unknown, never, string>
}

export function defaultRunner(apiKey: string): Runner {
  return new Runner({
    modelProvider: new OpenAIProvider({ openAIClient: new OpenAI({ apiKey }) }),
    // Traces would carry the repository's code and logs to OpenAI's dashboard.
    tracingDisabled: true,
  })
}

export function createAutonomousLlm(
  bench: Workbench,
  sandbox: SandboxProvider,
  recorder: RunRecorder,
  options: AutonomousOptions = {},
): LlmProvider {
  const model = options.model || process.env.OPENAI_MODEL || DEFAULT_MODEL
  const runner =
    options.runner ??
    defaultRunner(
      options.apiKey ??
        process.env.OPENAI_API_KEY ??
        (() => {
          throw new Error('OPENAI_API_KEY is required in the worker')
        })(),
    )
  const fallback = options.fallback
  const tries = options.tries ?? DEFAULT_TRIES
  // The investigator writes the plan with the diagnosis; plan() hands it back.
  const plans = new Map<string, string>()

  const investigator = new Agent({
    name: 'Adamant investigator',
    instructions: INVESTIGATOR_INSTRUCTIONS,
    model,
    modelSettings: { reasoning: { effort: 'medium' } },
    tools: readTools(bench),
    outputType: Findings,
  })

  return {
    async diagnose({ failure, sources, previousAttempt }) {
      try {
        const result = await runner.run(
          investigator,
          [brief(failure, sources), previous(previousAttempt)].filter(Boolean).join('\n\n'),
          { maxTurns: INVESTIGATE_TURNS },
        )
        const findings = result.finalOutput
        if (!findings) throw new Error('The investigator returned nothing.')
        plans.set(findings.diagnosis, findings.plan)
        await recorder.audit('run.investigated', {})
        return findings.diagnosis
      } catch (error) {
        if (!fallback) throw error
        return fallback.diagnose({ failure, sources, previousAttempt })
      }
    },

    async plan(input) {
      const planned = plans.get(input.diagnostics)
      if (planned) return planned
      if (!fallback) throw new Error('No plan was written with this diagnosis.')
      return fallback.plan(input)
    },

    async patch({ failure, sources, diagnostics, plan, previousAttempt }) {
      // Fresh per request: the try budget is per candidate, not per run.
      const fixer = new Agent({
        name: 'Adamant fixer',
        instructions: FIXER_INSTRUCTIONS,
        model,
        modelSettings: { reasoning: { effort: 'high' } },
        tools: [...readTools(bench), tryPatchTool(bench, sandbox, recorder, tries)],
        outputType: Fix,
      })
      const input = [
        brief(failure, sources),
        `## Diagnosis\n${bounded(diagnostics, 8_000)}`,
        `## Plan\n${bounded(plan, 8_000)}`,
        previous(previousAttempt),
      ]
        .filter(Boolean)
        .join('\n\n')
      try {
        const result = await runner.run(fixer, input, { maxTurns: FIX_TURNS })
        const fix = result.finalOutput
        if (!fix?.patch.trim()) throw new LlmTruncatedError('the fixer returned no diff')
        return fix.patch
      } catch (error) {
        // Out of turns is a spent attempt with a known cause, as a cut-off reply is.
        if (error instanceof MaxTurnsExceededError) {
          throw new LlmTruncatedError('the fixer ran out of turns')
        }
        throw error
      }
    },
  }
}

/**
 * The heal graph with the autonomous provider. The workbench is the run's own
 * gateway, so every read and try is scoped to this run and logged under its id.
 */
export function compileAutonomousHealGraph(
  deps: {
    runId: string
    git: GitProvider
    sandbox: SandboxProvider
    recorder: RunRecorder
    autoMerge?: () => Promise<boolean>
  },
  options: AutonomousOptions & { checkpointer?: BaseCheckpointSaver } = {},
) {
  const bench = new SecureGitClient(deps.git, deps.runId, deps.recorder)
  const { checkpointer, ...llmOptions } = options
  const llm = createAutonomousLlm(bench, deps.sandbox, deps.recorder, {
    fallback: createOpenAiLlm({
      ...(llmOptions.apiKey ? { apiKey: llmOptions.apiKey } : {}),
      ...(llmOptions.model ? { model: llmOptions.model } : {}),
    }),
    ...llmOptions,
  })
  return compileHealGraph(
    {
      git: deps.git,
      sandbox: deps.sandbox,
      recorder: deps.recorder,
      llm,
      ...(deps.autoMerge ? { autoMerge: deps.autoMerge } : {}),
    },
    checkpointer ? { checkpointer } : undefined,
  )
}
