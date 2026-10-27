import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMemoryRecorder, redact, redactText } from '../../server/agent/recorder.ts'

// ---------------------------------------------------------------------------
// redactText
// ---------------------------------------------------------------------------
//
// Masks secret-shaped values in free text. The replacement is '[redacted]'
// followed by the newlines the match spanned, so a multi-line PEM key block
// keeps its line count and `file:line` offsets stay accurate.

describe('redactText', () => {
  it('leaves plain text that contains no secret-shaped value unchanged', () => {
    assert.equal(redactText('hello world'), 'hello world')
    assert.equal(redactText(''), '')
    assert.equal(
      redactText('run-id: 00000000-0000-0000-0000-000000000001'),
      'run-id: 00000000-0000-0000-0000-000000000001',
    )
  })

  it('redacts a GitHub installation token (ghs_)', () => {
    // Pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g — 's' is in the char class.
    // Needs at least 16 alphanumeric characters after the prefix.
    assert.equal(redactText('ghs_ABCDEFGHIJKLMNOP'), '[redacted]')
  })

  it('redacts a GitHub personal access token (ghp_)', () => {
    assert.equal(redactText('ghp_ABCDEFGHIJKLMNOP'), '[redacted]')
  })

  it('redacts a GitHub refresh token (ghr_)', () => {
    assert.equal(redactText('ghr_ABCDEFGHIJKLMNOP'), '[redacted]')
  })

  it('redacts a GitHub user-to-server token (ghu_)', () => {
    assert.equal(redactText('ghu_ABCDEFGHIJKLMNOP'), '[redacted]')
  })

  it('redacts a GitHub PAT with the github_pat_ prefix', () => {
    // Pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g — needs 20+ chars.
    assert.equal(redactText('github_pat_abcdefghijklmnopqrstuvwxyz'), '[redacted]')
  })

  it('redacts a gh token from 16 characters after the prefix, not 15', () => {
    assert.equal(redactText(`ghs_${'A'.repeat(15)}`), `ghs_${'A'.repeat(15)}`)
    assert.equal(redactText(`ghs_${'A'.repeat(16)}`), '[redacted]')
  })

  it('does not redact a token-shaped value glued to a preceding word character', () => {
    // `\b` needs a non-word character before the prefix; `xghs_…` is not a token.
    assert.equal(redactText(`xghs_${'A'.repeat(16)}`), `xghs_${'A'.repeat(16)}`)
  })

  it('redacts every secret in a string, not only the first', () => {
    assert.equal(
      redactText(`a=ghp_${'A'.repeat(16)} b=sk-${'b'.repeat(16)} c=Bearer ${'c'.repeat(12)}`),
      'a=[redacted] b=[redacted] c=[redacted]',
    )
  })

  it('redacts an OpenAI sk- key', () => {
    // Pattern: /\bsk-[A-Za-z0-9-]{16,}/g
    assert.equal(redactText('sk-abcdefghijklmnop'), '[redacted]')
  })

  it('does not redact an sk- value that is too short', () => {
    // 'sk-tooshort' has 8 chars after sk- — below the 16-char minimum.
    assert.equal(redactText('sk-tooshort'), 'sk-tooshort')
  })

  it('redacts a Bearer token (case-insensitive, ≥ 12 chars)', () => {
    // Pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi
    assert.equal(redactText('Bearer abcdefghijklmno'), '[redacted]')
    assert.equal(redactText('bearer abcdefghijklmno'), '[redacted]')
    assert.equal(redactText('BEARER abcdefghijklmno'), '[redacted]')
  })

  it('redacts a token embedded in a URL and keeps the surrounding text', () => {
    const input = 'remote=https://ghs_ABCDEFGHIJKLMNOP@github.com'
    const result = redactText(input)
    assert.equal(result.includes('ghs_'), false)
    assert.ok(result.startsWith('remote=https://'), 'prefix before the token is preserved')
    assert.ok(result.endsWith('@github.com'), 'suffix after the token is preserved')
  })

  it('redacts a PEM private key block spanning multiple lines and preserves the line count', () => {
    // The replacement formula: '[redacted]' + match.replace(/[^\n]/g, '')
    // Every non-newline character in the match is dropped; newlines survive.
    // A 3-line PEM block has 2 embedded newlines, so the result also has 2.
    const pem = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
      '-----END PRIVATE KEY-----',
    ].join('\n')

    const result = redactText(`before\n${pem}\nafter`)

    // The marker keeps the block's two newlines; the third is the one before `after`.
    assert.equal(result, 'before\n[redacted]\n\n\nafter')
    assert.equal(result.split('\n').length, pem.split('\n').length + 2, 'line count is preserved')
  })

  it('redacts a PEM RSA private key (header variant)', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA1234567890abcdef',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n')

    const result = redactText(pem)
    assert.equal(result.includes('MIIEow'), false)
    assert.equal(result.split('\n').length, pem.split('\n').length)
  })
})

// ---------------------------------------------------------------------------
// redact
// ---------------------------------------------------------------------------
//
// Applied to every tool argument and audit payload before it reaches storage.
// Two orthogonal rules:
//   1. A key whose name contains a secret word ('token', 'secret', 'key',
//      'auth', 'password', 'credential', 'cookie') → value replaced wholesale.
//   2. A string value that matches a secret-shaped pattern → masked in place
//      (even when the key is non-secret, e.g. a `remote` URL holding a token).
// Objects are walked recursively, arrays element-by-element. Recursion is
// capped at depth 4 to prevent unbounded traversal of pathological inputs.

describe('redact', () => {
  it('passes non-secret string values through unchanged', () => {
    assert.deepEqual(redact({ message: 'hello world' }), { message: 'hello world' })
  })

  it('passes numeric, boolean, and null values through unchanged', () => {
    assert.deepEqual(redact({ count: 42, flag: true, nothing: null }), {
      count: 42,
      flag: true,
      nothing: null,
    })
  })

  it('replaces the value of a key containing "token" with [redacted]', () => {
    assert.deepEqual(redact({ token: 'myvalue' }), { token: '[redacted]' })
  })

  it('replaces the value of a key containing "secret"', () => {
    assert.deepEqual(redact({ webhookSecret: 'abc' }), { webhookSecret: '[redacted]' })
  })

  it('replaces the value of a key containing "password"', () => {
    assert.deepEqual(redact({ password: 'hunter2' }), { password: '[redacted]' })
  })

  it('replaces the value of a key containing "auth"', () => {
    assert.deepEqual(redact({ authHeader: 'Bearer xyz' }), { authHeader: '[redacted]' })
  })

  it('replaces the value of a key containing "credential"', () => {
    assert.deepEqual(redact({ credentialId: 'abc' }), { credentialId: '[redacted]' })
  })

  it('replaces the value of a key containing "cookie"', () => {
    assert.deepEqual(redact({ sessionCookie: 'abc' }), { sessionCookie: '[redacted]' })
  })

  it('replaces the value of a key containing "key"', () => {
    assert.deepEqual(redact({ apiKey: 'abc' }), { apiKey: '[redacted]' })
  })

  it('key matching is case-insensitive', () => {
    // isSecretKey lowercases the key before checking.
    assert.deepEqual(redact({ TOKEN: 'abc' }), { TOKEN: '[redacted]' })
    assert.deepEqual(redact({ Secret: 'abc' }), { Secret: '[redacted]' })
  })

  it('leaves non-secret key names and their values intact', () => {
    assert.deepEqual(redact({ runId: 'run-1', owner: 'acme' }), { runId: 'run-1', owner: 'acme' })
  })

  it('masks a token-shaped string value even when the key name is not a secret word', () => {
    // The 'remote' key is safe but its value contains a GitHub installation token.
    const input = { remote: 'https://ghs_ABCDEFGHIJKLMNOP@github.com' }
    const result = redact(input)
    assert.equal(String(result.remote).includes('ghs_'), false)
    assert.ok(String(result.remote).startsWith('https://'), 'non-token prefix is preserved')
    assert.ok(String(result.remote).endsWith('@github.com'), 'non-token suffix is preserved')
  })

  it('recurses into nested objects and redacts secret keys at any level', () => {
    assert.deepEqual(redact({ config: { token: 'abc', name: 'eval' } }), {
      config: { token: '[redacted]', name: 'eval' },
    })
  })

  it('walks arrays of strings and masks any token-shaped element', () => {
    assert.deepEqual(redact({ args: ['pnpm', 'test', 'ghs_ABCDEFGHIJKLMNOP'] }), {
      args: ['pnpm', 'test', '[redacted]'],
    })
  })

  it('walks arrays of objects and applies both key and value redaction', () => {
    assert.deepEqual(redact({ items: [{ token: 'abc' }, { name: 'safe' }] }), {
      items: [{ token: '[redacted]' }, { name: 'safe' }],
    })
  })

  it('handles mixed arrays containing primitives, objects, and nulls', () => {
    assert.deepEqual(redact({ data: [42, 'plain', { token: 'x' }, null] }), {
      data: [42, 'plain', { token: '[redacted]' }, null],
    })
  })

  it('replaces an object nested at depth 4 with [redacted] to limit traversal', () => {
    // Depth counting starts at 0 for the top-level input.
    // At depth 4, any remaining object is replaced wholesale.
    // { a: { b: { c: { d: <this object> } } } }
    //   depth 0 → a's value recurses at depth 1
    //   depth 1 → b's value recurses at depth 2
    //   depth 2 → c's value recurses at depth 3
    //   depth 3 → d's value ({ innocent: 'value' }) would recurse at depth 4,
    //             but depth >= 4 for objects → '[redacted]'
    assert.deepEqual(redact({ a: { b: { c: { d: { innocent: 'value' } } } } }), {
      a: { b: { c: { d: '[redacted]' } } },
    })
  })

  it('does not depth-cap plain strings, which pass through value-redaction at any depth', () => {
    // The depth >= 4 guard applies only to objects. Strings hit the
    // typeof === 'string' check first and always go through redactString.
    assert.deepEqual(redact({ a: { b: { c: { d: 'innocent string' } } } }), {
      a: { b: { c: { d: 'innocent string' } } },
    })
  })

  it('depth-caps a deeply nested array-of-objects', () => {
    // { a: { b: { c: { arr: [{ x: 1 }] } } } }
    // depth 0 → a's value at depth 1 → b's value at depth 2 → c's value at depth 3
    // → arr's value (the array [{ x: 1 }]) is passed to redactValue at depth 4.
    // Arrays are objects, so the depth >= 4 guard fires before the Array.isArray
    // branch and the entire array is replaced with '[redacted]'.
    assert.deepEqual(redact({ a: { b: { c: { arr: [{ x: 1 }] } } } }), {
      a: { b: { c: { arr: '[redacted]' } } },
    })
  })

  it('replaces an object or array under a secret-shaped key without walking it', () => {
    assert.deepEqual(redact({ auth: { user: 'u', scheme: 'basic' }, cookies: ['a=1', 'b=2'] }), {
      auth: '[redacted]',
      cookies: '[redacted]',
    })
  })

  it('also redacts keys that only contain a secret word, such as author', () => {
    // Substring matching errs towards hiding: `author` contains `auth`.
    assert.deepEqual(redact({ author: 'octocat', monkey: 'banana' }), {
      author: '[redacted]',
      monkey: '[redacted]',
    })
  })

  it('returns a copy and leaves the input untouched', () => {
    const input = { token: 'abc', nested: { remote: `https://ghs_${'A'.repeat(16)}@github.com` } }
    const before = structuredClone(input)

    const result = redact(input)

    assert.deepEqual(input, before)
    assert.notEqual(result.nested, input.nested)
  })
})

// ---------------------------------------------------------------------------
// createMemoryRecorder
// ---------------------------------------------------------------------------
//
// The in-memory recorder used by every test in the suite. Tool arguments and
// audit payloads go through `redact`; patch attempts, sandbox results and PR
// publications are stored as given, as the Postgres recorder does.

describe('createMemoryRecorder', () => {
  it('creates a recorder whose five arrays all start empty', () => {
    const recorder = createMemoryRecorder()
    assert.equal(recorder.tools.length, 0)
    assert.equal(recorder.audits.length, 0)
    assert.equal(recorder.patches.length, 0)
    assert.equal(recorder.sandboxes.length, 0)
    assert.equal(recorder.publications.length, 0)
  })

  it('redacts a token-shaped value in toolInvocation args before storage', async () => {
    const recorder = createMemoryRecorder()
    await recorder.toolInvocation({
      tool: 'git_push',
      args: { remote: 'https://ghs_ABCDEFGHIJKLMNOP@github.com', runId: 'run-1' },
      outcome: 'ok',
      startedAt: new Date(),
    })

    const stored = recorder.tools[0]
    assert.ok(stored, 'record is stored')
    assert.equal(String(stored.args.remote).includes('ghs_'), false, 'GitHub token is removed')
    assert.equal(stored.args.runId, 'run-1', 'non-secret arg is kept')
    assert.equal(stored.tool, 'git_push')
    assert.equal(stored.outcome, 'ok')
  })

  it('redacts a secret-keyed value in the audit payload before storage', async () => {
    const recorder = createMemoryRecorder()
    await recorder.audit('run.queued', { token: 'secretval', deliveryId: 'delivery-1' })

    const stored = recorder.audits[0]
    assert.ok(stored)
    assert.equal(stored.eventType, 'run.queued')
    assert.equal(stored.payload.token, '[redacted]', 'secret key value is redacted')
    assert.equal(stored.payload.deliveryId, 'delivery-1', 'non-secret value is kept')
  })

  it('stores an empty payload object when audit is called with no payload', async () => {
    const recorder = createMemoryRecorder()
    await recorder.audit('run.started')

    assert.deepEqual(recorder.audits[0]?.payload, {})
  })

  it('latestSandboxVerdict returns null when no sandbox results have been stored', async () => {
    const recorder = createMemoryRecorder()
    assert.equal(await recorder.latestSandboxVerdict(), null)
  })

  it('latestSandboxVerdict returns the verdict from the most recently stored result', async () => {
    const recorder = createMemoryRecorder()
    await recorder.sandboxResult({
      attemptNumber: 1,
      candidateHash: 'abc',
      baseSha: 'sha1',
      commands: ['pnpm test'],
      verdict: 'fail',
    })
    await recorder.sandboxResult({
      attemptNumber: 2,
      candidateHash: 'xyz',
      baseSha: 'sha1',
      commands: ['pnpm test'],
      verdict: 'pass',
    })

    assert.equal(await recorder.latestSandboxVerdict(), 'pass')
  })

  it('publishedPrNumber returns null when no PR has been recorded', async () => {
    const recorder = createMemoryRecorder()
    assert.equal(await recorder.publishedPrNumber(), null)
  })

  it('publishedPrNumber returns the number from the most recently stored publication', async () => {
    const recorder = createMemoryRecorder()
    await recorder.prPublication({
      prNumber: 42,
      prUrl: 'https://github.com/acme/eval/pull/42',
      baseSha: 'sha1',
      candidateHash: 'abc',
    })

    assert.equal(await recorder.publishedPrNumber(), 42)
  })

  it('patchAttempt stores the record without modification', async () => {
    const recorder = createMemoryRecorder()
    const record = {
      attemptNumber: 1,
      candidateHash: 'abc123',
      patchDiff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n',
      outcome: 'failed_validation' as const,
      failureReason: 'pnpm test exited 1',
    }
    await recorder.patchAttempt(record)

    assert.deepEqual(recorder.patches, [record])
  })

  it('keeps a tool error message and timestamp as given', async () => {
    const recorder = createMemoryRecorder()
    const startedAt = new Date('2026-10-28T00:00:00.000Z')
    await recorder.toolInvocation({
      tool: 'git_push',
      args: { branch: 'main' },
      outcome: 'denied',
      errorMessage: 'not on the allowlist',
      startedAt,
    })

    assert.deepEqual(recorder.tools, [
      {
        tool: 'git_push',
        args: { branch: 'main' },
        outcome: 'denied',
        errorMessage: 'not on the allowlist',
        startedAt,
      },
    ])
  })

  it('multiple recorders are independent of each other', async () => {
    const r1 = createMemoryRecorder()
    const r2 = createMemoryRecorder()

    await r1.audit('event.a')
    await r2.audit('event.b')
    await r2.audit('event.c')

    assert.equal(r1.audits.length, 1)
    assert.equal(r2.audits.length, 2)
    assert.equal(r1.audits[0]?.eventType, 'event.a')
  })
})
