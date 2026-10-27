import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type GitProvider } from '../../server/agent/deps.ts'
import { normalizePatch } from '../../server/agent/patch.ts'
import { createMemoryRecorder } from '../../server/agent/recorder.ts'
import { describeSources, readSources } from '../../server/agent/sources.ts'
import { SecureGitClient } from '../../server/agent/tools.ts'
import { findLocations, parseFailure } from '../../server/agent/triage.ts'

const diff = '--- a/src/sum.ts\n+++ b/src/sum.ts\n@@ -1 +1 @@\n-a\n+b\n'

describe('normalizePatch', () => {
  it('restores the newline git needs after the last hunk', () => {
    assert.equal(normalizePatch(diff.trimEnd()), diff)
  })

  it('takes the diff out of a Markdown fence and drops the prose around it', () => {
    const reply = `Here is the fix:\n\n\`\`\`diff\n${diff}\`\`\`\n\nThis restores addition.`
    assert.equal(normalizePatch(reply), diff)
  })

  it('drops a sentence before an unfenced diff', () => {
    assert.equal(normalizePatch(`The fix:\n${diff}`), diff)
  })

  it('picks the fenced block that holds the diff, not the first fence', () => {
    const reply = `The bug:\n\n\`\`\`ts\nreturn a - b\n\`\`\`\n\nThe fix:\n\n\`\`\`diff\n${diff}\`\`\`\n`
    assert.equal(normalizePatch(reply), diff)
  })

  it('joins one fenced diff per file into a single patch', () => {
    const second = '--- a/src/mul.ts\n+++ b/src/mul.ts\n@@ -1 +1 @@\n-c\n+d\n'
    const reply = `\`\`\`diff\n${diff}\`\`\`\n\nAnd:\n\n\`\`\`diff\n${second}\`\`\`\n`
    assert.equal(
      normalizePatch(reply),
      `diff --git a/src/sum.ts b/src/sum.ts\n${diff}diff --git a/src/mul.ts b/src/mul.ts\n${second}`,
    )
  })

  it('gives each file of a multi-file diff without git headers its own diff --git line', () => {
    // Without them `git apply --recount` reads the second header as hunk lines.
    const second = '--- a/src/mul.ts\t2026-10-28 10:00:00\n+++ b/src/mul.ts\n@@ -1 +1 @@\n-c\n+d\n'
    assert.equal(
      normalizePatch(diff + second),
      `diff --git a/src/sum.ts b/src/sum.ts\n${diff}diff --git a/src/mul.ts b/src/mul.ts\n${second}`,
    )
  })

  it('marks created and deleted files so git does not look for /dev/null', () => {
    const created = '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+fresh\n'
    const deleted = '--- a/src/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-stale\n'
    assert.equal(
      normalizePatch(created + deleted),
      [
        'diff --git a/src/new.ts b/src/new.ts',
        'new file mode 100644',
        created + 'diff --git a/src/old.ts b/src/old.ts',
        'deleted file mode 100644',
        deleted,
      ].join('\n'),
    )
  })

  it('leaves a diff that already has diff --git lines as it is', () => {
    const git = `diff --git a/src/sum.ts b/src/sum.ts\n${diff}--- a/src/mul.ts\n+++ b/src/mul.ts\n@@ -1 +1 @@\n-c\n+d\n`
    assert.equal(normalizePatch(git), git)
  })

  it('adds no header to a rename or to names without a/ and b/', () => {
    const renamed = '--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-a\n+b\n'
    const bare = '--- src/mul.ts\n+++ src/mul.ts\n@@ -1 +1 @@\n-c\n+d\n'
    assert.equal(
      normalizePatch(diff + renamed + bare),
      `diff --git a/src/sum.ts b/src/sum.ts\n${diff}${renamed}${bare}`,
    )
  })

  it('does not end the fence at a fence line inside a diff of a Markdown file', () => {
    const readme = [
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1,4 @@',
      ' # Title',
      '+```sh',
      '+pnpm test',
      '+```',
      '',
    ].join('\n')
    assert.equal(normalizePatch(`\`\`\`diff\n${readme}\`\`\``), readme)
  })

  it('normalizes CRLF line endings, which apply rejects against an LF file', () => {
    assert.equal(normalizePatch(diff.replace(/\n/g, '\r\n')), diff)
  })
})

describe('findLocations', () => {
  it('returns each file once, in order, and skips node_modules', () => {
    const text = [
      'at Object.<anonymous> (/home/runner/work/eval/eval/src/sum.test.ts:4:11)',
      'at sum (node_modules/lib/index.js:9:2)',
      'at sum (src/sum.ts:2:10)',
      'at again (src/sum.ts:7:1)',
    ].join('\n')

    assert.deepEqual(findLocations(text, 5), [
      { file: '/home/runner/work/eval/eval/src/sum.test.ts', line: 4 },
      { file: 'src/sum.ts', line: 2 },
    ])
  })
})

describe('readSources', () => {
  const file = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n')

  it('shows a window around the failing line, not the whole file', async () => {
    const failure = parseFailure('Error: boom\n    at run (src/big.ts:150:3)')
    const [source] = await readSources(async () => ({ path: 'src/big.ts', text: file }), failure)

    assert.equal(source?.path, 'src/big.ts')
    assert.equal(source?.startLine, 90)
    assert.equal(source?.text.split('\n')[0], 'line 90')
    assert.equal(source?.text.split('\n').at(-1), 'line 200')
  })

  it('keeps the failing line when the lines before it are long', async () => {
    const wide = Array.from({ length: 200 }, (_, index) => `line ${index + 1} ${'x'.repeat(300)}`)
    const failure = parseFailure('Error: boom\n    at run (src/wide.ts:100:3)')
    const [source] = await readSources(
      async () => ({ path: 'src/wide.ts', text: wide.join('\n') }),
      failure,
    )

    assert.ok(source, 'the file is shown')
    assert.ok(source.text.length <= 8_000)
    const shown = source.text.split('\n')
    assert.ok(shown.includes(wide[99] ?? ''), 'line 100 is in the window')
    assert.equal(shown[0], wide[source.startLine - 1], 'startLine names the first line shown')
    assert.ok(
      shown.every((line) => wide.includes(line)),
      'no line is cut mid-way',
    )
  })

  it('shows the end of the file when the log names a line past it', async () => {
    const failure = parseFailure('Error: boom\n    at run (src/short.ts:900:3)')
    const [source] = await readSources(
      async () => ({ path: 'src/short.ts', text: 'first\nsecond\nthird\n' }),
      failure,
    )

    assert.equal(source?.startLine, 1)
    assert.equal(source?.text, 'first\nsecond\nthird')
  })

  it('redacts a key block the window cuts through and keeps line numbers', async () => {
    const key = [
      '-----BEGIN PRIVATE KEY-----',
      ...Array.from({ length: 30 }, () => 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'),
      '-----END PRIVATE KEY-----',
    ]
    const text = [
      ...Array.from({ length: 70 }, (_, index) => `line ${index + 1}`),
      ...key,
      ...Array.from({ length: 70 }, (_, index) => `line ${index + 103}`),
    ].join('\n')
    const failure = parseFailure('Error: boom\n    at run (src/keys.ts:20:3)')
    const [source] = await readSources(async () => ({ path: 'src/keys.ts', text }), failure)

    assert.equal(
      source?.text.includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'),
      false,
    )
    assert.equal(source?.text.includes('BEGIN PRIVATE KEY'), false)
    assert.equal(source?.startLine, 1)
    assert.equal(source?.text.split('\n')[70], '[redacted]', 'line 71 is still line 71')
  })

  it('skips files it cannot find or read and still returns the rest', async () => {
    const failure = parseFailure(
      'Error: boom\n at a (src/missing.ts:1:1)\n at b (src/found.ts:1:1)',
    )
    const sources = await readSources(async (fromLog) => {
      if (fromLog === 'src/missing.ts') throw new Error('EACCES')
      return { path: fromLog, text: 'export {}' }
    }, failure)

    assert.deepEqual(
      sources.map((source) => source.path),
      ['src/found.ts'],
    )
  })

  it('redacts a secret-shaped value in the source before the prompt sees it', async () => {
    const failure = parseFailure('Error: boom at src/config.ts:1')
    const [source] = await readSources(
      async () => ({ path: 'src/config.ts', text: 'const key = "sk-abcdefghijklmnopqrstuvwx"' }),
      failure,
    )

    assert.equal(source?.text.includes('sk-abcdefghijklmnopqrstuvwx'), false)
  })

  it('says so when the log named no file in the checkout', () => {
    assert.match(describeSources([]), /no file from the log was found/)
  })
})

describe('git_read_file tool', () => {
  it('logs the path with the run id, never the file contents', async () => {
    const recorder = createMemoryRecorder()
    const git = {
      readFile: async () => ({ path: 'src/a.ts', text: 'SECRET_BODY' }),
    } as unknown as GitProvider
    const client = new SecureGitClient(git, 'run-9', recorder)

    const found = await client.readFile('src/a.ts')

    assert.equal(found?.text, 'SECRET_BODY')
    assert.deepEqual(
      recorder.tools.map((row) => [row.tool, row.outcome, row.args]),
      [['git_read_file', 'ok', { path: 'src/a.ts', runId: 'run-9' }]],
    )
    assert.equal(JSON.stringify(recorder.tools).includes('SECRET_BODY'), false)
  })
})
