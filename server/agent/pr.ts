import { type FailureContext } from './triage.ts'
import { redactText } from './recorder.ts'

/**
 * Task 4.7: the pull request states the cause, the evidence, the fix, what the
 * sandbox verified, and what it did not. Diagnosis and plan are model output,
 * so both go through redaction before they are published.
 */
export interface PrContent {
  readonly runId: string
  readonly failure: FailureContext
  readonly diagnostics: string
  readonly plan: string
  readonly commands: readonly string[]
  readonly attemptNumber: number
  /** Where the red build was. Absent in older callers; the summary then names less. */
  readonly repository?: { readonly owner: string; readonly name: string; readonly branch: string }
  readonly baseSha?: string
  /** The candidate that passed, for the list of changed files. */
  readonly patch?: string
}

export interface FileChange {
  readonly path: string
  readonly added: number
  readonly removed: number
}

export const MADE_WITH = 'Made with Adamant'

const MAX_SECTION_CHARS = 4_000

function section(text: string): string {
  const clean = redactText(text).trim()
  if (clean.length <= MAX_SECTION_CHARS) return clean || '_not recorded_'
  return `${clean.slice(0, MAX_SECTION_CHARS)}\n\n_(truncated)_`
}

export function buildPrTitle(failure: FailureContext): string {
  const subject = failure.firstError ?? failure.failingTests[0] ?? 'failing CI check'
  const oneLine = redactText(subject).split('\n')[0]?.trim() ?? 'failing CI check'
  const trimmed = oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine

  return `fix: ${trimmed}`
}

export function buildCommitMessage(failure: FailureContext, runId: string): string {
  return [buildPrTitle(failure), '', `Adamant run ${runId}.`, '', MADE_WITH].join('\n')
}

/** Files a unified diff touches, with its added and removed line counts. */
export function summarizePatch(patch: string): FileChange[] {
  const files: { path: string; added: number; removed: number }[] = []
  let current: { path: string; added: number; removed: number } | null = null
  let inHunk = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // `diff --git a/x b/y`: y is the name after the change, which a rename moves to.
      const path = line.match(/ b\/(.+)$/)?.[1] ?? line.slice('diff --git '.length)
      current = { path, added: 0, removed: 0 }
      files.push(current)
      inHunk = false
    } else if (line.startsWith('+++ ') && !inHunk) {
      const path = line.slice(4).replace(/^b\//, '')
      if (!current) {
        current = { path, added: 0, removed: 0 }
        files.push(current)
      } else if (path !== '/dev/null') {
        current.path = path
      }
    } else if (line.startsWith('@@')) {
      inHunk = true
    } else if (current && inHunk && line.startsWith('+')) {
      current.added += 1
    } else if (current && inHunk && line.startsWith('-')) {
      current.removed += 1
    }
  }
  return files
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function summary(content: PrContent): string {
  const error = content.failure.firstError
    ? `\`${redactText(content.failure.firstError).split('\n')[0]?.trim() ?? ''}\``
    : 'a failing check'
  const where = content.repository
    ? ` on \`${content.repository.branch}\`${content.baseSha ? ` at ${shortSha(content.baseSha)}` : ''}`
    : ''
  const attempts =
    content.attemptNumber > 1
      ? ` It took ${content.attemptNumber} attempts to find one that held.`
      : ''
  return [
    `CI failed${where} with ${error}. This PR fixes it.`,
    '',
    `Adamant read the failing log, found the cause, and wrote the change below. The change passed the project's checks in a sealed container before this PR was opened.${attempts}`,
  ].join('\n')
}

function changes(patch: string | undefined): string {
  const files = patch ? summarizePatch(patch) : []
  if (files.length === 0) return '_See the diff._'
  return files.map((file) => `- \`${file.path}\` (+${file.added} −${file.removed})`).join('\n')
}

function footer(content: PrContent): string {
  const lines = [`Run \`${content.runId}\``]
  if (content.repository && content.baseSha) {
    const repo = `${content.repository.owner}/${content.repository.name}`
    lines.push(
      `[failing commit ${shortSha(content.baseSha)}](https://github.com/${repo}/commit/${content.baseSha})`,
    )
  }
  return [lines.join(' · '), '', `🛠️ ${MADE_WITH}`].join('\n')
}

export function buildPrBody(content: PrContent): string {
  const tests =
    content.failure.failingTests.length > 0
      ? content.failure.failingTests.map((name) => `- \`${name}\``).join('\n')
      : '- _none named in the log_'

  return [
    '## Summary',
    summary(content),
    '',
    '## Changes',
    changes(content.patch),
    '',
    '## Cause',
    section(content.diagnostics),
    '',
    '## Evidence',
    `- First error: \`${redactText(content.failure.firstError ?? 'not identified')}\``,
    `- Location: \`${content.failure.location ?? 'not identified'}\``,
    '- Failing tests:',
    tests,
    '',
    '## Fix',
    section(content.plan),
    '',
    '## Verified',
    `Candidate ${content.attemptNumber} passed in a sealed container with the network off:`,
    ...content.commands.map((command) => `- \`${command}\``),
    '',
    '## Not checked',
    '- Anything outside those commands: other workflows, runtime behaviour, and performance.',
    '- No human reviewed this change before it was opened.',
    '',
    '---',
    footer(content),
  ].join('\n')
}
