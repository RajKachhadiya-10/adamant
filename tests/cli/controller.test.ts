import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AdamantApi } from '../../cli/src/api.ts'
import { loadCliConfig } from '../../cli/src/config.ts'
import { CommandController, formatActivity } from '../../cli/src/controller.ts'
import { browserOpenCommand } from '../../cli/src/open.ts'

const run = {
  id: '6611607f-117c-486e-9432-1bec481efacb',
  repositoryId: 'repo-1',
  sourceSha: 'e1745e2b5a13aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  targetBranch: 'adamant/6611607f-117c-486e-9432-1bec481efacb',
  status: 'failed',
  version: 3,
  createdAt: '2026-10-14T09:46:10.000Z',
  updatedAt: '2026-10-14T09:46:23.000Z',
}

/** Answers each path from `routes`; anything else is a 404. */
function controllerFor(routes: Record<string, () => Response>) {
  const api = new AdamantApi(
    loadCliConfig({ ADAMANT_API_URL: 'https://adamant.example', ADAMANT_SESSION: 's' }),
    async (input) => {
      const route = routes[new URL(String(input)).pathname]
      return route ? route() : Response.json({ error: 'Not found' }, { status: 404 })
    },
  )
  return new CommandController(api)
}

const texts = async (controller: CommandController, input: string) => {
  const result = await controller.execute(input)
  assert.equal(result.kind, 'output')
  return result.kind === 'output' ? result.lines : []
}

describe('Adamant CLI commands against the API', () => {
  it('reports a refused session from /status, which /health alone cannot see', async () => {
    const controller = controllerFor({
      '/health': () => Response.json({ status: 'ok' }),
      '/runs': () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const lines = await texts(controller, '/status')

    assert.match(lines[0]?.text ?? '', /Adamant API at https:\/\/adamant\.example is healthy/)
    assert.equal(lines[1]?.tone, 'error')
    assert.match(lines[1]?.text ?? '', /rejected ADAMANT_SESSION/)
  })

  it('confirms a working session', async () => {
    const controller = controllerFor({
      '/health': () => Response.json({ status: 'ok' }),
      '/runs': () => Response.json({ runs: [] }),
    })

    const lines = await texts(controller, '/status')

    assert.deepEqual(
      lines.map((line) => line.tone),
      ['success', 'success'],
    )
    assert.equal(lines[1]?.text, 'Session accepted.')
  })

  it('marks each /runs row with its run so it can be opened', async () => {
    const controller = controllerFor({ '/runs': () => Response.json({ runs: [run] }) })

    const lines = await texts(controller, '/runs')

    assert.match(lines[0]?.text ?? '', /^STATUS\s+SHA\s+CREATED\s+RUN ID$/)
    assert.equal(lines[1]?.runId, run.id)
    // The branch is always adamant/<id>; repeating the id made every row wrap.
    assert.equal(lines[1]?.text.split(run.id).length, 2)
    assert.match(lines[1]?.text ?? '', /^failed\s+e1745e2b5a13\s/)
  })

  it('shows why a run failed in its trail', async () => {
    const controller = controllerFor({
      [`/runs/${run.id}`]: () =>
        Response.json({
          run,
          auditEvents: [
            {
              id: 'e1',
              runId: run.id,
              eventType: 'run.failed',
              payload: { reason: 'OPENAI_API_KEY is required in the worker' },
              actorUserId: null,
              createdAt: '2026-10-14T09:46:23.000Z',
            },
          ],
        }),
    })

    const lines = await texts(controller, `/run ${run.id}`)
    const failed = lines.find((line) => line.text.includes('run.failed'))

    assert.equal(failed?.tone, 'error')
    assert.match(failed?.text ?? '', /run\.failed {2}OPENAI_API_KEY is required in the worker$/)
  })
})

describe('/install', () => {
  const installUrl = 'https://github.com/apps/adamant/installations/new'

  function installController(options: {
    install?: () => Response
    status?: () => Response
    openUrl?: (url: string) => Promise<boolean>
    pollIntervalMs?: number
  }) {
    const api = new AdamantApi(
      loadCliConfig({ ADAMANT_API_URL: 'https://adamant.example', ADAMANT_SESSION: 's' }),
      async (input) => {
        const url = new URL(String(input))
        if (url.pathname === '/github/install') {
          return options.install?.() ?? Response.json({ url: installUrl })
        }
        if (url.pathname === '/github/installations/status') {
          return options.status?.() ?? Response.json({ error: 'missing' }, { status: 404 })
        }
        return Response.json({ error: 'unexpected' }, { status: 500 })
      },
    )
    return new CommandController(api, {
      pollIntervalMs: options.pollIntervalMs ?? 0,
      openUrl: options.openUrl ?? (async () => true),
    })
  }

  it('prints the URL, asks for that repository, and reports the default branch', async () => {
    const opened: string[] = []
    let polls = 0
    const controller = installController({
      openUrl: async (url) => {
        opened.push(url)
        return true
      },
      status: () => {
        polls += 1
        return polls < 2
          ? Response.json({ error: 'not yet' }, { status: 404 })
          : Response.json({ owner: 'acme', name: 'eval', defaultBranch: 'main' })
      },
    })

    const lines = await texts(controller, '/install acme/eval')
    const text = lines.map((entry) => entry.text).join('\n')

    assert.deepEqual(opened, [installUrl])
    assert.equal(polls, 2)
    assert.match(text, new RegExp(installUrl.replaceAll('.', '\\.')))
    assert.match(
      text,
      /Install the App on acme\/eval, or add acme\/eval to an existing installation/,
    )
    assert.match(text, /Waiting for GitHub to confirm acme\/eval/)
    assert.match(text, /Adamant is installed on acme\/eval/)
    assert.match(text, /Default branch: main/)
    assert.match(text, /A failed workflow on main starts a heal/)
  })

  it('keeps going when the browser cannot be opened', async () => {
    const controller = installController({
      openUrl: async () => {
        throw new Error('no display')
      },
      status: () => Response.json({ owner: 'acme', name: 'eval', defaultBranch: 'develop' }),
    })

    const lines = await texts(controller, '/install acme/eval')
    const text = lines.map((entry) => entry.text).join('\n')

    assert.match(text, /Could not open a browser/)
    assert.match(text, /Default branch: develop/)
  })

  it('stops polling when the user aborts', async () => {
    const abort = new AbortController()
    let polls = 0
    const controller = installController({
      pollIntervalMs: 1_000,
      openUrl: async () => {
        abort.abort()
        return true
      },
      status: () => {
        polls += 1
        return Response.json({ error: 'not yet' }, { status: 404 })
      },
    })

    const result = await controller.execute('/install acme/eval', abort.signal)
    assert.equal(result.kind, 'output')
    const lines = result.kind === 'output' ? result.lines : []
    assert.equal(polls, 0)
    assert.match(lines.map((entry) => entry.text).join('\n'), /Stopped waiting for acme\/eval/)
  })

  it('says the App slug is not configured instead of opening a browser', async () => {
    let opened = false
    const controller = installController({
      install: () =>
        Response.json({ error: 'The GitHub App slug is not configured.' }, { status: 503 }),
      openUrl: async () => {
        opened = true
        return true
      },
    })

    await assert.rejects(controller.execute('/install acme/eval'), /App slug is not configured/)
    assert.equal(opened, false)
  })

  it('does not open a browser for a name that is not owner/repo', async () => {
    let opened = false
    const controller = installController({
      openUrl: async () => {
        opened = true
        return true
      },
    })

    await assert.rejects(controller.execute('/install nope'), /GitHub names/)
    assert.equal(opened, false)
  })
})

describe('login and repositories', () => {
  const sessionToken = 'adamant-session-token'

  function loginApi(options: { session?: string; poll?: () => Response; repos?: () => Response }) {
    const calls: { path: string; authorization: string | null }[] = []
    const api = new AdamantApi(
      loadCliConfig({
        ADAMANT_API_URL: 'https://adamant.example',
        ...(options.session ? { ADAMANT_SESSION: options.session } : {}),
      }),
      async (input, init) => {
        const url = new URL(String(input))
        calls.push({
          path: url.pathname,
          authorization: new Headers(init?.headers).get('Authorization'),
        })
        if (url.pathname === '/auth/github/cli/start') {
          return Response.json({
            loginId: 'login-id',
            pollSecret: 'poll-secret-value',
            beginPath: '/auth/github/cli/begin?login=login-id',
          })
        }
        if (url.pathname === '/auth/github/cli/token') {
          return options.poll?.() ?? Response.json({ token: sessionToken })
        }
        if (url.pathname === '/github/repositories') {
          return options.repos?.() ?? Response.json({ repositories: [] })
        }
        if (url.pathname === '/health') return Response.json({ status: 'ok' })
        return Response.json({ error: 'unexpected' }, { status: 500 })
      },
    )
    return { api, calls }
  }

  it('does not start GitHub login when a session was already provided', async () => {
    const opened: string[] = []
    const { api, calls } = loginApi({ session: 'already' })
    const controller = new CommandController(api, {
      openUrl: async (url) => {
        opened.push(url)
        return true
      },
    })

    const lines = await texts(controller, '/login')

    assert.equal(lines[0]?.text, 'Signed in.')
    assert.deepEqual(opened, [])
    assert.deepEqual(calls, [])
  })

  it('opens GitHub OAuth and keeps only the Adamant session', async () => {
    const opened: string[] = []
    let polls = 0
    const { api, calls } = loginApi({
      poll: () => {
        polls += 1
        return polls < 2
          ? Response.json({ status: 'pending' }, { status: 202 })
          : Response.json({ token: sessionToken })
      },
    })
    const controller = new CommandController(api, {
      pollIntervalMs: 0,
      openUrl: async (url) => {
        opened.push(url)
        return true
      },
    })

    const lines = await texts(controller, '/login')
    const text = lines.map((entry) => entry.text).join('\n')

    assert.deepEqual(opened, ['https://adamant.example/auth/github/cli/begin?login=login-id'])
    assert.match(text, /Waiting for GitHub/)
    assert.match(text, /Signed in\./)
    assert.doesNotMatch(text, /poll-secret-value/)
    assert.doesNotMatch(text, new RegExp(sessionToken))
    assert.equal(calls[0]?.authorization, null)
    assert.equal(controller.signedIn, true)

    await texts(controller, '/repos')
    assert.equal(calls.at(-1)?.authorization, `Bearer ${sessionToken}`)
    assert.equal(calls.at(-1)?.path, '/github/repositories')
  })

  it('stops waiting to sign in when the user aborts', async () => {
    const abort = new AbortController()
    const { api } = loginApi({
      poll: () => Response.json({ status: 'pending' }, { status: 202 }),
    })
    const controller = new CommandController(api, {
      pollIntervalMs: 1_000,
      openUrl: async () => {
        abort.abort()
        return true
      },
    })

    const result = await controller.execute('/login', abort.signal)
    assert.equal(result.kind, 'output')
    const text = result.kind === 'output' ? result.lines.map((entry) => entry.text).join('\n') : ''
    assert.match(text, /Stopped waiting to sign in/)
    assert.equal(controller.signedIn, false)
  })

  it('does not open a browser when GitHub OAuth is not configured', async () => {
    let opened = false
    const api = new AdamantApi(
      loadCliConfig({ ADAMANT_API_URL: 'https://adamant.example' }),
      async () => Response.json({ error: 'OAuth authentication is unavailable' }, { status: 503 }),
    )
    const controller = new CommandController(api, {
      openUrl: async () => {
        opened = true
        return true
      },
    })

    await assert.rejects(controller.execute('/login'), /OAuth authentication is unavailable/)
    assert.equal(opened, false)
  })

  it('says when no repository is connected and lists ones the API already knows', async () => {
    const { api } = loginApi({ session: 's' })
    const empty = new CommandController(api)
    const none = await texts(empty, '/repos')
    assert.match(none.map((entry) => entry.text).join('\n'), /Choose Connect/)

    const { api: listed } = loginApi({
      session: 's',
      repos: () =>
        Response.json({
          repositories: [{ id: 'repo-1', owner: 'acme', name: 'eval', defaultBranch: 'main' }],
        }),
    })
    const lines = await texts(new CommandController(listed), '/repos')
    const text = lines.map((entry) => entry.text).join('\n')
    assert.match(text, /acme\/eval/)
    assert.match(text, /main/)
    assert.doesNotMatch(text, /installation|token/i)
  })

  it('reports a signed-out status without calling /runs', async () => {
    const { api, calls } = loginApi({})
    const lines = await texts(new CommandController(api), '/status')
    assert.match(lines[0]?.text ?? '', /healthy/)
    assert.match(lines[1]?.text ?? '', /Not signed in/)
    assert.equal(
      calls.some((call) => call.path === '/runs'),
      false,
    )
  })
})

describe('browser opener', () => {
  const url = 'https://github.com/apps/adamant/installations/new'

  it('picks a platform opener without a shell', () => {
    assert.deepEqual(browserOpenCommand('darwin', url), { command: 'open', args: [url] })
    assert.deepEqual(browserOpenCommand('linux', url), { command: 'xdg-open', args: [url] })
    assert.deepEqual(browserOpenCommand('win32', url), {
      command: 'cmd',
      args: ['/c', 'start', '', url],
    })
  })
})

describe('Activity rows', () => {
  it('show whether a delivery started anything', () => {
    const row = formatActivity({
      id: 'wh_1',
      type: 'webhook:pull_request',
      payload: { processingStatus: 'ignored', receivedAt: '2026-10-14T09:46:10.000Z' },
      receivedAt: '2026-10-14T09:46:10.000Z',
    })

    assert.match(row, /^\d\d:\d\d:\d\d {2}webhook:pull_request {2}ignored$/)
  })

  it('show the run and the detail that matters for an audit event', () => {
    const row = formatActivity({
      id: 'audit_1',
      type: 'audit:run.merge_failed',
      payload: {
        runId: run.id,
        createdAt: '2026-10-14T09:46:10.000Z',
        payload: { prNumber: 7, error: 'Base branch was modified' },
      },
      receivedAt: '2026-10-14T09:46:10.000Z',
    })

    assert.match(
      row,
      new RegExp(`audit:run\\.merge_failed {2}${run.id} {2}Base branch was modified$`),
    )
  })
})
