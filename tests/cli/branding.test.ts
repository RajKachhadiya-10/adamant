import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { X_LOGO } from '../../cli/src/branding.ts'

describe('Adamant CLI branding', () => {
  it('keeps the circular X compact and symmetrical', () => {
    assert.equal(X_LOGO.length, 10)
    assert.ok(X_LOGO.every((row) => row.length === 26))

    for (const row of X_LOGO) {
      assert.equal(row, [...row].reverse().join(''))
    }
  })

  it('keeps the X broad through the center of the ring', () => {
    assert.equal(X_LOGO[0], '       ▄██████████▄       ')
    assert.equal(X_LOGO[4], '██        ▀████▀        ██')
    assert.equal(X_LOGO[5], '██        ▄████▄        ██')
    assert.match(X_LOGO.join('\n'), /▀██▄ {2}▄██▀/)
  })
})
