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

export class AdamantApi {
  private readonly config: CliConfig
  private readonly fetchImpl: typeof fetch

  constructor(config: CliConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config
    this.fetchImpl = fetchImpl
  }

  async health(signal?: AbortSignal): Promise<'ok'> {
    const response = await this.request('/health', { ...(signal ? { signal } : {}) })
    return HealthSchema.parse(await response.json()).status
  }

  async listRuns(signal?: AbortSignal): Promise<readonly RunSummary[]> {
    const response = await this.request('/runs', { ...(signal ? { signal } : {}) })
    return RunListSchema.parse(await response.json()).runs
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<RunDetail> {
    const response = await this.request(`/runs/${encodeURIComponent(runId)}`, {
      ...(signal ? { signal } : {}),
    })
    return RunDetailSchema.parse(await response.json())
  }

  async createRun(
    input: { repositoryId: string; sourceSha: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<CreateRunResult> {
    const response = await this.request('/runs', {
      method: 'POST',
      ...(signal ? { signal } : {}),
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
      run: CreateRunSchema.parse(await response.json()).run,
      created: response.status === 202,
    }
  }

  async openActivity(lastEventId?: string, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers({ ADAMANT_SESSION: this.config.session })
    if (lastEventId) headers.set('Last-Event-ID', lastEventId)
    const response = await this.fetchImpl(resolveApiUrl(this.config, '/activity'), {
      headers,
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) {
      throw new ApiError(`Unable to open activity stream (${response.status}).`, response.status)
    }
    if (!response.body) {
      throw new ApiError('The activity stream did not include a response body.')
    }
    return response
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('ADAMANT_SESSION', this.config.session)
    headers.set('Accept', 'application/json')
    const response = await this.fetchImpl(resolveApiUrl(this.config, pathname), {
      ...init,
      headers,
    })
    if (response.ok) return response

    const body = await response.json().catch(() => null)
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Adamant API returned ${response.status}.`
    throw new ApiError(message, response.status)
  }
}
