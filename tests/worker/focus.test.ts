import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { focusTestCommand } from '../../server/worker/focus.ts'

const context = (scripts: Record<string, string> | null, files: readonly string[] = []) => ({
  scripts: async () => scripts,
  exists: async (relative: string) => files.includes(relative),
})

describe('focused test command', () => {
  it('narrows vitest to the failing file and title', async () => {
    const command = await focusTestCommand(
      'npm test',
      ['src/sum.test.ts > sum > adds two numbers'],
      context({ test: 'vitest run' }, ['src/sum.test.ts']),
    )
    assert.equal(command, "npm test -- 'src/sum.test.ts' -t 'adds two numbers'")
  })

  it('passes jest a failing file that exists in the checkout', async () => {
    const command = await focusTestCommand(
      'npm test',
      ['src/sum.test.ts'],
      context({ test: 'jest --ci' }, ['src/sum.test.ts']),
    )
    assert.equal(command, "npm test -- 'src/sum.test.ts'")
  })

  it('falls back to the title when the printed path is not in the checkout', async () => {
    const command = await focusTestCommand(
      'pnpm test',
      ['/home/runner/work/app/src/sum.test.ts > adds'],
      context({ test: 'vitest run' }),
    )
    assert.equal(command, "pnpm test -- -t 'adds'")
  })

  it('escapes regular expression characters and shell quotes in titles', async () => {
    const command = await focusTestCommand(
      'pnpm test',
      ['sum (adds) 2+2', "it's odd"],
      context({ test: 'jest' }),
    )
    assert.equal(command, "pnpm test -- -t 'sum \\(adds\\) 2\\+2|it'\\''s odd'")
  })

  it('uses --grep for mocha and no positional files', async () => {
    const command = await focusTestCommand(
      'yarn test',
      ['test/sum.test.js', 'adds'],
      context({ test: 'mocha test/**/*.test.js' }, ['test/sum.test.js']),
    )
    assert.equal(command, "yarn test --grep 'adds'")
  })

  it('filters node:test by name pattern only', async () => {
    const command = await focusTestCommand(
      'npm test',
      ['tests/sum.test.ts > adds two numbers'],
      context({ test: 'node --experimental-strip-types --test tests/*.test.ts' }, [
        'tests/sum.test.ts',
      ]),
    )
    assert.equal(command, "npm test -- --test-name-pattern 'adds two numbers'")
  })

  it('hands pytest the failing node ids', async () => {
    const command = await focusTestCommand(
      '.adamant-venv/bin/python -m pytest -q',
      ['tests/test_sum.py::test_add'],
      context(null, ['tests/test_sum.py']),
    )
    assert.equal(command, ".adamant-venv/bin/python -m pytest -q 'tests/test_sum.py::test_add'")
  })

  it('gives up on an unknown runner, an empty list, or nothing usable', async () => {
    assert.equal(
      await focusTestCommand('npm test', ['adds'], context({ test: './scripts/test.sh' })),
      null,
    )
    assert.equal(await focusTestCommand('npm test', [], context({ test: 'vitest run' })), null)
    assert.equal(await focusTestCommand('npm test', ['adds'], context(null)), null)
    assert.equal(
      await focusTestCommand('pytest', ['/elsewhere/test_x.py'], context(null)),
      null,
      'a pytest file that is not in the checkout yields no identifier',
    )
  })

  // ---------- separator selection ----------

  it('uses a plain space for yarn (no -- separator)', async () => {
    // yarn passes args directly to the script without --.
    const command = await focusTestCommand(
      'yarn test',
      ['src/sum.test.ts > adds'],
      context({ test: 'vitest run' }, ['src/sum.test.ts']),
    )
    assert.equal(command, "yarn test 'src/sum.test.ts' -t 'adds'")
  })

  it('uses a plain space for bun (no -- separator)', async () => {
    // bun also passes args directly, without --.
    const command = await focusTestCommand(
      'bun test',
      ['src/sum.test.ts > adds'],
      context({ test: 'vitest run' }, ['src/sum.test.ts']),
    )
    assert.equal(command, "bun test 'src/sum.test.ts' -t 'adds'")
  })

  it('uses -- for pnpm run test (long form resolves via package script)', async () => {
    // `pnpm run test` matches PACKAGE_SCRIPT and uses -- before args.
    const command = await focusTestCommand(
      'pnpm run test',
      ['src/math.test.ts'],
      context({ test: 'jest --ci' }, ['src/math.test.ts']),
    )
    assert.equal(command, "pnpm run test -- 'src/math.test.ts'")
  })

  // ---------- MAX_TARGETS truncation ----------

  it('silently drops names beyond the first 10', async () => {
    // 11 names; only the first 10 reach the runner. Each name is a plain title
    // (no file match), so they appear as a joined --test-name-pattern pattern.
    const names = Array.from({ length: 11 }, (_, i) => `test ${i + 1}`)
    const command = await focusTestCommand(
      'npm test',
      names,
      context({ test: 'node --experimental-strip-types --test tests/*.ts' }),
    )
    assert.equal(command, `npm test -- --test-name-pattern '${names.slice(0, 10).join('|')}'`)
  })

  it('counts the 10 after dropping blank names, so blanks do not use up the limit', async () => {
    const names = ['', ...Array.from({ length: 10 }, (_, i) => `t${i + 1}`)]
    const command = await focusTestCommand('npm test', names, context({ test: 'jest' }))
    assert.equal(command, `npm test -- -t '${names.slice(1).join('|')}'`)
  })

  // ---------- multiple titles in one pattern ----------

  it('joins two jest titles into one -t pattern separated by |', async () => {
    // Two plain-title names for jest → one -t 'title1|title2'.
    const command = await focusTestCommand(
      'npm test',
      ['returns zero', 'throws on negative'],
      context({ test: 'jest --ci' }),
    )
    assert.equal(command, "npm test -- -t 'returns zero|throws on negative'")
  })

  it('combines file arg and title for two vitest failures in the same file', async () => {
    // Two vitest names in the same file: both file and title are emitted.
    // The file is passed once per name, so it appears twice in the command.
    const command = await focusTestCommand(
      'npm test',
      ['src/math.test.ts > add > returns sum', 'src/math.test.ts > sub > returns diff'],
      context({ test: 'vitest run' }, ['src/math.test.ts']),
    )
    assert.equal(
      command,
      "npm test -- 'src/math.test.ts' 'src/math.test.ts' -t 'returns sum|returns diff'",
    )
  })

  // ---------- mocha: file present but suppressed ----------

  it('passes mocha a title filter even when the failing file exists in the checkout', async () => {
    // mocha is not in FILES_AS_ARGS, so the file path is never a positional arg.
    // The title extracted from the vitest-style name is used with --grep instead.
    const command = await focusTestCommand(
      'yarn test',
      ['test/sum.test.js > adds correctly'],
      context({ test: 'mocha test/**/*.js' }, ['test/sum.test.js']),
    )
    assert.equal(command, "yarn test --grep 'adds correctly'")
  })

  // ---------- shellQuote edge case ----------

  it("single-quotes a value that contains a single quote (POSIX ''\\'' escaping)", async () => {
    // A test name with a single quote must be shell-escaped correctly.
    const command = await focusTestCommand(
      'pnpm test',
      ["can't divide by zero"],
      context({ test: 'jest' }),
    )
    assert.equal(command, "pnpm test -- -t 'can'\\''t divide by zero'")
  })

  // ---------- blank / whitespace-only names ----------

  it('skips blank and whitespace-only names and uses the rest', async () => {
    // Names that are blank after trim() are filtered before MAX_TARGETS.
    const command = await focusTestCommand(
      'npm test',
      ['   ', '', 'adds two numbers'],
      context({ test: 'jest' }),
    )
    assert.equal(command, "npm test -- -t 'adds two numbers'")
  })

  it('returns null when every name is blank', async () => {
    const command = await focusTestCommand('npm test', ['', '   '], context({ test: 'jest' }))
    assert.equal(command, null)
  })

  // ---------- pytest -k with multiple titles ----------

  it('hands pytest multiple failing titles joined by or in -k', async () => {
    // Two plain-title names for pytest → -k 'firstWord or secondWord'. A title
    // with spaces keeps only its first word, so `test subtraction` becomes `test`,
    // which -k matches in every test name; the run is wider, never wrong.
    const command = await focusTestCommand(
      'python -m pytest',
      ['test_addition', 'test subtraction'],
      context(null),
    )
    // pytest is the direct command (no package-script lookup); uses plain space separator.
    assert.equal(command, "python -m pytest -k 'test_addition or test'")
  })

  it('returns null when no pytest title leaves an identifier', async () => {
    assert.equal(await focusTestCommand('pytest', ['!!!', '()'], context(null)), null)
  })

  // ---------- direct runner commands and missing scripts ----------

  it('runs a direct runner command without reading package.json', async () => {
    const command = await focusTestCommand('npx vitest run', ['src/sum.test.ts > sum > adds'], {
      scripts: async () => assert.fail('a direct command has no package script to read'),
      exists: async (relative) => relative === 'src/sum.test.ts',
    })
    assert.equal(command, "npx vitest run 'src/sum.test.ts' -t 'adds'")
  })

  it('returns null when package.json has no test script', async () => {
    assert.equal(await focusTestCommand('npm test', ['adds'], context({ lint: 'eslint .' })), null)
  })

  it('passes jest both the file and the title from a vitest-style name', async () => {
    const command = await focusTestCommand(
      'npm test',
      ['src/sum.test.ts > sum > adds'],
      context({ test: 'jest --ci' }, ['src/sum.test.ts']),
    )
    assert.equal(command, "npm test -- 'src/sum.test.ts' -t 'adds'")
  })

  // ---------- vitest file absent from checkout falls back to title ----------

  it('uses only the title when the vitest file path is not in the checkout', async () => {
    // The printed absolute path does not exist → only the innermost title is used.
    const command = await focusTestCommand(
      'npm test',
      ['/runner/work/app/src/util.test.ts > format > trims whitespace'],
      context({ test: 'vitest run' }),
    )
    assert.equal(command, "npm test -- -t 'trims whitespace'")
  })
})
