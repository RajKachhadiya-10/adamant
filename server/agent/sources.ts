import { type SourceExcerpt } from './deps.ts'
import { redactText } from './recorder.ts'
import { boundedWindow, findLocations, type FailureContext } from './triage.ts'

/**
 * The code the failure points at. A unified diff only applies if its context
 * lines match the file, and the model cannot match a file it has never seen,
 * so the files named in the parsed log are read once, in retrieve, and shown
 * to every later step. Bounded so the prompt stays small and cacheable.
 */
const MAX_FILES = 3
const LINES_BEFORE = 60
const LINES_AFTER = 60
const MAX_EXCERPT_CHARS = 8_000

type FileReader = (fromLog: string) => Promise<{ path: string; text: string } | null>

function excerpt(path: string, text: string, line: number): SourceExcerpt {
  // Redacted whole, before windowing, so a key block the window cuts through
  // is still caught. Redaction keeps line counts, so the numbers stay true.
  // A final newline ends the last line; it does not start another one.
  const lines = redactText(text).replace(/\n$/, '').split('\n')
  // A log can name a line past the end (compiled output, a stale trace); the
  // tail of the file is still the closest thing to show.
  const anchor = Math.min(Math.max(line, 1), lines.length) - 1
  const window = boundedWindow(lines, anchor, {
    before: LINES_BEFORE,
    after: LINES_AFTER,
    maxChars: MAX_EXCERPT_CHARS,
  })

  return { path, startLine: window.start + 1, text: window.lines.join('\n') }
}

/** Reads run concurrently; a file that cannot be found or read is skipped. */
export async function readSources(
  readFile: FileReader,
  failure: FailureContext,
): Promise<SourceExcerpt[]> {
  const text = [failure.location ?? '', failure.excerpt].join('\n')
  const locations = findLocations(text, MAX_FILES)

  const read = await Promise.all(
    locations.map(async ({ file, line }) => {
      const found = await readFile(file).catch(() => null)
      return found ? excerpt(found.path, found.text, line) : null
    }),
  )

  const seen = new Set<string>()
  return read.filter((source): source is SourceExcerpt => {
    if (!source || seen.has(source.path)) return false
    seen.add(source.path)
    return true
  })
}

/** Stable text block for the prompt. Same input, same text, so it caches. */
export function describeSources(sources: readonly SourceExcerpt[]): string {
  if (sources.length === 0) return 'Source: no file from the log was found in the checkout.'

  return sources
    .map((source) => {
      const end = source.startLine + source.text.split('\n').length - 1
      return [`Source ${source.path} (lines ${source.startLine}-${end}):`, source.text].join('\n')
    })
    .join('\n\n')
}
