import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { type SandboxOutcome, type SandboxProvider } from '../agent/deps.ts'
import { CACHE_MOUNT, DockerSandbox } from '../sandbox/index.ts'
import { type SandboxExecutionOptions, type SandboxResult } from '../sandbox/types.ts'
import { focusTestCommand } from './focus.ts'

/**
 * Proves a candidate in a sealed container. The candidate is already in the
 * workspace (`applyPatch` put it there), so this only runs commands and turns
 * the exit code into a verdict.
 *
 * Install may reach the network; tests never do. That split is the only reason
 * `network` is configurable at all — see docs/backend-architecture.md#sandbox.
 */
export interface SandboxRunnerOptions {
  readonly runId: string
  readonly workspacePath: string
  readonly workdir?: string
  /** Run once before the test command, with the network on. Skipped when empty. */
  readonly installCommand?: string
  readonly testCommand: string
  readonly image?: string
  /** The image's own user when it has one; `node` otherwise, as DockerSandbox defaults. */
  readonly user?: string
  /**
   * This repository's package cache on the host, mounted into the install
   * container only. Created on first use. Absent: every install is cold.
   */
  readonly cacheDir?: string
  readonly timeoutMs?: number
  readonly installTimeoutMs?: number
  readonly sandbox?: Pick<DockerSandbox, 'run'> &
    Partial<Pick<DockerSandbox, 'removeRunContainers'>>
}

export interface DockerSandboxProvider extends SandboxProvider {
  /** Removes any container still running for this run. Call it when the run ends. */
  dispose(): Promise<void>
}

const MAX_OUTPUT_CHARS = 16_000
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000
const DEFAULT_TEST_TIMEOUT_MS = 600_000
/** What `readSandboxSettings` falls back to; the warm-up runs before any run reads settings. */
export const DEFAULT_SANDBOX_IMAGE = 'node:22-bookworm-slim'
/** Written into a repository's cache at each install, so eviction knows what is idle. */
const LAST_USED_MARKER = '.last-used'

/** Files whose contents decide what an install produces. */
const DEPENDENCY_MANIFESTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lockb',
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'Cargo.lock',
  'Gemfile.lock',
]

/** What a previous successful install in this run left behind. */
interface InstallRecord {
  readonly fingerprint: string
  /** Top-level entries the install created, e.g. node_modules. */
  readonly outputs: readonly string[]
}

function workdirPath(workspacePath: string, workdir: string | undefined): string {
  if (!workdir?.trim()) return workspacePath
  const resolved = path.resolve(workspacePath, workdir.trim().replace(/^[/\\]+/, ''))
  return resolved.startsWith(`${workspacePath}${path.sep}`) ? resolved : workspacePath
}

async function fingerprint(dirs: readonly string[], extra: readonly string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const part of extra) hash.update(`${part}\0`)
  for (const dir of new Set(dirs)) {
    for (const name of DEPENDENCY_MANIFESTS) {
      const content = await fs.readFile(path.join(dir, name)).catch(() => null)
      hash.update(`${dir}/${name}\0`)
      hash.update(content ?? '\0missing\0')
    }
  }
  return hash.digest('hex')
}

async function entries(dir: string): Promise<Set<string>> {
  return new Set(await fs.readdir(dir).catch(() => []))
}

async function allExist(paths: readonly string[]): Promise<boolean> {
  const checks = await Promise.all(
    paths.map((target) =>
      fs.access(target).then(
        () => true,
        () => false,
      ),
    ),
  )
  return checks.every(Boolean)
}

function tail(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text
}

function combine(result: SandboxResult): string {
  return tail([result.stdout, result.stderr].filter((part) => part.trim().length > 0).join('\n'))
}

/** Infra problems are not a verdict on the patch; they are reported as `error`. */
function verdictFor(result: SandboxResult): SandboxOutcome['verdict'] {
  if (result.reason === 'TIMEOUT') return 'timeout'
  if (result.reason === 'INFRA_FAILURE' || result.reason === 'INVALID_WORKSPACE') return 'error'
  return result.success ? 'pass' : 'fail'
}

export function createDockerSandboxProvider(options: SandboxRunnerOptions): DockerSandboxProvider {
  const docker = options.sandbox ?? new DockerSandbox()
  const commands = [options.installCommand, options.testCommand].filter(
    (command): command is string => Boolean(command && command.trim()),
  )

  // A retry of this run may find the previous worker's container still
  // running in the worktree: the daemon outlived the worker that started it.
  // It is removed once, before this run's first container.
  let cleared: Promise<void> | null = null
  const clearLeftovers = () =>
    (cleared ??= docker.removeRunContainers?.(options.runId) ?? Promise.resolve())

  const execute = async (command: string, extra: Partial<SandboxExecutionOptions>) => {
    await clearLeftovers()
    return docker.run({
      runId: options.runId,
      workspacePath: options.workspacePath,
      ...(options.workdir ? { workdir: options.workdir } : {}),
      command,
      ...(options.image === undefined ? {} : { image: options.image }),
      ...(options.user === undefined ? {} : { user: options.user }),
      ...extra,
    })
  }

  const installDir = workdirPath(options.workspacePath, options.workdir)
  let installed: InstallRecord | null = null

  /**
   * A retry re-ran the full install (often a minute) for a candidate that did
   * not touch a dependency. It is reused only when every manifest is
   * byte-identical and what the last install created is still on disk:
   * `git clean` removes it between candidates unless the repo ignores it.
   */
  async function canReuseInstall(print: string): Promise<boolean> {
    if (!installed || installed.fingerprint !== print || installed.outputs.length === 0) {
      return false
    }
    return allExist(installed.outputs)
  }

  return {
    async runValidation(input) {
      const focus = input.focus ?? []
      if (options.installCommand?.trim()) {
        const print = await fingerprint(
          [options.workspacePath, installDir],
          [options.installCommand, options.image ?? ''],
        )
        if (await canReuseInstall(print)) {
          return runTests(0, focus)
        }

        const before = await entries(installDir)
        const install = await execute(options.installCommand, {
          network: 'bridge',
          timeoutMs: options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
          ...(await installCache()),
        })

        if (!install.success) {
          installed = null
          return {
            verdict: verdictFor(install) === 'pass' ? 'error' : verdictFor(install),
            commands,
            output: combine(install),
            ...(install.exitCode === null ? {} : { exitCode: install.exitCode }),
            durationMs: install.durationMs,
          }
        }

        const after = await entries(installDir)
        installed = {
          fingerprint: print,
          outputs: [...after]
            .filter((name) => !before.has(name))
            .map((name) => path.join(installDir, name)),
        }
        return runTests(install.durationMs, focus)
      }

      return runTests(0, focus)
    },

    async dispose() {
      await docker.removeRunContainers?.(options.runId)
    },
  }

  /**
   * The repository's package cache for the install container, with each
   * manager pointed at its own directory under the mount. Without one, pip is
   * told not to cache: the Python image's user has no home to cache in.
   */
  async function installCache(): Promise<Pick<SandboxExecutionOptions, 'cacheDir' | 'env'>> {
    const dir = options.cacheDir
    if (!dir) return { env: { PIP_NO_CACHE_DIR: '1' } }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, LAST_USED_MARKER), new Date().toISOString())
    return {
      cacheDir: dir,
      env: {
        npm_config_cache: `${CACHE_MOUNT}/npm`,
        npm_config_store_dir: `${CACHE_MOUNT}/pnpm`,
        YARN_CACHE_FOLDER: `${CACHE_MOUNT}/yarn`,
        PIP_CACHE_DIR: `${CACHE_MOUNT}/pip`,
      },
    }
  }

  /** A command for just the failing tests, when the runner and the names allow one. */
  function focusedCommand(focus: readonly string[]): Promise<string | null> {
    if (focus.length === 0) return Promise.resolve(null)
    return focusTestCommand(options.testCommand, focus, {
      scripts: async () => {
        try {
          const text = await fs.readFile(path.join(installDir, 'package.json'), 'utf8')
          return (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? null
        } catch {
          return null
        }
      },
      exists: (relative) =>
        fs.access(path.join(installDir, relative)).then(
          () => true,
          () => false,
        ),
    })
  }

  /**
   * `installMs` is the install that ran just before, so the verdict's time
   * covers it. With `focus`, the failing tests run first: a failure there is
   * the verdict, and only a pass goes on to the whole suite, which alone can
   * say `pass`.
   */
  async function runTests(installMs = 0, focus: readonly string[] = []): Promise<SandboxOutcome> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS
    let spent = installMs

    const focused = await focusedCommand(focus)
    if (focused) {
      const quick = await execute(focused, { network: 'none', timeoutMs })
      spent += quick.durationMs
      if (verdictFor(quick) !== 'pass') {
        return {
          verdict: verdictFor(quick),
          commands: [...commands.slice(0, -1), focused],
          output: combine(quick),
          ...(quick.exitCode === null ? {} : { exitCode: quick.exitCode }),
          durationMs: spent,
        }
      }
    }

    const tests = await execute(options.testCommand, { network: 'none', timeoutMs })
    return {
      verdict: verdictFor(tests),
      commands,
      output: combine(tests),
      ...(tests.exitCode === null ? {} : { exitCode: tests.exitCode }),
      durationMs: spent + tests.durationMs,
    }
  }
}

/**
 * Removes repository caches under `cacheRoot` that no install has touched for
 * `maxAgeMs`. Run at worker boot, off the run path; a repository that comes
 * back simply starts cold again. Returns the names it removed.
 */
export async function evictStaleCaches(
  cacheRoot: string,
  maxAgeMs: number,
  now = Date.now(),
): Promise<string[]> {
  const names = await fs.readdir(cacheRoot).catch(() => [] as string[])
  const removed: string[] = []
  for (const name of names) {
    const dir = path.join(cacheRoot, name)
    const entry = await fs.stat(dir).catch(() => null)
    if (!entry?.isDirectory()) continue
    const marker = await fs.stat(path.join(dir, LAST_USED_MARKER)).catch(() => null)
    if (now - (marker?.mtimeMs ?? entry.mtimeMs) < maxAgeMs) continue
    await fs.rm(dir, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

/**
 * Pulls the sandbox image at boot, off the run path. On a cold host the first
 * `docker run` otherwise spends its first minute on the registry, inside a
 * heal's install timeout. A failed pull is logged and nothing more: the next
 * `docker run` pulls on its own, as it always did.
 */
export async function warmSandboxImage(
  image = process.env.ADAMANT_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
  docker: Pick<DockerSandbox, 'pullImage'> = new DockerSandbox(),
  log: Pick<Console, 'log' | 'error'> = console,
): Promise<boolean> {
  const pulled = await docker.pullImage(image)
  if (pulled) log.log(`@adamant/worker sandbox image ready: ${image}`)
  else log.error(`@adamant/worker could not pull ${image}; the first sandbox run will try again`)
  return pulled
}
