import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CLI_LOGIN_CODE_ALPHABET, CliLoginCodeSchema } from '@adamant/contract'
import { generateUserCode } from '../../server/api/services/cliLogin.ts'

// The implementation constant is module-private, but the source reads CODE_LENGTH = 8.
// The resulting string is "XXXX-XXXX": 4 letters, a dash, 4 letters = 9 characters total.
const EXPECTED_LENGTH = 9
const SEGMENT_LENGTH = 4

describe('generateUserCode', () => {
  it('returns a string of the expected total length', () => {
    const code = generateUserCode()

    assert.equal(code.length, EXPECTED_LENGTH)
  })

  it('contains a dash at position 4 and nowhere else', () => {
    const code = generateUserCode()

    assert.equal(code[SEGMENT_LENGTH], '-')
    assert.equal(code.indexOf('-'), SEGMENT_LENGTH)
    assert.equal(code.lastIndexOf('-'), SEGMENT_LENGTH)
  })

  it('contains only CLI_LOGIN_CODE_ALPHABET characters on either side of the dash', () => {
    const code = generateUserCode()
    const allowed = new Set(CLI_LOGIN_CODE_ALPHABET)

    // Remove the dash so every remaining character is checked against the alphabet.
    for (const char of code.replace('-', '')) {
      assert.ok(allowed.has(char), `'${char}' is not in CLI_LOGIN_CODE_ALPHABET`)
    }
  })

  it('contains no vowels (A E I O U)', () => {
    // The alphabet is restricted by design so codes never spell words.
    const code = generateUserCode()

    assert.doesNotMatch(code, /[AEIOU]/i)
  })

  it('contains no digits', () => {
    // Digits can be misread as letters on a screen; the alphabet avoids them.
    const code = generateUserCode()

    assert.doesNotMatch(code, /\d/)
  })

  it('passes the canonical CliLoginCodeSchema from the contract', () => {
    // CliLoginCodeSchema is the machine-readable spec: /^[BCDFGHJKLMNPQRSTVWXZ]{4}-…{4}$/.
    // Passing it means the output satisfies every constraint in one authoritative check.
    const code = generateUserCode()

    assert.equal(CliLoginCodeSchema.safeParse(code).success, true)
  })

  it('produces valid codes on repeated calls', () => {
    // Exercise the generator across 50 calls and verify schema validity each time.
    // Uniqueness is not asserted: collisions are theoretically possible and not a bug.
    for (let call = 0; call < 50; call += 1) {
      const code = generateUserCode()
      const result = CliLoginCodeSchema.safeParse(code)
      assert.equal(result.success, true, `call ${call}: '${code}' did not match the schema`)
    }
  })

  it('draws every letter of the alphabet, so none is cut off by an off-by-one', () => {
    // 4,000 draws from 20 letters: a reachable letter is missing with odds near e^-205.
    const seen = new Set<string>()
    for (let call = 0; call < 500; call += 1) {
      for (const char of generateUserCode().replace('-', '')) seen.add(char)
    }

    assert.deepEqual([...seen].sort(), [...CLI_LOGIN_CODE_ALPHABET].sort())
  })
})

describe('CLI_LOGIN_CODE_ALPHABET and CliLoginCodeSchema', () => {
  // The schema spells the alphabet out again in its regex; a letter added to one
  // and not the other would make some generated codes fail validation.
  it('accept exactly the same letters', () => {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const code = `${letter.repeat(4)}-${letter.repeat(4)}`
      assert.equal(
        CliLoginCodeSchema.safeParse(code).success,
        CLI_LOGIN_CODE_ALPHABET.includes(letter),
        `'${letter}' is ${CLI_LOGIN_CODE_ALPHABET.includes(letter) ? '' : 'not '}in the alphabet`,
      )
    }
  })

  it('rejects lowercase, a missing dash, and the wrong segment lengths', () => {
    for (const code of ['bcdf-ghjk', 'BCDFGHJK', 'BCD-FGHJK', 'BCDFG-HJKL', 'BCDF-GHJK-']) {
      assert.equal(CliLoginCodeSchema.safeParse(code).success, false, code)
    }
  })
})
