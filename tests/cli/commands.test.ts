import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  argvToCommand,
  commandDefinitions,
  parseCommand,
  resolveSubmission,
  suggestionsFor,
} from '../../cli/src/commands.ts'

const definition = (name: string) => {
  const found = commandDefinitions.find((command) => command.name === name)
  assert.ok(found, name)
  return found
}

describe('Adamant CLI commands', () => {
  it('parses supported slash commands', () => {
    assert.deepEqual(parseCommand('/status'), { name: 'status' })
    assert.deepEqual(parseCommand('/run run_123'), { name: 'run', runId: 'run_123' })
    assert.deepEqual(parseCommand('/trigger repo_1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), {
      name: 'trigger',
      repositoryId: 'repo_1',
      sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
  })

  it('rejects malformed and unsupported commands without a request', () => {
    assert.throws(() => parseCommand('status'), /Start commands with/)
    assert.throws(() => parseCommand('/run'), /Usage: \/run/)
    assert.throws(() => parseCommand('/trigger repo short'), /full 40- or 64-character/)
    assert.throws(() => parseCommand('/unknown'), /Unknown command/)
  })

  it('offers prefix suggestions and routes argv through the same command form', () => {
    assert.deepEqual(
      suggestionsFor('/ru').map((command) => command.name),
      ['runs', 'run'],
    )
    assert.equal(argvToCommand(['run', 'run_123']), '/run run_123')
    assert.equal(argvToCommand([]), undefined)
  })

  it('runs the highlighted suggestion on Enter instead of failing on a partial name', () => {
    assert.deepEqual(resolveSubmission('/st', definition('status')), { submit: '/status' })
    assert.deepEqual(resolveSubmission('/ru', definition('runs')), { submit: '/runs' })
  })

  it('completes a command that needs arguments rather than running it without them', () => {
    assert.deepEqual(resolveSubmission('/ru', definition('run')), { complete: '/run ' })
    // `/run` is typed in full, even though `/runs` is highlighted first.
    assert.deepEqual(resolveSubmission('/run', definition('runs')), { complete: '/run ' })
  })

  it('submits what was typed once it has arguments or matches nothing', () => {
    assert.deepEqual(resolveSubmission('/run abc', definition('runs')), { submit: '/run abc' })
    assert.deepEqual(resolveSubmission(' /status ', definition('status')), { submit: '/status' })
    assert.deepEqual(resolveSubmission('/zz', undefined), { submit: '/zz' })
    assert.deepEqual(resolveSubmission('status', undefined), { submit: 'status' })
  })
})
