import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import type { SandboxExecutionOptions, SandboxResult, SpawnFunction } from './types.ts'

const MAX_BUFFER_BYTES = 512 * 1024 // 512KB bounded tail
/** Set on every container so leftovers can be found by run, whoever started them. */
const RUN_LABEL = 'adamant.run'
/** Where a repository's package cache appears inside an install container. */
export const CACHE_MOUNT = '/adamant-cache'
const CLI_TIMEOUT_MS = 30_000
/** A cold pull is tens of megabytes; a slow or private registry takes longer. */
const PULL_TIMEOUT_MS = 10 * 60_000
const FORBIDDEN_SECRET_KEYS = [
  'TOKEN',
  'SECRET',
  'KEY',
  'AUTH',
  'PASS',
  'PASSWORD',
  'CREDENTIAL',
  'COOKIE',
]

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

export class DockerSandbox {
  private defaultImage: string
  private defaultTimeoutMs: number
  private spawnFn: SpawnFunction

  constructor(options?: {
    defaultImage?: string
    defaultTimeoutMs?: number
    spawnFn?: SpawnFunction
  }) {
    this.defaultImage = options?.defaultImage ?? 'node:22-bookworm-slim'
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 60000
    this.spawnFn = options?.spawnFn ?? ((cmd, args) => spawn(cmd, args))
  }

  /**
   * Force-removes every container this class started for `runId`. The daemon
   * outlives the worker: a worker killed mid-test leaves its container
   * running with no timeout left to stop it, and a `docker rm -f` on the
   * timeout path can fail unnoticed. Called before a run's first container
   * and when the run is disposed. Never throws; the daemon may be gone.
   */
  async removeRunContainers(runId: string): Promise<void> {
    const listed = await this.docker(['ps', '-aq', '--filter', `label=${RUN_LABEL}=${runId}`])
    const ids = listed.stdout.split(/\s+/).filter((id) => id.length > 0)
    if (ids.length === 0) return
    await this.docker(['rm', '-f', ...ids])
  }

  /**
   * Pulls `image` ahead of the first run, so that run does not wait on the
   * registry. Resolves to false, and never throws, when the daemon or the
   * registry is unreachable: the next `docker run` pulls on its own.
   */
  async pullImage(image: string): Promise<boolean> {
    const pulled = await this.docker(['pull', '--quiet', image], PULL_TIMEOUT_MS)
    return pulled.ok
  }

  /** A short docker CLI call. `ok` is false, with empty output, when it fails or hangs. */
  private docker(
    args: string[],
    timeoutMs = CLI_TIMEOUT_MS,
  ): Promise<{ ok: boolean; stdout: string }> {
    const failed = { ok: false, stdout: '' }
    return new Promise((resolve) => {
      let proc: ChildProcess
      try {
        proc = this.spawnFn('docker', args)
      } catch {
        return resolve(failed)
      }
      let stdout = ''
      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        resolve(failed)
      }, timeoutMs)
      proc.stdout?.setEncoding('utf8')
      proc.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      proc.on('error', () => {
        clearTimeout(timer)
        resolve(failed)
      })
      proc.on('close', (code: number | null) => {
        clearTimeout(timer)
        resolve(code === 0 ? { ok: true, stdout } : failed)
      })
    })
  }

  async run(options: SandboxExecutionOptions): Promise<SandboxResult> {
    const startTime = Date.now()

    if (!options.workspacePath || !path.isAbsolute(options.workspacePath)) {
      return {
        success: false,
        exitCode: null,
        stdout: '',
        stderr: `Invalid workspacePath: "${options.workspacePath}". Path must be absolute to prevent named-volume creation.`,
        timedOut: false,
        durationMs: Date.now() - startTime,
        reason: 'INVALID_WORKSPACE',
      }
    }

    if (!fs.existsSync(options.workspacePath)) {
      return {
        success: false,
        exitCode: null,
        stdout: '',
        stderr: `Workspace path does not exist: "${options.workspacePath}".`,
        timedOut: false,
        durationMs: Date.now() - startTime,
        reason: 'INVALID_WORKSPACE',
      }
    }

    try {
      const stats = fs.statSync(options.workspacePath)
      if (!stats.isDirectory()) {
        return {
          success: false,
          exitCode: null,
          stdout: '',
          stderr: `Workspace path is not a directory: "${options.workspacePath}".`,
          timedOut: false,
          durationMs: Date.now() - startTime,
          reason: 'INVALID_WORKSPACE',
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        exitCode: null,
        stdout: '',
        stderr: `Failed to inspect workspace path: ${errMsg}`,
        timedOut: false,
        durationMs: Date.now() - startTime,
        reason: 'INVALID_WORKSPACE',
      }
    }

    if (options.cacheDir !== undefined && !path.isAbsolute(options.cacheDir)) {
      return {
        success: false,
        exitCode: null,
        stdout: '',
        stderr: `Invalid cacheDir: "${options.cacheDir}". Path must be absolute to prevent named-volume creation.`,
        timedOut: false,
        durationMs: Date.now() - startTime,
        reason: 'INVALID_WORKSPACE',
      }
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    const image = options.image ?? this.defaultImage
    const memoryLimit = options.memoryLimit ?? '1g'
    const cpuLimit = options.cpuLimit ?? '1.0'
    const pidsLimit = options.pidsLimit ?? '100'
    const network = options.network ?? 'none'
    const runId = options.runId ?? 'run'
    const user = options.user ?? 'node'
    const containerName = `adamant-sb-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

    const resolvedPath = path.resolve(options.workspacePath)

    let targetWorkdir = '/workspace'
    if (options.workdir && options.workdir.trim()) {
      const rel = options.workdir.trim().replace(/\\/g, '/').replace(/^\/+/, '')
      const posixTarget = path.posix.normalize(path.posix.join('/workspace', rel))
      if (posixTarget === '/workspace' || posixTarget.startsWith('/workspace/')) {
        targetWorkdir = posixTarget
      }
    }

    const dockerArgs: string[] = [
      'run',
      '--rm',
      '--name',
      containerName,
      '--label',
      `${RUN_LABEL}=${runId}`,
      '--network',
      network,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(pidsLimit),
      '--user',
      user,
      '--memory',
      memoryLimit,
      '--cpus',
      cpuLimit,
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--mount',
      `type=bind,src=${resolvedPath},dst=/workspace`,
      '-w',
      targetWorkdir,
    ]

    // The worktree must stay writable (installs and tests write to it), but
    // the repository under it must not: the host runs `git commit` and `git
    // push` against this `.git` after the container exits, so a test or a
    // postinstall script that rewrote `.git/config` (remote URL, http.proxy,
    // hooksPath) or the index would steer the host's push, and the
    // installation token, wherever it liked. Docker applies nested mounts
    // innermost last, so this bind shadows `.git` inside the workspace mount.
    if (isDirectory(path.join(resolvedPath, '.git'))) {
      dockerArgs.push(
        '--mount',
        `type=bind,src=${path.join(resolvedPath, '.git')},dst=/workspace/.git,readonly`,
      )
    }

    // The package cache for this repository, so a warm install reads tarballs
    // from disk instead of the registry. The provider builds the path from the
    // repository id; nothing from another repository is ever mounted here.
    if (options.cacheDir !== undefined) {
      dockerArgs.push(
        '--mount',
        `type=bind,src=${path.resolve(options.cacheDir)},dst=${CACHE_MOUNT}`,
      )
    }

    let envFilePath: string | null = null
    if (options.env && Object.keys(options.env).length > 0) {
      const safeLines: string[] = []
      for (const [key, val] of Object.entries(options.env)) {
        const isSecret = FORBIDDEN_SECRET_KEYS.some((f) => key.toUpperCase().includes(f))
        if (!isSecret) {
          const sanitizedVal = val.replace(/[\r\n]+/g, ' ')
          safeLines.push(`${key}=${sanitizedVal}`)
        }
      }
      if (safeLines.length > 0) {
        envFilePath = path.join(
          os.tmpdir(),
          `sb-env-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.env`,
        )
        fs.writeFileSync(envFilePath, safeLines.join('\n'), { mode: 0o600 })
        dockerArgs.push('--env-file', envFilePath)
      }
    }

    dockerArgs.push(image, 'sh', '-c', options.command)

    return new Promise<SandboxResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false

      const cleanupEnv = () => {
        if (envFilePath && fs.existsSync(envFilePath)) {
          try {
            fs.unlinkSync(envFilePath)
          } catch {
            /* ignore cleanup failure */
          }
        }
      }

      let proc: ChildProcess
      try {
        proc = this.spawnFn('docker', dockerArgs)
      } catch (err: unknown) {
        cleanupEnv()
        const errMsg = err instanceof Error ? err.message : String(err)
        return resolve({
          success: false,
          exitCode: null,
          stdout: '',
          stderr: `Failed to spawn docker process: ${errMsg}`,
          timedOut: false,
          durationMs: Date.now() - startTime,
          reason: 'INFRA_FAILURE',
          error: errMsg,
        })
      }

      proc.stdout?.setEncoding('utf8')
      proc.stderr?.setEncoding('utf8')

      const timer = setTimeout(() => {
        timedOut = true
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore kill failure if process already stopped */
        }
        const rm = this.spawnFn('docker', ['rm', '-f', containerName])
        const onCleanup = () => {
          cleanupEnv()
          resolve({
            success: false,
            exitCode: null,
            stdout,
            stderr: stderr + '\n[sandbox] Container execution timed out and was killed.',
            timedOut: true,
            durationMs: Date.now() - startTime,
            reason: 'TIMEOUT',
          })
        }
        rm.on('close', onCleanup)
        rm.on('error', onCleanup)
      }, timeoutMs)

      proc.stdout?.on('data', (chunk: string) => {
        stdout += chunk
        if (stdout.length > MAX_BUFFER_BYTES) {
          stdout = stdout.slice(-MAX_BUFFER_BYTES)
        }
      })

      proc.stderr?.on('data', (chunk: string) => {
        stderr += chunk
        if (stderr.length > MAX_BUFFER_BYTES) {
          stderr = stderr.slice(-MAX_BUFFER_BYTES)
        }
      })

      proc.on('error', (err: Error) => {
        clearTimeout(timer)
        cleanupEnv()
        resolve({
          success: false,
          exitCode: null,
          stdout,
          stderr: stderr + `\n[sandbox infra failure] ${err.message}`,
          timedOut: false,
          durationMs: Date.now() - startTime,
          reason: 'INFRA_FAILURE',
          error: err.message,
        })
      })

      proc.on('close', (code: number | null) => {
        if (timedOut) return
        clearTimeout(timer)
        cleanupEnv()
        resolve({
          success: code === 0,
          exitCode: code,
          stdout,
          stderr,
          timedOut: false,
          durationMs: Date.now() - startTime,
          reason: 'COMPLETED',
        })
      })
    })
  }
}
