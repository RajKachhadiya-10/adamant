import { describe, it } from 'node:test'
import * as assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createDetectingSandbox,
  detectSandboxSettings,
  type SandboxSettings,
} from '../../server/worker/sandbox-profile.ts'

const node: SandboxSettings = {
  image: 'node:22-bookworm-slim',
  installCommand: 'npm ci --no-audit --no-fund',
  testCommand: 'npm test',
}

async function checkout(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adamant-profile-'))
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await fs.writeFile(path.join(dir, name), text)
  }
  return dir
}

const PYPROJECT_DEV = `[project]
name = "discount"
version = "0.1.0"

[project.optional-dependencies]
dev = ["pytest>=8"]

[tool.pytest.ini_options]
testpaths = ["tests"]
`

const CI = `jobs:
  test:
    steps:
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
`

describe('sandbox profile', () => {
  it('keeps the configured commands for a Node project', async () => {
    const dir = await checkout({ 'package.json': '{}', 'pyproject.toml': PYPROJECT_DEV })
    assert.deepStrictEqual(await detectSandboxSettings(dir, node, {}), node)
  })

  it('runs a pyproject package with its dev extra and pytest on the CI python', async () => {
    const dir = await checkout({ 'pyproject.toml': PYPROJECT_DEV, '.github/workflows/ci.yml': CI })
    assert.deepStrictEqual(await detectSandboxSettings(dir, node, {}), {
      image: 'python:3.11-slim',
      installCommand:
        'python -m venv --clear .adamant-venv && .adamant-venv/bin/pip install --quiet --disable-pip-version-check --no-cache-dir -e ".[dev]" pytest',
      testCommand: '.adamant-venv/bin/python -m pytest -q',
      user: '1000:1000',
    })
  })

  it('installs without an extra the project does not declare, on the default python', async () => {
    const dir = await checkout({ 'pyproject.toml': '[project]\nname = "x"\n' })
    const settings = await detectSandboxSettings(dir, node, {})
    assert.strictEqual(settings.image, 'python:3.12-slim')
    assert.match(settings.installCommand, / -e \. pytest$/)
  })

  it('installs requirements files when there is no package metadata', async () => {
    const dir = await checkout({
      'requirements.txt': 'requests\n',
      'requirements-dev.txt': 'pytest\n',
    })
    assert.match(
      (await detectSandboxSettings(dir, node, {})).installCommand,
      /-r requirements\.txt -r requirements-dev\.txt pytest$/,
    )
  })

  it('ignores a python-version it cannot use as an image tag', async () => {
    const dir = await checkout({
      'setup.py': '',
      '.github/workflows/ci.yml': 'python-version: ${{ matrix.python }}\n',
    })
    assert.strictEqual((await detectSandboxSettings(dir, node, {})).image, 'python:3.12-slim')
  })

  it('keeps the configured commands for anything else, or when told to', async () => {
    assert.deepStrictEqual(
      await detectSandboxSettings(await checkout({ 'go.mod': '' }), node, {}),
      node,
    )
    const python = await checkout({ 'pyproject.toml': PYPROJECT_DEV })
    assert.deepStrictEqual(
      await detectSandboxSettings(python, node, { ADAMANT_SANDBOX_PROFILE: 'fixed' }),
      node,
    )
  })

  it('looks in the configured workdir and keeps it', async () => {
    const dir = await checkout({ 'service/pyproject.toml': PYPROJECT_DEV })
    const settings = await detectSandboxSettings(dir, { ...node, workdir: 'service' }, {})
    assert.strictEqual(settings.workdir, 'service')
    assert.match(settings.installCommand, /-e "\.\[dev\]"/)
  })

  it('decides once, at the first validation, and disposes only what it built', async () => {
    const dir = await checkout({})
    const built: SandboxSettings[] = []
    let disposed = 0
    const sandbox = createDetectingSandbox(
      dir,
      node,
      (settings) => {
        built.push(settings)
        return {
          runValidation: async () => ({
            verdict: 'pass',
            commands: [settings.testCommand],
            output: '',
          }),
          dispose: async () => {
            disposed += 1
          },
        }
      },
      {},
    )
    await sandbox.dispose()
    assert.strictEqual(disposed, 0)
    // The candidate lands before the first validation; that is what is read.
    await fs.writeFile(path.join(dir, 'pyproject.toml'), PYPROJECT_DEV)
    const first = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'a' })
    await sandbox.runValidation({ attemptNumber: 2, candidateHash: 'b' })
    assert.deepStrictEqual(first.commands, ['.adamant-venv/bin/python -m pytest -q'])
    assert.strictEqual(built.length, 1)
    await sandbox.dispose()
    assert.strictEqual(disposed, 1)
  })
})
