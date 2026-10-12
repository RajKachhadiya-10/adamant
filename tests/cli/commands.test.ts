import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { argvToCommand, parseCommand, suggestionsFor } from '../../cli/src/commands.ts'

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
})
