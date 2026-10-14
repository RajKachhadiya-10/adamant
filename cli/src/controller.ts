import { randomUUID } from 'node:crypto'
import { type AuditEvent, type GithubInstallationStatus, type RunSummary } from '@adamant/contract'
import { type AdamantApi } from './api.ts'
import { commandDefinitions, parseCommand } from './commands.ts'
import { openInstallUrl } from './open.ts'
import { followActivity, type ActivityEvent, type FollowActivityOptions } from './sse.ts'

export type OutputLine = {
  id: string
  tone: 'muted' | 'normal' | 'success' | 'error' | 'accent'
  text: string
  /** Set on a `/runs` row, so the interface can select it and open the run. */
  runId?: string
}

export type CommandResult =
  | {
      kind: 'output'
      lines: readonly OutputLine[]
      runs?: readonly RunSummary[]
      /** Set when `emit` already showed `lines`, so the interface does not print them twice. */
      streamed?: boolean
    }
  | { kind: 'watch' }
  | { kind: 'clear' }

export type CommandControllerOptions = {
  /** Tests pass a fake so `/install` never launches a browser. */
  openUrl?: (url: string) => Promise<boolean>
  /** Delay between status polls. About two seconds in the product. */
  pollIntervalMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 2_000

function line(tone: OutputLine['tone'], text: string, runId?: string): OutputLine {
  return { id: randomUUID(), tone, text, ...(runId ? { runId } : {}) }
}

function shortSha(value: string): string {
  return value.slice(0, 12)
}

const pad = (value: number) => String(value).padStart(2, '0')

/** Local `HH:MM:SS`, or `?` for a timestamp that does not parse. */
export function clockTime(iso: unknown): string {
  const date = typeof iso === 'string' ? new Date(iso) : undefined
  if (!date || Number.isNaN(date.getTime())) return '?'
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Local `YYYY-MM-DD HH:MM`. */
function dateTime(iso: string): string {
  const date = new Date(iso)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The one payload field worth a glance: why it failed, or which PR. */
function summarize(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const fields = payload as Record<string, unknown>
  const text =
    typeof fields.reason === 'string'
      ? fields.reason
      : typeof fields.error === 'string'
        ? fields.error
        : typeof fields.prUrl === 'string'
          ? fields.prUrl
          : typeof fields.prNumber === 'number'
            ? `#${fields.prNumber}`
            : ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}

/** One feed row: when, what, which run, and the detail that matters. */
export function formatActivity(event: ActivityEvent): string {
  const payload = event.payload
  const at = clockTime(payload.createdAt ?? payload.receivedAt)
  const runId = typeof payload.runId === 'string' ? payload.runId : ''
  const detail = event.type.startsWith('webhook:')
    ? typeof payload.processingStatus === 'string'
      ? payload.processingStatus
      : ''
    : summarize(payload.payload)
  return [at, event.type, runId, detail].filter(Boolean).join('  ')
}

function runLines(runs: readonly RunSummary[]): OutputLine[] {
  const statusWidth = Math.max(6, ...runs.map((run) => run.status.length))
  const row = (status: string, sha: string, created: string, id: string) =>
    `${status.padEnd(statusWidth)}  ${sha.padEnd(12)}  ${created.padEnd(16)}  ${id}`
  return [
    line('muted', row('STATUS', 'SHA', 'CREATED', 'RUN ID')),
    ...runs.map((run) =>
      line(
        'normal',
        row(run.status, shortSha(run.sourceSha), dateTime(run.createdAt), run.id),
        run.id,
      ),
    ),
  ]
}

function auditLine(event: AuditEvent): OutputLine {
  const detail = summarize(event.payload)
  const failed = event.eventType.endsWith('failed') || event.eventType.endsWith('gave_up')
  return line(
    failed ? 'error' : 'normal',
    `${clockTime(event.createdAt)}  ${event.eventType}${detail ? `  ${detail}` : ''}`,
  )
}

export class CommandController {
  private readonly api: AdamantApi
  private readonly openUrl: (url: string) => Promise<boolean>
  private readonly pollIntervalMs: number

  constructor(api: AdamantApi, options: CommandControllerOptions = {}) {
    this.api = api
    this.openUrl = options.openUrl ?? openInstallUrl
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  async execute(
    input: string,
    signal?: AbortSignal,
    emit?: (lines: readonly OutputLine[]) => void,
  ): Promise<CommandResult> {
    const command = parseCommand(input)
    switch (command.name) {
      case 'help':
        return {
          kind: 'output',
          lines: [
            line('accent', 'Adamant commands'),
            ...commandDefinitions.map((definition) =>
              line('muted', `${`/${definition.name}`.padEnd(12)}${definition.description}`),
            ),
          ],
        }
      case 'status':
        return { kind: 'output', lines: await this.status(signal) }
      case 'install':
        return this.install(command.owner, command.repo, signal, emit)
      case 'runs': {
        const runs = await this.api.listRuns(signal)
        return {
          kind: 'output',
          lines:
            runs.length === 0
              ? [line('muted', 'No healing runs are visible for this session.')]
              : runLines(runs),
          runs,
        }
      }
      case 'run': {
        const detail = await this.api.getRun(command.runId, signal)
        return {
          kind: 'output',
          lines: [
            line(
              'accent',
              `${detail.run.status} · ${shortSha(detail.run.sourceSha)} · created ${dateTime(detail.run.createdAt)}`,
            ),
            line('muted', `Run ${detail.run.id}`),
            ...(detail.auditEvents.length === 0
              ? [line('muted', 'No audit events yet.')]
              : detail.auditEvents.map(auditLine)),
          ],
        }
      }
      case 'trigger': {
        const result = await this.api.createRun(
          {
            repositoryId: command.repositoryId,
            sourceSha: command.sourceSha,
            idempotencyKey: randomUUID(),
          },
          signal,
        )
        return {
          kind: 'output',
          lines: [
            line(
              result.created ? 'success' : 'muted',
              `${result.created ? 'Queued' : 'Existing'} run ${result.run.id} (${result.run.status}).`,
            ),
          ],
        }
      }
      case 'watch':
        return { kind: 'watch' }
      case 'clear':
        return { kind: 'clear' }
    }
  }

  /**
   * `/health` is open to anyone, so on its own it reported a healthy API to a
   * session every other command was refused with. The session is checked too,
   * concurrently, so the answer costs one round trip.
   */
  private async status(signal?: AbortSignal): Promise<OutputLine[]> {
    const started = performance.now()
    const [health, session] = await Promise.allSettled([
      this.api.health(signal),
      this.api.listRuns(signal),
    ])
    if (health.status === 'rejected') throw health.reason
    const elapsed = Math.round(performance.now() - started)
    return [
      line('success', `Adamant API at ${this.api.origin} is healthy (${elapsed} ms).`),
      session.status === 'fulfilled'
        ? line('success', 'Session accepted.')
        : line(
            'error',
            session.reason instanceof Error ? session.reason.message : 'Session check failed.',
          ),
    ]
  }

  followActivity(options: FollowActivityOptions): Promise<void> {
    return followActivity(this.api, options)
  }

  private async install(
    owner: string,
    repo: string,
    signal?: AbortSignal,
    emit?: (lines: readonly OutputLine[]) => void,
  ): Promise<CommandResult> {
    const lines: OutputLine[] = []
    const push = (batch: readonly OutputLine[]) => {
      lines.push(...batch)
      emit?.(batch)
    }
    const finish = (): CommandResult => ({
      kind: 'output',
      lines,
      ...(emit ? { streamed: true } : {}),
    })
    const label = `${owner}/${repo}`
    if (signal?.aborted) {
      push([line('muted', `Stopped waiting for ${label}.`)])
      return finish()
    }

    const url = await this.api.installUrl(signal)
    push([
      line('normal', url),
      line('muted', `Install the App on ${label}, or add ${label} to an existing installation.`),
    ])

    let opened = false
    try {
      opened = await this.openUrl(url)
    } catch {
      // A missing display or a failed opener must not fail the command.
    }
    if (signal?.aborted) {
      push([line('muted', `Stopped waiting for ${label}.`)])
      return finish()
    }
    if (!opened) push([line('muted', 'Could not open a browser. Open the URL above.')])
    push([line('muted', `Waiting for GitHub to confirm ${label}…`)])

    let installed: GithubInstallationStatus | null = null
    while (!installed) {
      if (signal?.aborted) {
        push([line('muted', `Stopped waiting for ${label}.`)])
        return finish()
      }
      try {
        installed = await this.api.installationStatus(owner, repo, signal)
      } catch (error) {
        if (isAbort(error) || signal?.aborted) {
          push([line('muted', `Stopped waiting for ${label}.`)])
          return finish()
        }
        throw error
      }
      if (installed) break
      try {
        await delay(this.pollIntervalMs, signal)
      } catch (error) {
        if (isAbort(error) || signal?.aborted) {
          push([line('muted', `Stopped waiting for ${label}.`)])
          return finish()
        }
        throw error
      }
    }

    push([
      line('success', `Adamant is installed on ${installed.owner}/${installed.name}.`),
      line('success', `Default branch: ${installed.defaultBranch}.`),
      line('muted', `A failed workflow on ${installed.defaultBranch} starts a heal.`),
    ])
    return finish()
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(signal: AbortSignal | undefined): DOMException {
  const reason = signal?.reason
  return reason instanceof DOMException && reason.name === 'AbortError'
    ? reason
    : new DOMException('The operation was aborted.', 'AbortError')
}
