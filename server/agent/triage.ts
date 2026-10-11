import { redactText } from './recorder.ts'

/**
 * The model never sees a raw job log. Actions logs are mostly setup noise and
 * can carry masked secrets, so the log is parsed here first and only the
 * parsed shape plus a bounded excerpt reach the prompt.
 * See docs/performance.md#phase-1-do-these.
 */
export interface FailureContext {
  readonly firstError: string | null
  /** `path/to/file.ts:42` when the log names one. */
  readonly location: string | null
  readonly failingTests: readonly string[]
  /** Bounded window around the first error, already stripped of log chrome. */
  readonly excerpt: string
}

const MAX_EXCERPT_CHARS = 6_000
const MAX_FIRST_ERROR_CHARS = 1_000
/** A line longer than this is a dump (a bundle, a serialized object), not a diagnostic. */
const MAX_LINE_CHARS = 4_000
const MAX_FAILING_TESTS = 20
const EXCERPT_LINES_BEFORE = 12
const EXCERPT_LINES_AFTER = 40

// Built at runtime so the escape character never sits in the source file.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')
const ACTIONS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s?/
const ACTIONS_COMMAND = /^##\[(?:group|endgroup|debug|command|section)\]/

/** Lines that name the actual fault. These are what a diagnosis is built from. */
const ERROR_PATTERNS: readonly RegExp[] = [
  /^\s*(?:error|fatal)\b[:\s]/i,
  /\berror\s+TS\d+\b/,
  /^\s*[A-Za-z_$][\w$]*Error\b/,
  /\b(?:AssertionError|SyntaxError|TypeError|ReferenceError)\b/,
  /^\s*Expected .* (?:to|but) /,
]

/**
 * Where a test runner announces a failure. Useful for anchoring the excerpt,
 * but `not ok 1 - adds two numbers` says less than the assertion under it, so
 * these only supply `firstError` when no real error line exists.
 */
const HARNESS_PATTERNS: readonly RegExp[] = [/^\s*(?:FAIL|not ok)\b/]

// The lookbehind pins each try to the start of a path-shaped run. Without it
// every character of a long run (a minified bundle in the log) was a fresh
// start for the greedy class, which made a 100k-character line take seconds.
const LOCATION_PATTERNS: readonly RegExp[] = [
  // tsc: src/app.ts(12,4): error TS2345
  /(?<![\w./-])([\w./-]+\.[A-Za-z]{1,6})\((\d+),\d+\)/,
  // node / jest / vitest: at src/app.ts:12:4, or src/app.ts:12
  /(?<![\w./-])([\w./-]+\.[A-Za-z]{1,6}):(\d+)(?::\d+)?/,
]

// Lines are already trimmed at the end, so the name runs to the end of the line.
const TEST_PATTERNS: readonly RegExp[] = [
  /^\s*not ok \d+\s*-\s*(.+)$/,
  /^\s*FAIL\s+(.+)$/,
  /^\s*\d+\)\s+(.+)$/,
]

/** Log chrome only. Never rewrites a value from the log body, but cuts a dump line short. */
function clean(line: string): string {
  return line
    .slice(0, MAX_LINE_CHARS)
    .replace(ANSI, '')
    .replace(ACTIONS_TIMESTAMP, '')
    .replace(ACTIONS_COMMAND, '')
    .trimEnd()
}

function indexOfMatch(lines: readonly string[], patterns: readonly RegExp[]): number {
  return lines.findIndex((line) => patterns.some((pattern) => pattern.test(line)))
}

function findLocation(lines: readonly string[], from: number): string | null {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line) continue
    for (const pattern of LOCATION_PATTERNS) {
      const match = pattern.exec(line)
      const file = match?.[1]
      const lineNumber = match?.[2]
      // Runners print absolute paths, so the directory can sit anywhere in it.
      if (file && lineNumber && !file.includes('node_modules/')) {
        return `${file}:${lineNumber}`
      }
    }
  }
  return null
}

/** Distinct `file:line` pairs in order of appearance, at most `max`, none in node_modules. */
export function findLocations(text: string, max: number): { file: string; line: number }[] {
  const found = new Map<string, { file: string; line: number }>()
  for (const line of text.split(/\r?\n/)) {
    for (const pattern of LOCATION_PATTERNS) {
      const match = pattern.exec(line)
      const file = match?.[1]
      const lineNumber = Number(match?.[2])
      if (!file || !Number.isInteger(lineNumber) || file.includes('node_modules/')) continue
      if (!found.has(file)) found.set(file, { file, line: lineNumber })
      break
    }
    if (found.size >= max) break
  }
  return [...found.values()]
}

/**
 * The lines around `anchor`, grown a line at a time on each side until the
 * character budget is spent. The anchor line is always kept (cut to the budget
 * if it alone exceeds it) and no other line is cut mid-way, so `start` stays a
 * true line index. A plain slice of the joined text lost the anchor line itself
 * whenever its neighbours were long, which is the minified-stack-trace case.
 */
export function boundedWindow(
  lines: readonly string[],
  anchor: number,
  limits: { before: number; after: number; maxChars: number },
): { start: number; lines: string[] } {
  const anchorLine = lines[anchor] ?? ''
  if (anchorLine.length >= limits.maxChars) {
    return { start: anchor, lines: [anchorLine.slice(0, limits.maxChars)] }
  }

  let start = anchor
  let end = anchor + 1
  let used = anchorLine.length
  const lowest = Math.max(0, anchor - limits.before)
  const highest = Math.min(lines.length, anchor + 1 + limits.after)

  const fits = (line: string) => used + 1 + line.length <= limits.maxChars
  let growing = true
  while (growing) {
    growing = false
    const next = lines[end]
    if (end < highest && next !== undefined && fits(next)) {
      used += 1 + next.length
      end += 1
      growing = true
    }
    const previous = lines[start - 1]
    if (start > lowest && previous !== undefined && fits(previous)) {
      used += 1 + previous.length
      start -= 1
      growing = true
    }
  }

  return { start, lines: lines.slice(start, end) }
}

function findFailingTests(lines: readonly string[]): string[] {
  const names = new Set<string>()
  for (const line of lines) {
    for (const pattern of TEST_PATTERNS) {
      const name = pattern.exec(line)?.[1]?.trim()
      if (name && name.length > 1 && name.length <= 200) {
        names.add(name)
        break
      }
    }
    if (names.size >= MAX_FAILING_TESTS) break
  }
  return [...names]
}

/**
 * Parse an Actions job log into the shape the model is allowed to see. Safe on
 * an empty or unrecognised log: fields come back null/empty instead of
 * throwing, so a run whose logs are unreachable still reaches diagnose.
 */
export function parseFailure(logs: string, options?: { maxExcerptChars?: number }): FailureContext {
  const maxExcerptChars = options?.maxExcerptChars ?? MAX_EXCERPT_CHARS
  // Redacted whole, before splitting, so a secret-shaped value spanning lines
  // (a PEM key block) is still caught.
  const lines = redactText(logs).split(/\r?\n/).map(clean)
  const errorIndex = indexOfMatch(lines, ERROR_PATTERNS)
  const harnessIndex = indexOfMatch(lines, HARNESS_PATTERNS)

  // Anchor on whichever came first so the window covers the whole failure,
  // but report the error line itself when there is one.
  const found = [errorIndex, harnessIndex].filter((index) => index !== -1)
  const anchor =
    found.length === 0 ? Math.max(0, lines.length - EXCERPT_LINES_AFTER) : Math.min(...found)
  const reportIndex = errorIndex === -1 ? harnessIndex : errorIndex

  const window = boundedWindow(lines, anchor, {
    before: EXCERPT_LINES_BEFORE,
    after: EXCERPT_LINES_AFTER,
    maxChars: maxExcerptChars,
  })
    .lines.filter((line) => line.trim().length > 0)
    .join('\n')

  // Goes into the prompt and the PR title as is, so a one-line dump is cut.
  const firstError =
    reportIndex === -1 ? null : lines[reportIndex]?.trim().slice(0, MAX_FIRST_ERROR_CHARS)

  return {
    firstError: firstError || null,
    location: findLocation(lines, anchor),
    failingTests: findFailingTests(lines),
    excerpt: window,
  }
}

/** Stable text block for the prompt. Keep the field order fixed so it caches. */
export function describeFailure(failure: FailureContext): string {
  const tests = failure.failingTests.length > 0 ? failure.failingTests.join(', ') : 'not identified'

  return [
    `First error: ${failure.firstError ?? 'not identified'}`,
    `Location: ${failure.location ?? 'not identified'}`,
    `Failing tests: ${tests}`,
    '',
    'Log excerpt:',
    failure.excerpt || '(empty)',
  ].join('\n')
}
