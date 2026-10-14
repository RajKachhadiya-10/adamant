import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadCliConfig } from '../../cli/src/config.ts'

describe('Adamant CLI configuration', () => {
  it('defaults to the local API and starts without a session', () => {
    assert.equal(
      loadCliConfig({ ADAMANT_SESSION: 'session' }).apiUrl.origin,
      'http://localhost:8787',
    )
    assert.equal(loadCliConfig({}).apiUrl.origin, 'http://localhost:8787')
    assert.equal(loadCliConfig({}).session, undefined)
    assert.equal(
      loadCliConfig({ ADAMANT_API_URL: 'https://adamant.example' }).apiUrl.origin,
      'https://adamant.example',
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

  it('accepts every loopback spelling, including bracketed IPv6', () => {
    for (const url of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      assert.equal(loadCliConfig({ ADAMANT_API_URL: url, ADAMANT_SESSION: 's' }).apiUrl.origin, url)
    }
  })

  it('explains a missing scheme instead of calling it a path', () => {
    assert.throws(
      () => loadCliConfig({ ADAMANT_API_URL: 'localhost:8787', ADAMANT_SESSION: 's' }),
      /must start with https:\/\//,
    )
  })

  it('refuses credentials in the URL, which fetch would reject on every call', () => {
    assert.throws(
      () =>
        loadCliConfig({
          ADAMANT_API_URL: 'https://user:pass@adamant.example',
          ADAMANT_SESSION: 's',
        }),
      /must not contain credentials/,
    )
  })

  it('refuses a session a bearer header cannot carry', () => {
    for (const session of ['two words', 'line\nbreak', 'tab\there']) {
      assert.throws(
        () => loadCliConfig({ ADAMANT_SESSION: session }),
        /must not contain spaces/,
        JSON.stringify(session),
      )
    }
  })
})
