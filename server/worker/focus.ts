/**
 * The failing tests first. A retry's candidate usually fails the very test it
 * set out to fix, and a full suite can take minutes to say so. This turns the
 * names the log parser found into a run of only those tests, for the runners
 * whose filter flags are known. The full suite still runs before any `pass`,
 * so a filter that matches nothing costs one short run, never a wrong verdict.
 * An unknown runner gets null and the suite runs as before.
 */
export type ScriptReader = () => Promise<Record<string, string> | null>
export type FileCheck = (relativePath: string) => Promise<boolean>

const PACKAGE_SCRIPT = /^(npm|pnpm|yarn|bun)(?:\s+run)?\s+test$/
const TEST_FILE = /^[\w@./-]+\.(?:[cm]?[jt]sx?|py)$/
const PYTEST_NODE = /^[\w./-]+\.py::[\w:[\]-]+$/
/** `FAIL src/sum.test.ts > sum > adds` (vitest): a file, then the describe path. */
const VITEST_NAME = /^(\S+\.[cm]?[jt]sx?)\s*>\s*(.+)$/
const MAX_TARGETS = 10

type Runner = 'vitest' | 'jest' | 'mocha' | 'node' | 'pytest'

/** Flag that filters by test title, per runner. Each takes a regular expression. */
const TITLE_FLAG: Record<Exclude<Runner, 'pytest'>, string> = {
  vitest: '-t',
  jest: '-t',
  mocha: '--grep',
  node: '--test-name-pattern',
}

/**
 * Runners whose positional arguments narrow the file set. For `mocha` and
 * `node --test` a positional adds to the files the script already names, which
 * would run everything twice over, so they get a title filter only.
 */
const FILES_AS_ARGS: ReadonlySet<Runner> = new Set(['vitest', 'jest', 'pytest'])

function detectRunner(script: string): Runner | null {
  if (/\bvitest\b/.test(script)) return 'vitest'
  if (/\bjest\b/.test(script)) return 'jest'
  if (/\bmocha\b/.test(script)) return 'mocha'
  if (/\bpytest\b/.test(script)) return 'pytest'
  if (/\bnode\b.*\s--test\b/.test(script)) return 'node'
  return null
}

/** POSIX single quoting; the command runs under `sh -c` inside the sandbox. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** What a parsed name says: a file, a title, or both. Titles match by substring. */
function split(name: string): { file?: string; title?: string } {
  const vitest = VITEST_NAME.exec(name)
  if (vitest?.[1] && vitest[2]) {
    return { file: vitest[1], title: vitest[2].split(' > ').at(-1)?.trim() ?? vitest[2] }
  }
  if (TEST_FILE.test(name) || PYTEST_NODE.test(name)) return { file: name }
  return { title: name.trim() }
}

export async function focusTestCommand(
  testCommand: string,
  failingTests: readonly string[],
  context: { scripts: ScriptReader; exists: FileCheck },
): Promise<string | null> {
  const names = failingTests.filter((name) => name.trim().length > 0).slice(0, MAX_TARGETS)
  if (names.length === 0) return null

  const command = testCommand.trim()
  const viaPackage = PACKAGE_SCRIPT.exec(command)
  const script = viaPackage ? (await context.scripts())?.test : command
  if (!script) return null
  const runner = detectRunner(script)
  if (!runner) return null

  const files: string[] = []
  const titles: string[] = []
  for (const name of names) {
    const part = split(name)
    // Runners print absolute paths; only a file that exists in the checkout is passed.
    const relative = part.file?.split('::')[0]
    const present = relative !== undefined && (await context.exists(relative))
    if (part.file && present && FILES_AS_ARGS.has(runner)) files.push(part.file)
    if (part.title && (!part.file || !present || !FILES_AS_ARGS.has(runner))) {
      titles.push(part.title)
    } else if (part.title && part.file && present && runner !== 'pytest') {
      // Both: the file narrows the set and the title picks the test within it.
      titles.push(part.title)
    }
  }

  const args = files.map(shellQuote)
  if (titles.length > 0) {
    if (runner === 'pytest') {
      // `-k` takes identifiers; a parsed title is a test id or nothing usable.
      const idents = titles.map((title) => title.replace(/\W+/g, ' ').trim().split(' ')[0] ?? '')
      const usable = idents.filter((ident) => ident.length > 0)
      if (usable.length > 0) args.push('-k', shellQuote(usable.join(' or ')))
    } else {
      args.push(TITLE_FLAG[runner], shellQuote(titles.map(escapeRegex).join('|')))
    }
  }
  if (args.length === 0) return null

  // npm and pnpm hand arguments to the script after `--`; yarn and bun take them as is.
  const separator =
    viaPackage && (viaPackage[1] === 'npm' || viaPackage[1] === 'pnpm') ? ' -- ' : ' '
  return `${command}${separator}${args.join(' ')}`
}
