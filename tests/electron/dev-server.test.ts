import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { devServerUrl } from '../../electron/main/src/dev-server.mts'

describe('dev server URL', () => {
  it('uses the loopback URL scripts/dev.mjs injects', () => {
    assert.equal(
      devServerUrl({ VITE_DEV_SERVER_URL: 'http://localhost:5273/' }, false),
      'http://localhost:5273/',
    )
    assert.equal(
      devServerUrl({ VITE_DEV_SERVER_URL: 'http://127.0.0.1:5273/' }, false),
      'http://127.0.0.1:5273/',
    )
    assert.equal(
      devServerUrl({ VITE_DEV_SERVER_URL: 'http://[::1]:5273/' }, false),
      'http://[::1]:5273/',
    )
  })

  it('falls back to the bundled renderer when the variable is unset', () => {
    assert.equal(devServerUrl({}, false), null)
    assert.equal(devServerUrl({ VITE_DEV_SERVER_URL: '' }, false), null)
  })

  it('ignores the variable in a packaged build', () => {
    // A packaged app that honoured this would load whatever page the
    // environment names, with the preload bridge attached and devtools open.
    assert.equal(devServerUrl({ VITE_DEV_SERVER_URL: 'http://localhost:5273/' }, true), null)
    assert.equal(devServerUrl({ VITE_DEV_SERVER_URL: 'https://evil.example/' }, true), null)
  })

  it('refuses anything that is not a loopback http URL even in development', () => {
    for (const url of [
      'https://evil.example/',
      'http://evil.example/',
      'http://localhost.evil.example/',
      'file:///tmp/index.html',
      'not a url',
    ]) {
      assert.equal(devServerUrl({ VITE_DEV_SERVER_URL: url }, false), null, url)
    }
  })
})
