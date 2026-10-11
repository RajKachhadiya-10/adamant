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
    return diffs.map((body) => withFinalNewline(fromHeader(body))).join('')
  }
  return withFinalNewline(fromHeader(fences[0] ?? text))
}
