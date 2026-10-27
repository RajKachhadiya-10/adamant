/**
 * Turns a model reply into something `git apply` reads. Models wrap diffs in
 * Markdown fences and lead with a sentence even when told not to, and the
 * reply is trimmed, which drops the newline git needs after the last hunk.
 */
const DIFF_START = /^(?:diff --git |--- )/m

// The closing fence must sit at the start of a line: inside a diff every line
// carries a ` `, `+` or `-` prefix, so a fence in a patched Markdown file does
// not end the block early.
const FENCE = /```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm

const withFinalNewline = (text: string) => (text.endsWith('\n') ? text : `${text}\n`)

const fromHeader = (body: string) => {
  const start = body.search(DIFF_START)
  return start > 0 ? body.slice(start) : body
}

const PLAIN_FILE_HEADER = /^--- ([^\n]+)\n\+\+\+ ([^\n]+)\n(?=@@)/gm

/** The path after `a/` or `b/`; null for /dev/null; undefined when git would read it otherwise. */
function headerPath(name: string, prefix: 'a/' | 'b/'): string | null | undefined {
  // `diff -u` puts a tab and a timestamp after the name.
  const path = name.split('\t')[0]?.trim() ?? ''
  if (path === '/dev/null') return null
  return path.startsWith(prefix) && path.length > prefix.length
    ? path.slice(prefix.length)
    : undefined
}

/**
 * `git apply --recount` ends a hunk at the next `diff ` or `@@ ` line. Without
 * `diff --git` lines, which models often leave out, a second file's `---` and
 * `+++` read as two more lines of the first file's last hunk and git rejects
 * the whole patch. One file applies either way, so it keeps its bytes.
 */
function withGitHeaders(patch: string): string {
  if (/^diff --git /m.test(patch)) return patch
  if ([...patch.matchAll(PLAIN_FILE_HEADER)].length < 2) return patch

  return patch.replace(PLAIN_FILE_HEADER, (header, oldName: string, newName: string) => {
    const from = headerPath(oldName, 'a/')
    const to = headerPath(newName, 'b/')
    // A rename needs `rename from`/`rename to` lines a plain diff never has; left
    // as it was, it fails the way it did before.
    if (from === undefined || to === undefined || (from !== null && to !== null && from !== to)) {
      return header
    }
    const path = to ?? from
    if (path === null) return header
    const mode =
      from === null ? 'new file mode 100644\n' : to === null ? 'deleted file mode 100644\n' : ''
    return `diff --git a/${path} b/${path}\n${mode}${header}`
  })
}

export function normalizePatch(reply: string): string {
  // The API never means a carriage return; against an LF checkout it makes
  // every context line mismatch.
  const text = reply.replace(/\r\n?/g, '\n')
  const fences = [...text.matchAll(FENCE)].map((match) => match[1] ?? '')
  const diffs = fences.filter((body) => DIFF_START.test(body))

  // A reply that explains with a code block first, or fences one diff per
  // file, still yields one patch. With no diff-shaped fence, the first fence
  // (or the whole reply) is handed to git as before.
  if (diffs.length > 0) {
    return withGitHeaders(diffs.map((body) => withFinalNewline(fromHeader(body))).join(''))
  }
  return withGitHeaders(withFinalNewline(fromHeader(fences[0] ?? text)))
}
