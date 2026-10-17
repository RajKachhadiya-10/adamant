import { createPrivateKey, createSign } from 'node:crypto'

/**
 * The GitHub App side of the agent's tools. An installation token is minted
 * for each call and kept in a local, never stored on a run, in a checkpoint,
 * in a prompt or in the sandbox (docs/backend-architecture.md#identity).
 */
export interface GitHubAppConfig {
  readonly appId: string
  /** PKCS#8 or PKCS#1 PEM. Read from the environment by the worker only. */
  readonly privateKey: string
  readonly apiBaseUrl?: string
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const DEFAULT_API = 'https://api.github.com'
const JWT_LIFETIME_SECONDS = 540
const MAX_JOB_LOG_CHARS = 200_000
const USER_AGENT = 'adamant-heal-agent'
/**
 * A hung connection would otherwise hold the heal, and its job slot, until
 * graphile-worker's lock expires hours later. Log downloads get longer: they
 * are large and served from blob storage.
 */
const API_TIMEOUT_MS = 30_000
const LOG_TIMEOUT_MS = 120_000
/** A token this close to its expiry is not reused: a long push could outlive it. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000
/** Failed jobs in a matrix can run to dozens; this bounds sockets and memory. */
const LOG_DOWNLOAD_CONCURRENCY = 4
const PAGE_SIZE = 100
/** 10,000 installations or repositories; past that a sync would hold its slot too long. */
const MAX_PAGES = 100

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** Why `privateKey` cannot sign an App JWT, or null when it can. */
export function privateKeyProblem(privateKey: string): string | null {
  try {
    createPrivateKey(privateKey)
    return null
  } catch {
    // GitHub lists each key's fingerprint where the key was generated, and it is the
    // only thing on that page to copy.
    return privateKey.trim().startsWith('SHA256:')
      ? "GITHUB_APP_PRIVATE_KEY is the key's SHA256 fingerprint, not the key. Generate a private key on the GitHub App's settings page and paste the downloaded .pem."
      : 'GITHUB_APP_PRIVATE_KEY is not a PEM private key. Paste the .pem GitHub downloaded.'
  }
}

/** Short-lived App JWT. Only used to mint an installation token. */
function appJwt(config: GitHubAppConfig, now = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + JWT_LIFETIME_SECONDS, iss: config.appId }),
  )
  let signature: Buffer
  try {
    signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(config.privateKey)
  } catch {
    // OpenSSL's own message ("DECODER routines::unsupported") is what the run would show.
    throw new Error(
      privateKeyProblem(config.privateKey) ?? 'GITHUB_APP_PRIVATE_KEY could not sign the App JWT.',
    )
  }

  return `${header}.${payload}.${base64url(signature)}`
}

/** `fn` over `items` with at most `limit` in flight. Results keep the input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  const queue = items.map((item, index) => ({ item, index }))
  const lane = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      results[next.index] = await fn(next.item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

/**
 * The last `maxChars` of a response body, read as a stream. A job log can be
 * hundreds of megabytes; only its tail is wanted, so the whole thing is never
 * held in memory.
 */
async function readTail(response: Response, maxChars: number): Promise<string> {
  const body = response.body
  if (!body) return (await response.text()).slice(-maxChars)

  const decoder = new TextDecoder()
  const reader = body.getReader()
  let tail = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    tail += decoder.decode(value, { stream: true })
    if (tail.length > maxChars * 2) tail = tail.slice(-maxChars)
  }
  tail += decoder.decode()
  return tail.slice(-maxChars)
}

export interface WorkflowJob {
  readonly id: number
  readonly name: string
  readonly conclusion: string | null
}

export interface AppInstallation {
  readonly id: number
  readonly accountLogin: string
  readonly accountType: string
  readonly accountId: number | null
  readonly suspended: boolean
  /** What the account granted, which lags what the App requests until someone accepts. */
  readonly permissions: Readonly<Record<string, string>>
}

export interface InstallationRepository {
  readonly id: number
  readonly owner: string
  readonly name: string
  readonly defaultBranch: string
  readonly archived: boolean
}

export interface WorkflowRunSummary {
  readonly name: string
  readonly conclusion: string | null
  readonly headBranch: string | null
  readonly headRepositoryId: number | null
}

/** What the App's webhook settings say; `hasSecret` only, the secret is never read. */
export interface AppWebhook {
  readonly url: string | null
  readonly hasSecret: boolean
  readonly events: readonly string[]
  /** What the App requests, e.g. `{ contents: 'write' }`. */
  readonly permissions: Readonly<Record<string, string>>
}

export interface GitHubClient {
  installationToken(installationId: string): Promise<string>
  failedJobLogs(input: {
    installationId: string
    owner: string
    name: string
    headSha: string
  }): Promise<string>
  createPullRequest(input: {
    installationId: string
    owner: string
    name: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<{ number: number; url: string }>
  /**
   * Merges `prNumber` only if its head is `headRef` on this repository and
   * it is still open. The number alone is not proof it is this run's PR.
   */
  mergePullRequest(input: {
    installationId: string
    owner: string
    name: string
    prNumber: number
    headRef: string
    commitTitle: string
  }): Promise<void>
  /** Every installation of the App, across all pages. */
  listInstallations(): Promise<AppInstallation[]>
  /** The repositories one installation can reach, across all pages. */
  listInstallationRepositories(installationId: string): Promise<InstallationRepository[]>
  /**
   * The newest commit on `branch` and the workflow runs at that commit. Null when the
   * branch does not exist, as in an empty repository.
   */
  headWorkflowRuns(input: {
    installationId: string
    owner: string
    name: string
    branch: string
  }): Promise<{ headSha: string; runs: WorkflowRunSummary[] } | null>
  pullRequestState(input: {
    installationId: string
    owner: string
    name: string
    prNumber: number
  }): Promise<{ state: string; merged: boolean }>
  appWebhook(): Promise<AppWebhook>
}

/** Read back before a merge. Anything else on the PR is ignored. */
interface PullRequestHead {
  readonly state: string
  readonly merged: boolean
  readonly head: { readonly ref: string; readonly repo: { readonly full_name: string } | null }
}

export class GitHubApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
  }
}

export function createGitHubClient(config: GitHubAppConfig, fetchImpl?: FetchLike): GitHubClient {
  const api = (config.apiBaseUrl ?? DEFAULT_API).replace(/\/$/, '')
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init))

  async function call(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    accept = 'application/vnd.github+json',
    timeoutMs = API_TIMEOUT_MS,
  ): Promise<Response> {
    const response = await doFetch(`${api}${path}`, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        'user-agent': USER_AGENT,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      // The body can echo request headers; only the status and path are kept.
      throw new GitHubApiError(
        response.status,
        `GitHub ${method} ${path} failed: ${response.status}`,
      )
    }

    return response
  }

  async function json<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await call(token, method, path, body)
    return (await response.json()) as T
  }

  /** Calls made as the App itself, signed with a fresh JWT. */
  function appJson<T>(path: string): Promise<T> {
    return json<T>(appJwt(config), 'GET', path)
  }

  /** GitHub pages at 100; a short page is the last one. */
  async function allPages<T>(fetchPage: (page: number) => Promise<T[]>): Promise<T[]> {
    const items: T[] = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await fetchPage(page)
      items.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }
    return items
  }

  /**
   * Installation tokens live an hour. One per installation is held in this
   * closure and reused until shortly before it expires, then minted again.
   * Memory only: never on a run, in a checkpoint, a prompt, a log or the
   * sandbox (docs/backend-architecture.md#identity). A failed mint is dropped
   * so the next call tries again; concurrent first callers share one mint.
   */
  const tokens = new Map<string, Promise<{ token: string; expiresAt: number }>>()

  async function mint(installationId: string): Promise<{ token: string; expiresAt: number }> {
    const response = await doFetch(`${api}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${appJwt(config)}`,
        'user-agent': USER_AGENT,
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `Could not mint an installation token: ${response.status}`,
      )
    }

    const body = (await response.json()) as { token?: string; expires_at?: string }
    if (!body.token) {
      throw new GitHubApiError(response.status, 'Installation token response had no token')
    }
    // Without an expiry nothing is assumed: the token is used once, as before.
    const expiresAt = body.expires_at ? Date.parse(body.expires_at) : 0
    return { token: body.token, expiresAt: Number.isNaN(expiresAt) ? 0 : expiresAt }
  }

  const client: GitHubClient = {
    async installationToken(installationId) {
      // Looked up before any await, so two callers in the same tick see one mint.
      const pending = tokens.get(installationId)
      if (pending) {
        const held = await pending.catch(() => null)
        if (held && held.expiresAt - Date.now() > TOKEN_REUSE_MARGIN_MS) return held.token
      }

      const minted = mint(installationId)
      tokens.set(installationId, minted)
      try {
        return (await minted).token
      } catch (error) {
        tokens.delete(installationId)
        throw error
      }
    },

    /** Failed jobs only. Downloading the whole run is the slow, noisy path. */
    async failedJobLogs({ installationId, owner, name, headSha }) {
      const token = await client.installationToken(installationId)
      const repo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`

      const runs = await json<{ workflow_runs?: { id: number; conclusion: string | null }[] }>(
        token,
        'GET',
        `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&status=completed&per_page=20`,
      )

      const failedRuns = (runs.workflow_runs ?? []).filter((run) => run.conclusion === 'failure')
      if (failedRuns.length === 0) {
        return ''
      }

      // Runs, then their jobs, then the failed jobs' logs: each level is fetched
      // concurrently. Promise.all keeps the order, so the joined log is stable.
      const jobLists = await Promise.all(
        failedRuns.map((run) =>
          json<{ jobs?: WorkflowJob[] }>(
            token,
            'GET',
            `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
          ),
        ),
      )
      const failedJobs = jobLists.flatMap((list) =>
        (list.jobs ?? []).filter((job) => job.conclusion === 'failure'),
      )

      const sections = await mapLimit(failedJobs, LOG_DOWNLOAD_CONCURRENCY, async (job) => {
        // The endpoint answers 415 to `Accept: text/plain`; with the API media type it
        // redirects to the log file, which fetch follows (dropping the token cross-origin).
        const logs = await call(
          token,
          'GET',
          `/repos/${repo}/actions/jobs/${job.id}/logs`,
          undefined,
          'application/vnd.github+json',
          LOG_TIMEOUT_MS,
        )
        return `=== job: ${job.name} ===\n${await readTail(logs, MAX_JOB_LOG_CHARS)}`
      })

      return sections.join('\n\n')
    },

    async createPullRequest({ installationId, owner, name, head, base, title, body }) {
      const token = await client.installationToken(installationId)
      const repo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
      const pr = await json<{ number: number; html_url: string }>(
        token,
        'POST',
        `/repos/${repo}/pulls`,
        { title, head, base, body, maintainer_can_modify: true },
      )

      return { number: pr.number, url: pr.html_url }
    },

    async mergePullRequest({ installationId, owner, name, prNumber, headRef, commitTitle }) {
      const token = await client.installationToken(installationId)
      const repo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`

      // The run's own PR has this head on this repo. A PR number is a small
      // integer that could name anyone's PR, so the head is read back and
      // checked here before the merge goes out, not taken on trust.
      const pr = await json<PullRequestHead>(token, 'GET', `/repos/${repo}/pulls/${prNumber}`)
      const headRepo = pr.head.repo?.full_name.toLowerCase() ?? null
      if (pr.head.ref !== headRef || headRepo !== `${owner}/${name}`.toLowerCase()) {
        throw new Error(
          `Refusing to merge PR #${prNumber}: its head is ${headRepo ?? '(deleted)'}:${pr.head.ref}, not ${owner}/${name}:${headRef}.`,
        )
      }
      if (pr.state !== 'open' || pr.merged) {
        throw new Error(
          `Refusing to merge PR #${prNumber}: it is ${pr.merged ? 'merged' : pr.state}.`,
        )
      }

      await json(token, 'PUT', `/repos/${repo}/pulls/${prNumber}/merge`, {
        merge_method: 'squash',
        commit_title: commitTitle,
      })
    },

    async listInstallations() {
      type Raw = {
        id: number
        suspended_at?: string | null
        account?: { id?: number; login?: string; type?: string } | null
        permissions?: Record<string, string>
      }
      const raw = await allPages((page) =>
        appJson<Raw[]>(`/app/installations?per_page=${PAGE_SIZE}&page=${page}`),
      )
      return raw.map((installation) => ({
        id: installation.id,
        accountLogin: installation.account?.login ?? 'unknown',
        accountType: installation.account?.type ?? 'Organization',
        accountId: installation.account?.id ?? null,
        suspended: Boolean(installation.suspended_at),
        permissions: installation.permissions ?? {},
      }))
    },

    async listInstallationRepositories(installationId) {
      type Raw = {
        id: number
        name: string
        owner: { login: string }
        default_branch?: string
        archived?: boolean
      }
      const token = await client.installationToken(installationId)
      const raw = await allPages(async (page) => {
        const body = await json<{ repositories?: Raw[] }>(
          token,
          'GET',
          `/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`,
        )
        return body.repositories ?? []
      })
      return raw.map((repo) => ({
        id: repo.id,
        owner: repo.owner.login,
        name: repo.name,
        defaultBranch: repo.default_branch ?? 'main',
        archived: Boolean(repo.archived),
      }))
    },

    async headWorkflowRuns({ installationId, owner, name, branch }) {
      const token = await client.installationToken(installationId)
      const repo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
      let headSha: string
      try {
        const head = await json<{ commit?: { sha?: string } }>(
          token,
          'GET',
          `/repos/${repo}/branches/${encodeURIComponent(branch)}`,
        )
        if (!head.commit?.sha) return null
        headSha = head.commit.sha
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) return null
        throw error
      }

      type Raw = {
        name?: string
        conclusion?: string | null
        head_branch?: string | null
        head_repository?: { id?: number } | null
      }
      const body = await json<{ workflow_runs?: Raw[] }>(
        token,
        'GET',
        `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=${PAGE_SIZE}`,
      )
      return {
        headSha,
        runs: (body.workflow_runs ?? []).map((run) => ({
          name: run.name ?? 'workflow',
          conclusion: run.conclusion ?? null,
          headBranch: run.head_branch ?? null,
          headRepositoryId: run.head_repository?.id ?? null,
        })),
      }
    },

    async pullRequestState({ installationId, owner, name, prNumber }) {
      const token = await client.installationToken(installationId)
      const repo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
      const pr = await json<{ state: string; merged?: boolean }>(
        token,
        'GET',
        `/repos/${repo}/pulls/${prNumber}`,
      )
      return { state: pr.state, merged: Boolean(pr.merged) }
    },

    async appWebhook() {
      const [hook, app] = await Promise.all([
        appJson<{ url?: string; secret?: string | null }>('/app/hook/config'),
        appJson<{ events?: string[]; permissions?: Record<string, string> }>('/app'),
      ])
      return {
        url: hook.url ?? null,
        // GitHub masks a set secret as asterisks and leaves the field out otherwise.
        hasSecret: Boolean(hook.secret),
        events: app.events ?? [],
        permissions: app.permissions ?? {},
      }
    },
  }

  return client
}

/** Worker-only. Returns null when the App is not configured, so callers fail closed. */
export function readGitHubAppConfig(env = process.env): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n')

  if (!appId || !privateKey) return null

  return {
    appId,
    privateKey,
    ...(env.GITHUB_API_URL ? { apiBaseUrl: env.GITHUB_API_URL } : {}),
  }
}
