import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { INSTALL_CONFIRMATION_NEEDS_DATABASE } from '@adamant/contract'
import { createAuthMiddleware } from '../../server/api/middleware/auth.ts'
import {
  APP_SLUG_INVALID,
  APP_SLUG_UNCONFIGURED,
  createGithubInstallRoute,
  type FindInstalledRepository,
} from '../../server/api/routes/githubInstall.ts'
import { createServerApp } from '../../server/api/server.ts'

const session = 'secret'
const seedUserId = '00000000-0000-0000-0000-000000000001'

function routeFor(findRepository: FindInstalledRepository, readAppSlug: () => string | undefined) {
  return createGithubInstallRoute(
    { findRepository, readAppSlug },
    createAuthMiddleware({ legacySession: { token: session, userId: seedUserId } }),
  )
}

const authed = { Authorization: `Bearer ${session}` }

describe('GitHub App install routes', () => {
  it('rejects a missing session', async () => {
    const app = routeFor(
      async () => null,
      () => 'adamant',
    )
    assert.equal((await app.request('/install')).status, 401)
    assert.equal((await app.request('/installations/status?owner=acme&name=eval')).status, 401)
  })

  it('returns 503 when the App slug is unset', async () => {
    const app = routeFor(
      async () => null,
      () => undefined,
    )
    const response = await app.request('/install', { headers: authed })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: APP_SLUG_UNCONFIGURED })

    const blank = routeFor(
      async () => null,
      () => '   ',
    )
    assert.equal((await blank.request('/install', { headers: authed })).status, 503)
  })

  it('rejects a slug that is not one path segment', async () => {
    for (const slug of [
      '../evil',
      'adamant/extra',
      'adamant?x',
      'Adamant',
      '-adamant',
      'a..b',
      '.',
    ]) {
      const app = routeFor(
        async () => null,
        () => slug,
      )
      const response = await app.request('/install', { headers: authed })
      assert.equal(response.status, 503, slug)
      assert.deepEqual(await response.json(), { error: APP_SLUG_INVALID })
    }
  })

  it('returns the public install URL for a valid slug', async () => {
    const app = routeFor(
      async () => null,
      () => 'adamant-app',
    )
    const response = await app.request('/install', { headers: authed })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      url: 'https://github.com/apps/adamant-app/installations/new',
    })
  })

  it('returns 404 until that exact repository is bound, then only owner, name, and branch', async () => {
    let calls = 0
    const app = routeFor(
      async (owner, name) => {
        calls += 1
        assert.equal(owner, 'acme')
        assert.equal(name, 'eval')
        return calls === 1 ? null : { owner, name, defaultBranch: 'develop' }
      },
      () => 'adamant',
    )

    const missing = await app.request('/installations/status?owner=acme&name=eval', {
      headers: authed,
    })
    assert.equal(missing.status, 404)
    assert.deepEqual(Object.keys((await missing.json()) as object), ['error'])

    const found = await app.request('/installations/status?owner=acme&name=eval', {
      headers: authed,
    })
    assert.equal(found.status, 200)
    assert.deepEqual(await found.json(), {
      owner: 'acme',
      name: 'eval',
      defaultBranch: 'develop',
    })
  })

  it('rejects wildcards, extra query keys, and repeated names without looking them up', async () => {
    let calls = 0
    const app = routeFor(
      async () => {
        calls += 1
        return null
      },
      () => 'adamant',
    )
    const paths = [
      '/installations/status?owner=*&name=eval',
      '/installations/status?owner=acme&name=eval%',
      '/installations/status?owner=acme&name=eval&name=other',
      '/installations/status?owner=acme&name=eval&github_installation_id=1',
      '/installations/status?owner=acme/../other&name=eval',
    ]
    for (const path of paths) {
      const response = await app.request(path, { headers: authed })
      assert.equal(response.status, 400, path)
    }
    assert.equal(calls, 0)
  })
})

describe('install routes without a database', () => {
  const previousDatabase = process.env.DATABASE_URL
  const previousSlug = process.env.GITHUB_APP_SLUG

  afterEach(() => {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDatabase
    if (previousSlug === undefined) delete process.env.GITHUB_APP_SLUG
    else process.env.GITHUB_APP_SLUG = previousSlug
    delete process.env.ADAMANT_SESSION_SECRET
    delete process.env.ADAMANT_SEED_USER_ID
  })

  it('says confirmation needs Postgres and ignores the in-memory repository map', async () => {
    delete process.env.DATABASE_URL
    process.env.GITHUB_APP_SLUG = 'adamant'
    process.env.ADAMANT_SESSION_SECRET = session
    process.env.ADAMANT_SEED_USER_ID = seedUserId
    const app = createServerApp()

    assert.equal((await app.request('/github/install')).status, 401)
    assert.equal(
      (await app.request('/github/installations/status?owner=acme&name=eval')).status,
      401,
    )

    const created = await app.request('/repositories', {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({
        installation_id: 'inst-1',
        github_repo_id: 1,
        owner: 'acme',
        name: 'eval',
      }),
    })
    assert.equal(created.status, 201)

    const install = await app.request('/github/install', { headers: authed })
    assert.equal(install.status, 503)
    assert.deepEqual(await install.json(), { error: INSTALL_CONFIRMATION_NEEDS_DATABASE })

    const status = await app.request('/github/installations/status?owner=acme&name=eval', {
      headers: authed,
    })
    assert.equal(status.status, 503)
    assert.deepEqual(await status.json(), { error: INSTALL_CONFIRMATION_NEEDS_DATABASE })
  })
})
