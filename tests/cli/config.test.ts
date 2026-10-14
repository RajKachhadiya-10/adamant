import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadCliConfig } from '../../cli/src/config.ts'

describe('Adamant CLI configuration', () => {
  it('defaults to the local API and requires a session', () => {
    assert.equal(
      loadCliConfig({ ADAMANT_SESSION: 'session' }).apiUrl.origin,
      'http://localhost:8787',
    )
    assert.throws(() => loadCliConfig({}), /ADAMANT_SESSION/)
    assert.throws(
      () => loadCliConfig({ ADAMANT_API_URL: 'https://adamant.example' }),
      /ADAMANT_SESSION/,
    )
  })

  it('requires HTTPS outside explicit local development', () => {
    assert.throws(
      () =>
        loadCliConfig({ ADAMANT_API_URL: 'http://adamant.example', ADAMANT_SESSION: 'session' }),
      /must use HTTPS/,
    )
    assert.equal(
      loadCliConfig({ ADAMANT_API_URL: 'http://localhost:8787', ADAMANT_SESSION: 'session' }).apiUrl
        .origin,
      'http://localhost:8787',
    )
  })

  it('rejects API URLs with a path to avoid accidental request routing', () => {
    assert.throws(
      () =>
        loadCliConfig({
          ADAMANT_API_URL: 'https://adamant.example/api',
          ADAMANT_SESSION: 'session',
        }),
      /must be an origin/,
    )
  })
})
