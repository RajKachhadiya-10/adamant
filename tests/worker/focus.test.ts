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
})
