import { randomUUID } from 'node:crypto'
import { type RunSummary } from '@adamant/contract'
import { type AdamantApi } from './api.ts'
import { commandDefinitions, parseCommand } from './commands.ts'
import { followActivity, type ActivityEvent, type ActivityConnectionState } from './sse.ts'

export type OutputLine = {
  id: string
  tone: 'muted' | 'normal' | 'success' | 'error' | 'accent'
  text: string
}

export type CommandResult =
  | { kind: 'output'; lines: readonly OutputLine[]; runs?: readonly RunSummary[] }
  | { kind: 'watch' }
  | { kind: 'clear' }
  | { kind: 'quit' }

function line(tone: OutputLine['tone'], text: string): OutputLine {
  return { id: randomUUID(), tone, text }
}

function shortSha(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}

function runLine(run: RunSummary): OutputLine {
  return line(
    'normal',
    `${run.status.padEnd(12)} ${shortSha(run.sourceSha).padEnd(13)} ${run.targetBranch}  ${run.id}`,
  )
}

export class CommandController {
  private readonly api: AdamantApi

  constructor(api: AdamantApi) {
    this.api = api
  }

  async execute(input: string, signal?: AbortSignal): Promise<CommandResult> {
    const command = parseCommand(input)
    switch (command.name) {
      case 'help':
        return {
          kind: 'output',
          lines: [
            line('accent', 'Adamant commands'),
            ...commandDefinitions.map((definition) =>
              line('muted', `${definition.usage.padEnd(38)} ${definition.description}`),
            ),
          ],
        }
      case 'status': {
        await this.api.health(signal)
        return { kind: 'output', lines: [line('success', 'Hosted Adamant API is healthy.')] }
      }
      case 'runs': {
        const runs = await this.api.listRuns(signal)
        return {
          kind: 'output',
          lines:
            runs.length === 0
              ? [line('muted', 'No healing runs are visible for this session.')]
              : [line('muted', 'STATUS        SHA           BRANCH  RUN ID'), ...runs.map(runLine)],
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
              `${detail.run.status} · ${detail.run.targetBranch} · ${shortSha(detail.run.sourceSha)}`,
            ),
            line('muted', `Run ${detail.run.id}`),
            ...detail.auditEvents.map((event) =>
              line('normal', `${event.createdAt}  ${event.eventType}`),
            ),
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
      case 'quit':
        return { kind: 'quit' }
    }
  }

  followActivity(options: {
    signal: AbortSignal
    onEvent(event: ActivityEvent): void
    onConnection(state: ActivityConnectionState): void
    onError(error: Error): void
  }): Promise<void> {
    return followActivity(this.api, options)
  }
}
