import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  createGitHubClient,
  readGitHubAppConfig,
  type FetchLike,
} from '../../server/worker/github.ts'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const config = { appId: '12345', privateKey, apiBaseUrl: 'https://api.github.test' }

type Recorded = { url: string; method: string; headers: Record<string, string>; body?: string }

function stubFetch(routes: Record<string, unknown>) {
  const calls: Recorded[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    calls.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    })

    // A route may be pinned to a method: `'PUT /pulls/7/merge'`.
    const key = Object.keys(routes).find((route) => {
      const [routeMethod, routePath] = route.includes(' ') ? route.split(' ') : [null, route]
      if (routeMethod && routeMethod !== method) return false
      return url.endsWith(String(routePath)) || url.includes(String(routePath))
    })
    const payload = key ? routes[key] : undefined

    if (payload === undefined) {
      return new Response('not found', { status: 404 })
    }
    if (typeof payload === 'string') {
      return new Response(payload, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  return { calls, fetchImpl }
}

describe('GitHub App client', () => {
  it('mints an installation token with a signed app JWT', async () => {
    const { calls, fetchImpl } = stubFetch({ '/access_tokens': { token: 'ghs_minted' } })
    const client = createGitHubClient(config, fetchImpl)

    const token = await client.installationToken('99')

    assert.equal(token, 'ghs_minted')
    assert.equal(calls[0]?.url, 'https://api.github.test/app/installations/99/access_tokens')
    assert.equal(calls[0]?.method, 'POST')

    const jwt = String(calls[0]?.headers.authorization).replace('Bearer ', '')
    const [header, payload] = jwt.split('.')
    assert.deepEqual(JSON.parse(Buffer.from(String(header), 'base64url').toString()), {
      alg: 'RS256',
      typ: 'JWT',
    })
    assert.equal(JSON.parse(Buffer.from(String(payload), 'base64url').toString()).iss, '12345')
  })

  it('mints a token for each call and never reuses a stored one', async () => {
    const { calls, fetchImpl } = stubFetch({
      '/access_tokens': { token: 'ghs_minted' },
      '/pulls': { number: 5, html_url: 'https://github.com/acme/eval/pull/5' },
    })
    const client = createGitHubClient(config, fetchImpl)

    await client.createPullRequest({
      installationId: '99',
      owner: 'acme',
      name: 'eval',
      head: 'adamant/run-1',
      base: 'main',
      title: 'fix',
      body: 'body',
    })
    await client.createPullRequest({
      installationId: '99',
      owner: 'acme',
      name: 'eval',
      head: 'adamant/run-1',
      base: 'main',
      title: 'fix',
      body: 'body',
    })

    assert.equal(calls.filter((call) => call.url.endsWith('/access_tokens')).length, 2)
  })

  it('downloads the failed jobs only', async () => {
    const { calls, fetchImpl } = stubFetch({
      '/access_tokens': { token: 'ghs_minted' },
      '/actions/runs?head_sha': {
        workflow_runs: [
          { id: 1, conclusion: 'failure' },
          { id: 2, conclusion: 'success' },
        ],
      },
      '/actions/runs/1/jobs': {
        jobs: [
          { id: 10, name: 'build', conclusion: 'success' },
          { id: 11, name: 'test', conclusion: 'failure' },
        ],
      },
      '/actions/jobs/11/logs': 'not ok 1 - sum\nAssertionError: boom',
    })
    const client = createGitHubClient(config, fetchImpl)

    const logs = await client.failedJobLogs({
      installationId: '99',
      owner: 'acme',
      name: 'eval',
      headSha: 'deadbeef',
    })

    assert.match(logs, /=== job: test ===/)
    assert.match(logs, /AssertionError: boom/)
    assert.equal(
      calls.some((call) => call.url.includes('/actions/jobs/10/logs')),
      false,
      'a job that passed is never downloaded',
    )
    assert.equal(
      calls.some((call) => call.url.includes('/actions/runs/2/jobs')),
      false,
      'a workflow run that passed is never inspected',
    )
  })

  it('returns an empty log when nothing failed for that sha', async () => {
    const { fetchImpl } = stubFetch({
      '/access_tokens': { token: 'ghs_minted' },
      '/actions/runs?head_sha': { workflow_runs: [{ id: 2, conclusion: 'success' }] },
    })
    const client = createGitHubClient(config, fetchImpl)

    const logs = await client.failedJobLogs({
      installationId: '99',
      owner: 'acme',
      name: 'eval',
      headSha: 'deadbeef',
    })

    assert.equal(logs, '')
  })

  const ourPr = (overrides: Record<string, unknown> = {}) => ({
    state: 'open',
    merged: false,
    head: { ref: 'adamant/run-1', repo: { full_name: 'acme/eval' } },
    ...overrides,
  })

  const merge = (client: ReturnType<typeof createGitHubClient>) =>
    client.mergePullRequest({
      installationId: '99',
      owner: 'acme',
      name: 'eval',
      prNumber: 7,
      headRef: 'adamant/run-1',
      commitTitle: 'Adamant run run-1 (#7)',
    })

  it('squash merges the pull request it is given once its head checks out', async () => {
    const { calls, fetchImpl } = stubFetch({
      '/access_tokens': { token: 'ghs_minted' },
      'PUT /pulls/7/merge': { merged: true },
      'GET /pulls/7': ourPr(),
    })
    const client = createGitHubClient(config, fetchImpl)

    await merge(client)

    const last = calls.at(-1)
    assert.equal(last?.method, 'PUT')
    assert.equal(last?.url, 'https://api.github.test/repos/acme/eval/pulls/7/merge')
    assert.equal(JSON.parse(String(last?.body)).merge_method, 'squash')
    assert.equal(calls.at(-2)?.url, 'https://api.github.test/repos/acme/eval/pulls/7')
  })

  it('refuses to merge a pull request whose head is not this run on this repo', async () => {
    const heads = [
      ourPr({ head: { ref: 'feature/x', repo: { full_name: 'acme/eval' } } }),
      ourPr({ head: { ref: 'adamant/run-1', repo: { full_name: 'mallory/eval' } } }),
      ourPr({ head: { ref: 'adamant/run-1', repo: null } }),
      ourPr({ state: 'closed' }),
      ourPr({ merged: true }),
    ]

    for (const pr of heads) {
      const { calls, fetchImpl } = stubFetch({
        '/access_tokens': { token: 'ghs_minted' },
        'PUT /pulls/7/merge': { merged: true },
        'GET /pulls/7': pr,
      })

      await assert.rejects(merge(createGitHubClient(config, fetchImpl)), /Refusing to merge PR #7/)
      assert.equal(
        calls.some((call) => call.method === 'PUT'),
        false,
        JSON.stringify(pr),
      )
    }
  })

  it('reports a failed call by status without echoing the response body', async () => {
    const { fetchImpl } = stubFetch({
      '/access_tokens': { token: 'ghs_minted' },
      'GET /pulls/7': ourPr(),
    })
    const client = createGitHubClient(config, fetchImpl)

    await assert.rejects(
      merge(client),
      /GitHub PUT \/repos\/acme\/eval\/pulls\/7\/merge failed: 404/,
    )
  })
})

describe('GitHub App configuration', () => {
  it('is null when the worker has no app credentials, so callers fail closed', () => {
    assert.equal(readGitHubAppConfig({}), null)
    assert.equal(readGitHubAppConfig({ GITHUB_APP_ID: '1' }), null)
  })

  it('restores newlines in a single-line private key', () => {
    const resolved = readGitHubAppConfig({
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    })

    assert.match(String(resolved?.privateKey), /BEGIN PRIVATE KEY-----\nabc\n-----END/)
  })
})
