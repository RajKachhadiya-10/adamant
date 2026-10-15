import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { type SandboxOutcome } from '../agent/deps.ts'
import { type DockerSandboxProvider } from './sandbox-provider.ts'

export interface SandboxSettings {
  readonly image: string
  readonly installCommand: string
  readonly testCommand: string
  readonly workdir?: string
  /** Absent: the sandbox's default, the Node image's `node` user. */
  readonly user?: string
}

/**
 * The sandbox commands for this checkout. ADAMANT_SANDBOX_* describe a Node project,
 * and running `npm test` against a Python repository fails every candidate however
 * right the fix is. So the checkout decides: a repository with a package.json keeps
 * the configured commands, one with Python packaging gets a Python profile, and
 * anything else keeps the configured commands too. ADAMANT_SANDBOX_PROFILE=fixed
 * turns detection off.
 */
export async function detectSandboxSettings(
  workspacePath: string,
  configured: SandboxSettings,
  env = process.env,
): Promise<SandboxSettings> {
  if (env.ADAMANT_SANDBOX_PROFILE === 'fixed') return configured
  const root = configured.workdir ? path.join(workspacePath, configured.workdir) : workspacePath
  const has = (name: string) =>
    fs.access(path.join(root, name)).then(
      () => true,
      () => false,
    )
  if (await has('package.json')) return configured

  const [pyproject, setupPy, requirements, devRequirements] = await Promise.all([
    has('pyproject.toml'),
    has('setup.py'),
    has('requirements.txt'),
    has('requirements-dev.txt'),
  ])
  if (!pyproject && !setupPy && !requirements) return configured

  const extras = pyproject && (await hasDevExtra(path.join(root, 'pyproject.toml')))
  const packages = [
    ...(pyproject || setupPy ? [extras ? '-e ".[dev]"' : '-e .'] : []),
    ...(requirements ? ['-r requirements.txt'] : []),
    ...(devRequirements ? ['-r requirements-dev.txt'] : []),
    // Most projects test with it; a project that already lists it loses nothing.
    'pytest',
  ]
  return {
    image: `python:${await pythonVersion(workspacePath)}-slim`,
    // Install and tests run in separate containers, and only the worktree is shared,
    // so the environment lives in it. The commit holds only the staged candidate.
    installCommand: `python -m venv --clear ${VENV} && ${VENV}/bin/pip install --quiet --disable-pip-version-check --no-cache-dir ${packages.join(' ')}`,
    testCommand: `${VENV}/bin/python -m pytest -q`,
    // The python images have no `node` user. 1000 is the uid that user has, and with
    // no home directory pip is told not to cache.
    user: PYTHON_USER,
    ...(configured.workdir ? { workdir: configured.workdir } : {}),
  }
}

const VENV = '.adamant-venv'
/**
 * What the sandbox keeps in the worktree between candidates. The run's git excludes
 * it (GitWorkspace.init): `clean -fd` between candidates otherwise deletes only the
 * parts a repository's .gitignore does not cover (Python's template ignores `lib/`),
 * leaving a venv with no `bin/python` that the install reuse still trusts.
 */
export const SANDBOX_OWNED_PATHS = [`/${VENV}/`]
const PYTHON_USER = '1000:1000'
const DEFAULT_PYTHON = '3.12'

async function hasDevExtra(pyprojectPath: string): Promise<boolean> {
  const text = await fs.readFile(pyprojectPath, 'utf8').catch(() => '')
  const section = text.split(/^\[project\.optional-dependencies\]\s*$/m)[1]?.split(/^\[/m)[0]
  return section ? /^\s*dev\s*=/m.test(section) : false
}

/** The version CI sets up, so the sandbox tests on what CI tests on. */
async function pythonVersion(workspacePath: string): Promise<string> {
  const dir = path.join(workspacePath, '.github', 'workflows')
  const names = await fs.readdir(dir).catch(() => [] as string[])
  for (const name of names.filter((file) => /\.ya?ml$/.test(file)).sort()) {
    const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')
    const version = text.match(/python-version:\s*["']?(3\.\d{1,2})["']?\s*$/m)?.[1]
    if (version) return version
  }
  return DEFAULT_PYTHON
}

/**
 * Decides the profile at the first validation, when the candidate is in the worktree,
 * then hands every call to the sandbox built for it.
 */
export function createDetectingSandbox(
  workspacePath: string,
  configured: SandboxSettings,
  create: (settings: SandboxSettings) => DockerSandboxProvider,
  env = process.env,
): DockerSandboxProvider {
  let inner: Promise<DockerSandboxProvider> | null = null
  const sandbox = () =>
    (inner ??= detectSandboxSettings(workspacePath, configured, env).then(create))
  return {
    async runValidation(input): Promise<SandboxOutcome> {
      return (await sandbox()).runValidation(input)
    },
    async dispose() {
      if (inner) await (await inner).dispose()
    },
  }
}
