import {
  RunDetailSchema,
  RunSummarySchema,
  type RunDetail,
  type RunSummary,
} from '@adamant/contract'
import { z } from 'zod'
import { type CliConfig, resolveApiUrl } from './config.ts'

const HealthSchema = z.object({ status: z.literal('ok') }).strict()
const RunListSchema = z.object({ runs: z.array(RunSummarySchema) }).strict()
const CreateRunSchema = z.object({ run: RunSummarySchema }).strict()

// Every call is a few milliseconds of indexed reads; past this the API is
// hung or unreachable, and the CLI says so instead of spinning forever.
const DEFAULT_TIMEOUT_MS = 10_000

const SESSION_HINT = 'Create one with `pnpm --filter @adamant/server session:create`.'

const NETWORK_ERRORS: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'DNS lookup failed',
  ETIMEDOUT: 'connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  CERT_HAS_EXPIRED: 'TLS certificate expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed TLS certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed TLS certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate not trusted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match the host',
}

export class ApiError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export type CreateRunResult = {
  run: RunSummary
  created: boolean
}

export type AdamantApiOptions = {
  /** Bound on one request, including its body. Not applied to the activity stream. */
  timeoutMs?: number
}

function isAbort(error: unknown): error is DOMException {
  return (
    error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

function networkCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined
  const code = (cause as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

export class AdamantApi {
  private readonly config: CliConfig
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(config: CliConfig, fetchImpl: typeof fetch = fetch, options: AdamantApiOptions = {}) {
    this.config = config
    this.fetchImpl = fetchImpl
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get origin(): string {
    return this.config.apiUrl.origin
  }

  async health(signal?: AbortSignal): Promise<'ok'> {
    const response = await this.request('GET', '/health', { signal })
    return (await this.parse(response, HealthSchema, 'GET /health')).status
  }

  async listRuns(signal?: AbortSignal): Promise<readonly RunSummary[]> {
    const response = await this.request('GET', '/runs', { signal })
    return (await this.parse(response, RunListSchema, 'GET /runs')).runs
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<RunDetail> {
    const response = await this.request('GET', `/runs/${encodeURIComponent(runId)}`, { signal })
    return this.parse(response, RunDetailSchema, 'GET /runs/:id')
  }

  async createRun(
    input: { repositoryId: string; sourceSha: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<CreateRunResult> {
    const response = await this.request('POST', '/runs', {
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        repositoryId: input.repositoryId,
        sourceSha: input.sourceSha,
      }),
    })
    return {
      run: (await this.parse(response, CreateRunSchema, 'POST /runs')).run,
      created: response.status === 202,
    }
  }

  /**
   * Opens `GET /activity`. Unbounded on purpose: the stream lives as long as
   * `signal`, so the caller owns connect and idle timeouts.
   */
  async openActivity(lastEventId?: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.request('GET', '/activity', {
      signal,
      timeout: false,
      headers: {
        Accept: 'text/event-stream',
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
    })
    if (!response.body) {
      throw new ApiError('The activity stream did not include a response body.')
    }
    return response
  }

  private async request(
    method: 'GET' | 'POST',
    pathname: string,
    options: {
      signal?: AbortSignal | undefined
      timeout?: boolean
      headers?: Record<string, string>
      body?: string
    },
  ): Promise<Response> {
    const signals = [
      ...(options.signal ? [options.signal] : []),
      ...(options.timeout === false ? [] : [AbortSignal.timeout(this.timeoutMs)]),
    ]
    let response: Response
    try {
      response = await this.fetchImpl(resolveApiUrl(this.config, pathname), {
        method,
        headers: {
          Accept: 'application/json',
          ...options.headers,
          // Not the ADAMANT_SESSION header the API also reads: proxies such as
          // nginx drop header names with underscores, which turned a hosted
          // deployment into a 401 on every call.
          Authorization: `Bearer ${this.config.session}`,
        },
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
      })
    } catch (error) {
      throw this.describeFailure(error)
    }
    if (response.ok) return response

    const body: unknown = await response.json().catch(() => null)
    if (response.status === 401) {
      throw new ApiError(
        `${this.origin} rejected ADAMANT_SESSION (401): it is unknown, expired or revoked. ${SESSION_HINT}`,
        401,
      )
    }
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `${method} ${pathname} on ${this.origin} failed with ${response.status}. Is ADAMANT_API_URL an Adamant API?`
    throw new ApiError(message, response.status)
  }

  private async parse<T>(response: Response, schema: z.ZodType<T>, call: string): Promise<T> {
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      if (isAbort(error)) throw this.describeFailure(error)
      body = undefined
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      // A schema dump means nothing to the person at the terminal; the usual
      // cause is ADAMANT_API_URL pointing at something that is not this API.
      throw new ApiError(
        `${call} on ${this.origin} returned a response this CLI does not understand. Is ADAMANT_API_URL an Adamant API of the same version?`,
        response.status,
      )
    }
    return parsed.data
  }

  private describeFailure(error: unknown): Error {
    if (isAbort(error)) {
      if (error.name === 'TimeoutError') {
        return new ApiError(
          `${this.origin} did not answer within ${Math.round(this.timeoutMs / 1_000)} s.`,
        )
      }
      // The caller cancelled; it already knows why.
      return error
    }
    const code = networkCode(error)
    const reason = code ? ` (${NETWORK_ERRORS[code] ?? code})` : ''
    return new ApiError(
      `Could not reach the Adamant API at ${this.origin}${reason}. Is it running? Set ADAMANT_API_URL to use another.`,
    )
  }
}
