import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildPrTitle,
  buildCommitMessage,
  buildPrBody,
  summarizePatch,
  MADE_WITH,
  type PrContent,
} from '../../server/agent/pr.ts'
import { type FailureContext } from '../../server/agent/triage.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal FailureContext with sensible defaults; override per test. */
function failure(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    firstError: null,
    location: null,
    failingTests: [],
    excerpt: '',
    ...overrides,
  }
}

/** Minimal valid PrContent for buildPrBody. */
function prContent(overrides: Partial<PrContent> = {}): PrContent {
  return {
    runId: 'run-abc123',
    failure: failure(),
    diagnostics: 'The addition operator was replaced with subtraction.',
    plan: 'Change `-` back to `+` in src/sum.ts.',
    commands: ['pnpm test'],
    attemptNumber: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildPrTitle
// ---------------------------------------------------------------------------

describe('buildPrTitle', () => {
  it('uses firstError as the title subject', () => {
    const title = buildPrTitle(failure({ firstError: 'AssertionError: Expected 3 to equal 5' }))
    assert.match(title, /^fix: AssertionError: Expected 3 to equal 5$/)
  })

  it('falls back to the first failing test name when firstError is null', () => {
    const title = buildPrTitle(failure({ firstError: null, failingTests: ['adds two numbers'] }))
    assert.match(title, /^fix: adds two numbers$/)
  })

  it('falls back to a generic message when both firstError and failingTests are absent', () => {
    const title = buildPrTitle(failure({ firstError: null, failingTests: [] }))
    assert.equal(title, 'fix: failing CI check')
  })

  it('truncates a firstError longer than 60 characters to 57 plus an ellipsis', () => {
    const title = buildPrTitle(failure({ firstError: 'A'.repeat(70) }))
    assert.equal(title, `fix: ${'A'.repeat(57)}...`)
  })

  it('keeps a firstError of exactly 60 characters whole', () => {
    const title = buildPrTitle(failure({ firstError: 'A'.repeat(60) }))
    assert.equal(title, `fix: ${'A'.repeat(60)}`)
  })

  it('redacts before truncating, so a token near the cut is never half-shown', () => {
    // 61 characters raw: cutting first would leave `ghs_` and 12 characters, too
    // short for the token pattern to catch.
    const title = buildPrTitle(failure({ firstError: `${'x'.repeat(40)} ghs_ABCDEFGHIJKLMNOP` }))
    assert.equal(title, `fix: ${'x'.repeat(40)} [redacted]`)
  })

  it('uses only the first line of a multi-line firstError', () => {
    const title = buildPrTitle(
      failure({ firstError: 'TypeError: Cannot read property\n  at Object.<anonymous>' }),
    )
    assert.equal(title, 'fix: TypeError: Cannot read property')
  })

  it('redacts a GitHub token-shaped value inside firstError', () => {
    // ghs_ prefix with 16+ alphanumeric chars matches the redaction pattern
    const title = buildPrTitle(failure({ firstError: 'Error: token ghs_ABCDEFGHIJKLMNOP leaked' }))
    assert.ok(!title.includes('ghs_ABCDEFGHIJKLMNOP'), 'raw token must not appear in title')
    assert.ok(title.includes('[redacted]'), 'redacted placeholder must appear')
  })
})

// ---------------------------------------------------------------------------
// buildCommitMessage
// ---------------------------------------------------------------------------

describe('buildCommitMessage', () => {
  it('includes the run ID in the commit message body', () => {
    const msg = buildCommitMessage(failure({ firstError: 'boom' }), 'run-xyz')
    assert.ok(msg.includes('Adamant run run-xyz.'), 'run ID line must be present')
  })

  it('includes the MADE_WITH constant', () => {
    const msg = buildCommitMessage(failure(), 'run-1')
    assert.ok(msg.includes(MADE_WITH))
  })

  it('title line matches what buildPrTitle returns', () => {
    const f = failure({ firstError: 'NullPointerException at line 42' })
    const msg = buildCommitMessage(f, 'run-2')
    const firstLine = msg.split('\n')[0]
    assert.equal(firstLine, buildPrTitle(f))
  })

  it('uses blank lines to separate the title, run ID, and footer', () => {
    const msg = buildCommitMessage(failure({ firstError: 'err' }), 'run-3')
    assert.equal(msg, ['fix: err', '', 'Adamant run run-3.', '', MADE_WITH].join('\n'))
  })
})

// ---------------------------------------------------------------------------
// summarizePatch
// ---------------------------------------------------------------------------

/** Builds a minimal valid unified diff for a single file. */
function onePatch(path: string, added: string[], removed: string[]): string {
  const hunks = [
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ]
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks, ''].join(
    '\n',
  )
}

describe('summarizePatch', () => {
  it('returns an empty array for an empty string', () => {
    assert.deepEqual(summarizePatch(''), [])
  })

  it('returns an empty array when no diff headers are present', () => {
    assert.deepEqual(summarizePatch('not a diff at all\njust text'), [])
  })

  it('counts added and removed lines for a single-file patch', () => {
    const patch = onePatch('src/sum.ts', ['return a + b'], ['return a - b'])
    const result = summarizePatch(patch)
    assert.equal(result.length, 1)
    assert.equal(result[0]?.path, 'src/sum.ts')
    assert.equal(result[0]?.added, 1)
    assert.equal(result[0]?.removed, 1)
  })

  it('accumulates counts across multiple hunks in one file', () => {
    const patch = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,1 +1,2 @@',
      '-old line 1',
      '+new line 1',
      '+new line 2',
      '@@ -10,1 +11,0 @@',
      '-old line 10',
      '',
    ].join('\n')
    const result = summarizePatch(patch)
    assert.equal(result.length, 1)
    assert.equal(result[0]?.added, 2)
    assert.equal(result[0]?.removed, 2)
  })

  it('returns one entry per file for a multi-file patch', () => {
    const patch =
      onePatch('src/a.ts', ['new a'], ['old a']) + onePatch('src/b.ts', ['new b', 'b2'], [])
    assert.deepEqual(summarizePatch(patch), [
      { path: 'src/a.ts', added: 1, removed: 1 },
      { path: 'src/b.ts', added: 2, removed: 0 },
    ])
  })

  it('names a new file by its b/ path, not /dev/null', () => {
    const patch = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const one = 1',
      '+export const two = 2',
      '',
    ].join('\n')
    assert.deepEqual(summarizePatch(patch), [{ path: 'src/new.ts', added: 2, removed: 0 }])
  })

  it('counts a removed line that starts with -- and an added line that starts with ++', () => {
    // Inside a hunk these are content (`-- sql comment`, `++i`), not file headers.
    const patch = onePatch('q.sql', ['++ added'], ['-- old comment'])
    assert.deepEqual(summarizePatch(patch), [{ path: 'q.sql', added: 1, removed: 1 }])
  })

  it('uses the destination path (b/) from a rename', () => {
    // A rename: `diff --git a/old.ts b/new.ts` with `+++ b/new.ts`
    const patch = [
      'diff --git a/old.ts b/new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n')
    const result = summarizePatch(patch)
    assert.equal(result.length, 1)
    // The `diff --git` line regex captures the b/ path → 'new.ts'
    assert.equal(result[0]?.path, 'new.ts')
  })

  it('does not update path when +++ points to /dev/null (file deletion)', () => {
    // Deletion: `+++ /dev/null` must NOT overwrite the path extracted from diff --git
    const patch = [
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-deleted line',
      '',
    ].join('\n')
    const result = summarizePatch(patch)
    assert.equal(result.length, 1)
    assert.equal(result[0]?.path, 'gone.ts')
    assert.equal(result[0]?.removed, 1)
    assert.equal(result[0]?.added, 0)
  })

  it('does not count context lines (lines without + or - prefix)', () => {
    const patch = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,3 +1,3 @@',
      ' context line',
      '-removed',
      '+added',
      ' another context',
      '',
    ].join('\n')
    const result = summarizePatch(patch)
    assert.equal(result[0]?.added, 1)
    assert.equal(result[0]?.removed, 1)
  })
})

// ---------------------------------------------------------------------------
// buildPrBody
// ---------------------------------------------------------------------------

describe('buildPrBody', () => {
  it('contains all expected section headings', () => {
    const body = buildPrBody(prContent())
    for (const heading of [
      '## Summary',
      '## Changes',
      '## Cause',
      '## Evidence',
      '## Fix',
      '## Verified',
      '## Not checked',
    ]) {
      assert.ok(body.includes(heading), `missing section: ${heading}`)
    }
  })

  it('includes the MADE_WITH footer', () => {
    assert.ok(buildPrBody(prContent()).includes(MADE_WITH))
  })

  it('includes the run ID in the footer', () => {
    const body = buildPrBody(prContent({ runId: 'run-unique-99' }))
    assert.ok(body.includes('run-unique-99'))
  })

  it('lists sandbox commands under ## Verified', () => {
    const body = buildPrBody(prContent({ commands: ['pnpm ci', 'pnpm test'] }))
    assert.ok(body.includes('`pnpm ci`'))
    assert.ok(body.includes('`pnpm test`'))
  })

  it('lists failing tests under ## Evidence when they are present', () => {
    const body = buildPrBody(
      prContent({ failure: failure({ failingTests: ['adds two numbers', 'divides by zero'] }) }),
    )
    assert.ok(body.includes('`adds two numbers`'))
    assert.ok(body.includes('`divides by zero`'))
  })

  it('shows fallback text under ## Evidence when no failing tests are named', () => {
    const body = buildPrBody(prContent({ failure: failure({ failingTests: [] }) }))
    assert.ok(body.includes('_none named in the log_'))
  })

  it('truncates long diagnostics at 4000 characters and appends _(truncated)_', () => {
    const longDiagnostics = 'x'.repeat(5_000)
    const body = buildPrBody(prContent({ diagnostics: longDiagnostics }))
    assert.ok(body.includes('_(truncated)_'), 'truncation marker must appear')
    // The raw 5000-char string must not appear verbatim
    assert.ok(!body.includes('x'.repeat(5_000)))
  })

  it('keeps exactly the first 4000 characters of a long plan', () => {
    const body = buildPrBody(prContent({ plan: `${'p'.repeat(4_000)}TAIL` }))
    assert.ok(body.includes(`${'p'.repeat(4_000)}\n\n_(truncated)_`))
    assert.ok(!body.includes('TAIL'))
  })

  it('writes _not recorded_ for an empty or whitespace-only diagnosis and plan', () => {
    const body = buildPrBody(prContent({ diagnostics: '', plan: '  \n ' }))
    assert.ok(body.includes('## Cause\n_not recorded_\n'))
    assert.ok(body.includes('## Fix\n_not recorded_\n'))
  })

  it('does not truncate diagnostics that fit within 4000 characters', () => {
    const shortDiagnostics = 'Short diagnosis.'
    const body = buildPrBody(prContent({ diagnostics: shortDiagnostics }))
    assert.ok(body.includes(shortDiagnostics))
    assert.ok(!body.includes('_(truncated)_'))
  })

  it('redacts a GitHub token in diagnostics', () => {
    const body = buildPrBody(
      prContent({ diagnostics: 'Leaked: ghs_ABCDEFGHIJKLMNOP in the output.' }),
    )
    assert.ok(!body.includes('ghs_ABCDEFGHIJKLMNOP'), 'raw token must not be in PR body')
    assert.ok(body.includes('[redacted]'))
  })

  it('shows _See the diff._ in ## Changes when no patch is provided', () => {
    // prContent() base fixture omits patch (optional); explicit undefined would
    // violate exactOptionalPropertyTypes, so we omit the key entirely.
    const body = buildPrBody(prContent())
    assert.ok(body.includes('_See the diff._'))
  })

  it('lists changed files from a patch in ## Changes with their line counts', () => {
    const patch = onePatch('src/sum.ts', ['return a + b'], ['return a - b'])
    const body = buildPrBody(prContent({ patch }))
    assert.ok(body.includes('## Changes\n- `src/sum.ts` (+1 −1)\n'))
  })

  it('names the first error and location under ## Evidence, or says they were not found', () => {
    const found = buildPrBody(
      prContent({ failure: failure({ firstError: 'boom', location: 'src/sum.ts:3' }) }),
    )
    assert.ok(found.includes('- First error: `boom`'))
    assert.ok(found.includes('- Location: `src/sum.ts:3`'))

    const missing = buildPrBody(prContent())
    assert.ok(missing.includes('- First error: `not identified`'))
    assert.ok(missing.includes('- Location: `not identified`'))
  })

  it('includes attempt count in Summary when more than one attempt was needed', () => {
    const body = buildPrBody(prContent({ attemptNumber: 3 }))
    assert.ok(body.includes('3 attempts'))
  })

  it('omits attempt count in Summary when only one attempt was needed', () => {
    const body = buildPrBody(prContent({ attemptNumber: 1 }))
    assert.ok(!body.includes('attempt'))
  })

  it('includes branch name and short SHA in Summary when repository and baseSha are provided', () => {
    const body = buildPrBody(
      prContent({
        repository: { owner: 'acme', name: 'eval', branch: 'main' },
        baseSha: 'deadbeef1234567',
      }),
    )
    assert.ok(body.includes('`main`'))
    assert.ok(body.includes('deadbee'), 'short SHA must appear')
  })

  it('omits repository context from Summary when repository is not provided', () => {
    // prContent() omits repository and baseSha by default; passing undefined explicitly
    // would violate exactOptionalPropertyTypes.
    const body = buildPrBody(prContent())
    // Without repository, the "on `branch` at SHA" clause is absent
    assert.ok(!body.includes(' on `'))
  })

  it('links the failing commit in the footer when repository and baseSha are known', () => {
    const sha = 'deadbeef1234567890deadbeef1234567890dead'
    const body = buildPrBody(
      prContent({ repository: { owner: 'acme', name: 'eval', branch: 'main' }, baseSha: sha }),
    )
    assert.ok(
      body.includes(
        `Run \`run-abc123\` · [failing commit deadbee](https://github.com/acme/eval/commit/${sha})`,
      ),
    )
  })

  it('names the branch without a SHA or commit link when baseSha is missing', () => {
    const body = buildPrBody(
      prContent({ repository: { owner: 'acme', name: 'eval', branch: 'release' } }),
    )
    assert.ok(body.includes('CI failed on `release` with a failing check.'))
    assert.ok(!body.includes('failing commit'))
  })
})
