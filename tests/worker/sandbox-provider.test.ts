import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it } from 'node:test'
import {
  createDockerSandboxProvider,
  evictStaleCaches,
  warmSandboxImage,
} from '../../server/worker/sandbox-provider.ts'
import type { SandboxExecutionOptions, SandboxResult } from '../../server/sandbox/types.ts'

const ok: SandboxResult = {
  success: true,
  exitCode: 0,
  stdout: 'ok 1\nok 2',
  stderr: '',
  timedOut: false,
  durationMs: 10,
  reason: 'COMPLETED',
}

function fakeDocker(results: readonly SandboxResult[]) {
  const seen: SandboxExecutionOptions[] = []
  let index = 0
  const sandbox = {
    run: async (options: SandboxExecutionOptions) => {
      seen.push(options)
      return results[Math.min(index++, results.length - 1)] ?? ok
    },
  }
  return { seen, sandbox }
}

const provider = (
  results: readonly SandboxResult[],
  overrides: { installCommand?: string; workdir?: string; cacheDir?: string } = {},
) => {
  const { seen, sandbox } = fakeDocker(results)
  return {
    seen,
    provider: createDockerSandboxProvider({
      runId: 'run-1',
      workspacePath: '/tmp/adamant/run-1',
      installCommand: 'npm ci',
      testCommand: 'npm test',
      sandbox,
      ...overrides,
    }),
  }
}

describe('sandbox provider', () => {
  it('installs with a network and runs the tests with none', async () => {
    const { seen, provider: sandbox } = provider([ok, ok])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(outcome.verdict, 'pass')
    assert.deepEqual(
      seen.map((call) => [call.command, call.network]),
      [
        ['npm ci', 'bridge'],
        ['npm test', 'none'],
      ],
    )
    assert.deepEqual(outcome.commands, ['npm ci', 'npm test'])
  })

  it('skips the install step when none is configured', async () => {
    const { seen, provider: sandbox } = provider([ok], { installCommand: '' })

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.deepEqual(
      seen.map((call) => call.command),
      ['npm test'],
    )
    assert.deepEqual(outcome.commands, ['npm test'])
  })

  it('reports a non-zero test exit as a fail with its output', async () => {
    const { provider: sandbox } = provider([
      ok,
      { ...ok, success: false, exitCode: 1, stdout: 'not ok 1 - sum', stderr: 'failed' },
    ])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(outcome.verdict, 'fail')
    assert.equal(outcome.exitCode, 1)
    assert.match(outcome.output, /not ok 1 - sum/)
    assert.match(outcome.output, /failed/)
  })

  it('reports a timeout as its own verdict, not as a pass', async () => {
    const { provider: sandbox } = provider([
      ok,
      { ...ok, success: false, exitCode: null, timedOut: true, reason: 'TIMEOUT' },
    ])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(outcome.verdict, 'timeout')
    assert.equal(outcome.exitCode, undefined)
  })

  it('separates an infra failure from a test failure', async () => {
    const { provider: sandbox } = provider([
      ok,
      { ...ok, success: false, exitCode: null, reason: 'INFRA_FAILURE', error: 'no docker' },
    ])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(outcome.verdict, 'error')
  })

  it('does not run the tests when install fails', async () => {
    const { seen, provider: sandbox } = provider([
      { ...ok, success: false, exitCode: 1, stderr: 'ERR lockfile' },
    ])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(seen.length, 1)
    assert.equal(outcome.verdict, 'fail')
    assert.match(outcome.output, /ERR lockfile/)
  })

  it('bounds the output it hands back to the model', async () => {
    const { provider: sandbox } = provider([ok, { ...ok, stdout: 'x'.repeat(100_000) }])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.ok(outcome.output.length <= 16_000)
  })

  it('removes the container a dead worker left for this run before starting its own', async () => {
    const events: string[] = []
    const sandbox = {
      run: async (options: SandboxExecutionOptions) => {
        events.push(`run ${options.command}`)
        return ok
      },
      removeRunContainers: async (runId: string) => void events.push(`remove ${runId}`),
    }
    const provider = createDockerSandboxProvider({
      runId: 'run-1',
      workspacePath: '/tmp/adamant/run-1',
      installCommand: 'npm ci',
      testCommand: 'npm test',
      sandbox,
    })

    await provider.runValidation({ attemptNumber: 1, candidateHash: 'a' })
    await provider.runValidation({ attemptNumber: 2, candidateHash: 'b' })
    await provider.dispose()

    assert.deepEqual(events, [
      'remove run-1',
      'run npm ci',
      'run npm test',
      'run npm ci',
      'run npm test',
      'remove run-1',
    ])
  })

  it('reports how long the install and the tests took together', async () => {
    const { provider: sandbox } = provider([
      { ...ok, durationMs: 40_000 },
      { ...ok, durationMs: 15_000 },
    ])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(outcome.durationMs, 55_000)
  })

  it('reports the install time alone when the install fails', async () => {
    const { provider: sandbox } = provider([
      { ...ok, success: false, exitCode: 1, durationMs: 7_000 },
    ])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(outcome.durationMs, 7_000)
  })

  it('mounts the repository cache into the install container only', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adamant-cache-test-'))
    const dir = path.join(root, 'repo-1')
    try {
      const { seen, provider: sandbox } = provider([ok, ok], { cacheDir: dir })

      await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

      assert.equal(seen[0]?.cacheDir, dir)
      assert.equal(seen[0]?.env?.npm_config_cache, '/adamant-cache/npm')
      assert.equal(seen[0]?.env?.PIP_CACHE_DIR, '/adamant-cache/pip')
      assert.equal(seen[1]?.cacheDir, undefined, 'the test container gets no cache')
      assert.equal(seen[1]?.env, undefined)
      assert.ok((await fs.stat(dir)).isDirectory(), 'created before the first install')
      assert.ok((await fs.stat(path.join(dir, '.last-used'))).isFile(), 'stamped for eviction')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('tells pip not to cache when the repository has no cache directory', async () => {
    const { seen, provider: sandbox } = provider([ok, ok])

    await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.deepEqual(seen[0]?.env, { PIP_NO_CACHE_DIR: '1' })
    assert.equal(seen[0]?.cacheDir, undefined)
  })

  it('passes workdir option through to docker sandbox run calls', async () => {
    const { seen, provider: sandbox } = provider([ok, ok], { workdir: 'packages/backend' })

    await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(seen[0]?.workdir, 'packages/backend')
    assert.equal(seen[1]?.workdir, 'packages/backend')
  })
})

describe('sandbox image warm-up', () => {
  const quiet = { log: () => {}, error: () => {} }

  it('pulls the configured image and says so', async () => {
    const pulled: string[] = []
    const docker = {
      pullImage: async (image: string) => {
        pulled.push(image)
        return true
      },
    }

    assert.equal(await warmSandboxImage('ghcr.io/acme/ci:1', docker, quiet), true)
    assert.deepEqual(pulled, ['ghcr.io/acme/ci:1'])
  })

  it('reports a pull that failed instead of throwing at boot', async () => {
    const errors: string[] = []
    const docker = { pullImage: async () => false }

    const warmed = await warmSandboxImage('node:22-bookworm-slim', docker, {
      log: () => {},
      error: (message: string) => void errors.push(message),
    })

    assert.equal(warmed, false)
    assert.match(errors[0] ?? '', /could not pull node:22-bookworm-slim/)
  })
})

describe('sandbox focused tests', () => {
  async function checkout(testScript: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adamant-focus-test-'))
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: testScript } }),
    )
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'sum.test.ts'), '')
    return dir
  }
  const focus = ['src/sum.test.ts > sum > adds two numbers']
  const focused = "npm test -- 'src/sum.test.ts' -t 'adds two numbers'"

  it('runs the failing tests first and the whole suite only once they pass', async () => {
    const dir = await checkout('vitest run')
    try {
      const { seen, sandbox } = fakeDocker([ok, ok, { ...ok, durationMs: 5 }])
      const provider = createDockerSandboxProvider({
        runId: 'run-1',
        workspacePath: dir,
        installCommand: 'npm ci',
        testCommand: 'npm test',
        sandbox,
      })

      const outcome = await provider.runValidation({ attemptNumber: 2, candidateHash: 'b', focus })

      assert.deepEqual(
        seen.map((call) => [call.command, call.network]),
        [
          ['npm ci', 'bridge'],
          [focused, 'none'],
          ['npm test', 'none'],
        ],
      )
      assert.equal(outcome.verdict, 'pass')
      assert.deepEqual(outcome.commands, ['npm ci', 'npm test'], 'the suite is what was verified')
      assert.equal(outcome.durationMs, 25, 'install, focused and full runs together')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('stops at the failing tests while they still fail', async () => {
    const dir = await checkout('vitest run')
    try {
      const { seen, sandbox } = fakeDocker([
        ok,
        { ...ok, success: false, exitCode: 1, stdout: 'FAIL adds two numbers: expected 4' },
      ])
      const provider = createDockerSandboxProvider({
        runId: 'run-1',
        workspacePath: dir,
        installCommand: 'npm ci',
        testCommand: 'npm test',
        sandbox,
      })

      const outcome = await provider.runValidation({ attemptNumber: 2, candidateHash: 'b', focus })

      assert.deepEqual(
        seen.map((call) => call.command),
        ['npm ci', focused],
      )
      assert.equal(outcome.verdict, 'fail')
      assert.deepEqual(outcome.commands, ['npm ci', focused], 'says which run failed')
      assert.match(outcome.output, /expected 4/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('runs the whole suite as before when the runner is unknown or nothing is focused', async () => {
    const dir = await checkout('./scripts/test.sh')
    try {
      const { seen, sandbox } = fakeDocker([ok, ok, ok, ok])
      const provider = createDockerSandboxProvider({
        runId: 'run-1',
        workspacePath: dir,
        installCommand: 'npm ci',
        testCommand: 'npm test',
        sandbox,
      })

      await provider.runValidation({ attemptNumber: 2, candidateHash: 'b', focus })
      await provider.runValidation({ attemptNumber: 3, candidateHash: 'c' })

      // The fake install leaves nothing behind, so the second candidate installs again.
      assert.deepEqual(
        seen.map((call) => call.command),
        ['npm ci', 'npm test', 'npm ci', 'npm test'],
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('sandbox cache eviction', () => {
  it('removes caches no install has touched within the age and keeps the rest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adamant-evict-test-'))
    try {
      const day = 24 * 60 * 60_000
      const now = Date.now()
      for (const [name, age] of [
        ['idle', 20 * day],
        ['fresh', 1 * day],
      ] as const) {
        await fs.mkdir(path.join(root, name))
        const marker = path.join(root, name, '.last-used')
        await fs.writeFile(marker, '')
        await fs.utimes(marker, (now - age) / 1000, (now - age) / 1000)
      }
      await fs.mkdir(path.join(root, 'unstamped'))
      await fs.writeFile(path.join(root, 'a-file'), '')

      const removed = await evictStaleCaches(root, 14 * day, now)

      assert.deepEqual(removed, ['idle'])
      assert.deepEqual((await fs.readdir(root)).sort(), ['a-file', 'fresh', 'unstamped'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('is a no-op for a cache root that does not exist yet', async () => {
    assert.deepEqual(await evictStaleCaches(path.join(os.tmpdir(), 'adamant-missing-cache'), 1), [])
  })
})

describe('sandbox install reuse across candidates', () => {
  async function workspace() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adamant-sandbox-test-'))
    await fs.writeFile(path.join(dir, 'package.json'), '{"name":"eval"}')
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}')
    return dir
  }

  /** An install that leaves node_modules in the workspace, as `npm ci` does. */
  function installingDocker(dir: string, installResult: SandboxResult = ok) {
    const commands: string[] = []
    const sandbox = {
      run: async (options: SandboxExecutionOptions) => {
        commands.push(options.command)
        if (options.command === 'npm ci' && installResult.success) {
          await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true })
        }
        return options.command === 'npm ci' ? installResult : ok
      },
    }
    return { commands, sandbox }
  }

  function sandboxFor(dir: string, docker: ReturnType<typeof installingDocker>) {
    return createDockerSandboxProvider({
      runId: 'run-1',
      workspacePath: dir,
      installCommand: 'npm ci',
      testCommand: 'npm test',
      sandbox: docker.sandbox,
    })
  }

  it('skips the install for a candidate that left every manifest alone', async () => {
    const dir = await workspace()
    try {
      const docker = installingDocker(dir)
      const sandbox = sandboxFor(dir, docker)

      await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'a' })
      const second = await sandbox.runValidation({ attemptNumber: 2, candidateHash: 'b' })

      assert.deepEqual(docker.commands, ['npm ci', 'npm test', 'npm test'])
      assert.equal(second.verdict, 'pass')
      assert.deepEqual(second.commands, ['npm ci', 'npm test'], 'what was verified is unchanged')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('reinstalls when a candidate changes a lockfile', async () => {
    const dir = await workspace()
    try {
      const docker = installingDocker(dir)
      const sandbox = sandboxFor(dir, docker)

      await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'a' })
      await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"x":1}')
      await sandbox.runValidation({ attemptNumber: 2, candidateHash: 'b' })

      assert.deepEqual(docker.commands, ['npm ci', 'npm test', 'npm ci', 'npm test'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('reinstalls when the reset between candidates removed what install wrote', async () => {
    const dir = await workspace()
    try {
      const docker = installingDocker(dir)
      const sandbox = sandboxFor(dir, docker)

      await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'a' })
      await fs.rm(path.join(dir, 'node_modules'), { recursive: true })
      await sandbox.runValidation({ attemptNumber: 2, candidateHash: 'b' })

      assert.deepEqual(docker.commands, ['npm ci', 'npm test', 'npm ci', 'npm test'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('never reuses an install that failed', async () => {
    const dir = await workspace()
    try {
      const docker = installingDocker(dir, { ...ok, success: false, exitCode: 1 })
      const sandbox = sandboxFor(dir, docker)

      const first = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'a' })
      await sandbox.runValidation({ attemptNumber: 2, candidateHash: 'b' })

      assert.equal(first.verdict, 'fail')
      assert.deepEqual(docker.commands, ['npm ci', 'npm ci'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
