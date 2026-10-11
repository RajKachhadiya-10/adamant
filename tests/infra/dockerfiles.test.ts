import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * The images copy source directories one by one, so a new cross-directory
 * import (the worker reaching into server/api, say) boots fine locally and
 * then fails inside the container with ERR_MODULE_NOT_FOUND. This walks the
 * import graph from each image's entrypoint and checks every directory it
 * reaches is copied into the final stage.
 */
type Image = {
  /** Relative to the build context, like the COPY sources. */
  entrypoint: string
  copied: string[]
}

function parseImage(file: string): Image {
  const lines = readFileSync(path.join(repoRoot, file), 'utf8')
    .split('\n')
    .map((line) => line.trim())
  const lastFrom = lines.map((line, index) => (line.startsWith('FROM ') ? index : -1))
  const finalStage = lines.slice(Math.max(...lastFrom))

  let workdir = '/'
  let entrypoint: string | undefined
  const copied: string[] = []
  for (const line of finalStage) {
    const words = line.split(/\s+/)
    if (words[0] === 'WORKDIR' && words[1]) workdir = words[1]
    if (words[0] === 'COPY' && !line.includes('--from=')) {
      const sources = words.slice(1, -1).filter((word) => !word.startsWith('--'))
      copied.push(...sources)
    }
    // Exec form only; the HEALTHCHECK continuation line is also a shell-form CMD.
    if (words[0] === 'CMD' && words[1]?.startsWith('[')) {
      const args = JSON.parse(line.slice('CMD'.length)) as string[]
      entrypoint = args.find((arg) => arg.endsWith('.ts'))
    }
  }
  assert.ok(entrypoint, `${file} has no CMD running a .ts entrypoint`)
  // The final stage works under /app, which is the build context.
  return { entrypoint: path.join(path.relative('/app', workdir), entrypoint), copied }
}

const IMPORT_SPECIFIER =
  /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g

/** Repo-relative paths of every TypeScript file the entrypoint loads. */
function reachableFiles(entrypoint: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entrypoint]
  while (queue.length > 0) {
    const file = queue.pop()
    if (!file || seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(path.join(repoRoot, file), 'utf8')
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) continue
      if (specifier.startsWith('.')) {
        queue.push(path.normalize(path.join(path.dirname(file), specifier)))
      } else if (specifier === '@adamant/contract') {
        queue.push('contract/src/index.ts')
      }
    }
  }
  return seen
}

function uncopied(image: Image): string[] {
  const missing = new Set<string>()
  for (const file of reachableFiles(image.entrypoint)) {
    const covered = image.copied.some(
      (source) => file === source || file.startsWith(`${source.replace(/\/$/, '')}/`),
    )
    if (!covered) missing.add(file)
  }
  return [...missing].sort()
}

describe('Docker images', () => {
  for (const file of ['Dockerfile', 'Dockerfile.worker']) {
    it(`${file} copies every directory its entrypoint imports`, () => {
      const image = parseImage(file)
      assert.deepEqual(uncopied(image), [], `${file} runs ${image.entrypoint} without these files`)
    })
  }
})
