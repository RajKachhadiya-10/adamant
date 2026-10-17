import { createHash } from 'node:crypto'
import { type BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import OpenAI from 'openai'
import { type ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { compileHealGraph } from './graph.ts'
import {
  type GitProvider,
  type LlmProvider,
  LlmTruncatedError,
  type PreviousAttempt,
  type SandboxProvider,
  type SourceExcerpt,
} from './deps.ts'
import { type RunRecorder } from './recorder.ts'
import { describeSources } from './sources.ts'
import { describeFailure, type FailureContext } from './triage.ts'

/**
 * One model for every heal step so prompt caching can hit. Diagnose and plan
 * sort the failure (low effort). The patch writes the diff (high effort).
 * The system text stays identical across calls. Every user message opens with
 * the same failure and source block and puts its own task last, so the three
 * calls of an attempt share that whole block as a cached prefix.
 */
const DEFAULT_MODEL = 'gpt-6'
const MAX_VARIABLE_CHARS = 24_000

const HEAL_INSTRUCTIONS_PROMPT = [
  'You are the Adamant heal agent for a failing GitHub Actions check.',
  'Use only the failure text, source, diagnosis, or plan in the user message.',
  'Never repeat secrets, tokens, credentials, or environment values.',
  'A patch is a unified diff that edits the existing files. Do not rewrite a whole file.',
  'Context and removed lines in a diff must match the source shown, character for character.',
  'When an earlier candidate is shown, it already failed: do not repeat it.',
].join('\n')

/** Usage as the Responses API reports it. All optional: a test double returns none. */
export type OpenAiUsage = {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

export type OpenAiResponses = {
  create(body: ResponseCreateParamsNonStreaming): Promise<{
    output_text: string
    status?: string
    incomplete_details?: { reason?: string } | null
    error?: { message: string } | null
    usage?: OpenAiUsage | null
  }>
}

export type HealStep = 'diagnose' | 'plan' | 'patch'

type Effort = 'low' | 'high'

/**
 * One model call, for the run's feed. `usage.cached` is the prompt-cache hit
 * docs/performance.md asks to watch. The keys avoid the word "token" so the
 * recorder's redaction leaves the counts in place.
 */
export interface ModelCall {
  readonly step: HealStep
  readonly model: string
  readonly effort: Effort
  readonly status: string
  readonly durationMs: number
  readonly usage?: {
    readonly input?: number
    readonly cached?: number
    readonly output?: number
    readonly reasoning?: number
  }
}

export type OpenAiLlmOptions = {
  client?: OpenAiResponses
  model?: string
  apiKey?: string
  /** Called once per model call, as soon as it returns and before its reply is checked. */
  onCall?: (call: ModelCall) => Promise<void> | void
}

function readModel(explicit: string | undefined): string {
  const fromEnv = process.env.OPENAI_MODEL
  return explicit || fromEnv || DEFAULT_MODEL
}

function requireApiKey(explicit: string | undefined): string {
  const key = explicit ?? process.env.OPENAI_API_KEY
  if (!key) {
    throw new Error('OPENAI_API_KEY is required in the worker')
  }
  return key
}

/**
 * One client per key for the life of the worker. The SDK client keeps its
 * connections open, so a run's first call does not pay a new TLS handshake
 * and the heals in flight share one pool instead of opening one each.
 */
const clients = new Map<string, OpenAI>()

/** The SDK client for `apiKey`, shared by the classic steps and the Agents SDK runner. */
export function openAiClient(apiKey: string): OpenAI {
  let client = clients.get(apiKey)
  if (!client) {
    client = new OpenAI({ apiKey })
    clients.set(apiKey, client)
  }
  return client
}

function responsesClient(apiKey: string): OpenAiResponses {
  const openai = openAiClient(apiKey)
  return {
    create(body) {
      return openai.responses.create(body)
    },
  }
}

function tail(text: string): string {
  if (text.length <= MAX_VARIABLE_CHARS) return text
  return text.slice(-MAX_VARIABLE_CHARS)
}

/** Empty when this is the first candidate, so the cached prefix stays stable. */
function describeAttempt(attempt: PreviousAttempt | null): string {
  if (!attempt) return ''

  return [
    '',
    `Candidate ${attempt.attemptNumber} was already tried and rejected.`,
    'Why it failed:',
    tail(attempt.failure),
    ...(attempt.patch ? ['', 'The rejected diff:', tail(attempt.patch)] : []),
    '',
    'Find a different cause or a different fix.',
  ].join('\n')
}

/** The same text for every step of a run, so it is the cached part of each prompt. */
function sharedContext(failure: FailureContext, sources: readonly SourceExcerpt[]): string {
  return [describeFailure(failure), '', describeSources(sources)].join('\n')
}

/**
 * Routes every call that opens with the same block to the same cache. A
 * digest of that block is stable across the steps and attempts of a run,
 * carries nothing from the run itself, and differs between runs whose
 * prefixes differ anyway.
 */
export function promptCacheKey(shared: string): string {
  return createHash('sha256').update(shared).digest('hex').slice(0, 32)
}

function usageOf(usage: OpenAiUsage | null | undefined): ModelCall['usage'] {
  if (!usage) return undefined
  const cached = usage.input_tokens_details?.cached_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  return {
    ...(usage.input_tokens === undefined ? {} : { input: usage.input_tokens }),
    ...(cached === undefined ? {} : { cached }),
    ...(usage.output_tokens === undefined ? {} : { output: usage.output_tokens }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

interface Prompt {
  readonly step: HealStep
  readonly effort: Effort
  /** The block every step of the run opens with. */
  readonly shared: string
  /** This step's own lines, after the shared block; the task is the last one. */
  readonly rest: readonly string[]
}

async function complete(
  client: OpenAiResponses,
  model: string,
  onCall: OpenAiLlmOptions['onCall'],
  prompt: Prompt,
): Promise<string> {
  const startedAt = Date.now()
  const response = await client.create({
    model,
    instructions: HEAL_INSTRUCTIONS_PROMPT,
    input: [prompt.shared, ...prompt.rest].join('\n'),
    reasoning: { effort: prompt.effort },
    prompt_cache_key: promptCacheKey(prompt.shared),
    // CI logs can contain secrets. Do not retain the prompt with OpenAI.
    store: false,
  })
  // Recorded before the reply is judged, so a cut-off or failed call is on
  // the feed with its time and tokens like any other.
  const usage = usageOf(response.usage)
  await onCall?.({
    step: prompt.step,
    model,
    effort: prompt.effort,
    status: response.status ?? 'completed',
    durationMs: Date.now() - startedAt,
    ...(usage ? { usage } : {}),
  })
  if (response.error) {
    throw new Error(`OpenAI heal call failed: ${response.error.message}`)
  }
  // A reply cut off at the output limit still carries output_text. For the
  // patch step that is a fragment of a diff, which applies as garbage.
  if (response.status === 'incomplete') {
    throw new LlmTruncatedError(response.incomplete_details?.reason ?? 'unknown reason')
  }
  const text = response.output_text.trim()
  if (!text) {
    throw new Error('OpenAI returned an empty heal response')
  }
  return text
}

export function createOpenAiLlm(options?: OpenAiLlmOptions): LlmProvider {
  const model = readModel(options?.model)
  const client = options?.client ?? responsesClient(requireApiKey(options?.apiKey))
  const onCall = options?.onCall
  const call = (prompt: Prompt) => complete(client, model, onCall, prompt)

  return {
    diagnose({ failure, sources, previousAttempt }) {
      return call({
        step: 'diagnose',
        effort: 'low',
        shared: sharedContext(failure, sources),
        rest: [
          describeAttempt(previousAttempt),
          '',
          'Task: sort this failure. Name the cause, the file and line when present, and the tests involved.',
        ],
      })
    },
    plan({ failure, sources, diagnostics }) {
      return call({
        step: 'plan',
        effort: 'low',
        shared: sharedContext(failure, sources),
        rest: [
          '',
          'Diagnosis:',
          tail(diagnostics),
          '',
          'Task: write a short repair plan from this diagnosis. Name the files to change and why.',
        ],
      })
    },
    patch({ failure, sources, diagnostics, plan, previousAttempt }) {
      return call({
        step: 'patch',
        effort: 'high',
        shared: sharedContext(failure, sources),
        rest: [
          '',
          'Diagnosis:',
          tail(diagnostics),
          '',
          'Plan:',
          tail(plan),
          describeAttempt(previousAttempt),
          '',
          'Task: write the unified diff for this plan against the source shown. Return the diff only, with no explanation.',
        ],
      })
    },
  }
}

export type OpenAiHealGraphOptions = OpenAiLlmOptions & {
  checkpointer?: BaseCheckpointSaver
}

/** Each call goes on the run's feed: which step, how long, and how much of the prompt was cached. */
function auditModelCalls(recorder: RunRecorder): (call: ModelCall) => Promise<void> {
  return (call) => recorder.audit('model.call', { ...call })
}

/**
 * LangGraph heal loop whose model calls go through the worker's OpenAI key.
 * The client is created here from that key. The API must not build one.
 */
export function compileOpenAiHealGraph(
  deps: {
    git: GitProvider
    sandbox: SandboxProvider
    recorder: RunRecorder
    autoMerge?: () => Promise<boolean>
  },
  options?: OpenAiHealGraphOptions,
) {
  const checkpointer = options?.checkpointer
  return compileHealGraph(
    {
      git: deps.git,
      sandbox: deps.sandbox,
      recorder: deps.recorder,
      llm: createOpenAiLlm({
        ...options,
        onCall: options?.onCall ?? auditModelCalls(deps.recorder),
      }),
      ...(deps.autoMerge ? { autoMerge: deps.autoMerge } : {}),
    },
    checkpointer ? { checkpointer } : undefined,
  )
}
