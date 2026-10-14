import { createHash, randomUUID } from 'node:crypto'
import { createDb } from '../../db/client.ts'
import {
  createMemoryWebhookStore,
  createPostgresWebhookStore,
  type WebhookStore,
} from './webhookStore.ts'

/**
 * Red CI starts a heal. Nothing else does.
 *
 * Order matters: the delivery row is written before the run, so a retried
 * delivery is rejected by the unique index before it can create a second run
 * (docs/backend-architecture.md#auth). A merge only ever confirms a
 * run we already published; it never starts one.
 */
export interface WebhookDependencies {
  readonly store: WebhookStore
}

export interface WebhookResult {
  readonly runId: string | null
}

type RepositoryPayload = {
  id?: number
  name?: string
  full_name?: string
  default_branch?: string
  owner?: { login?: string }
}

type InstallationPayload = {
  id?: number
  account?: { login?: string; type?: string }
}

type EventPayload = {
  action?: string
  installation?: InstallationPayload
  repository?: RepositoryPayload
  /** `installation` events list repos here, not on `repository`. */
  repositories?: RepositoryPayload[]
  /**
   * `installation_repositories` lists the change here. `removed` is not
   * applied: dropping a repo from the installation must not delete the row.
   */
  repositories_added?: RepositoryPayload[]
  repositories_removed?: RepositoryPayload[]
  workflow_run?: {
    conclusion?: string
    head_sha?: string
    head_branch?: string | null
    head_repository?: { id?: number } | null
  }
  pull_request?: { merged?: boolean; number?: number }
}

export class DuplicateDeliveryError extends Error {
  constructor() {
    super('Duplicate delivery')
    this.name = 'DuplicateDeliveryError'
  }
}

/**
 * The heal PR is built on `head_sha` and merged into the default branch, so a
 * failure anywhere else would merge someone else's commits along with the fix:
 * a fork's pull request, a feature branch, or one of our own `adamant/*` PRs
 * (which would also heal itself in a loop). Missing fields fail closed.
 */
function failedOnDefaultBranch(payload: EventPayload): boolean {
  const run = payload.workflow_run
  const repositoryId = payload.repository?.id
  const defaultBranch = payload.repository?.default_branch

  return (
    Boolean(defaultBranch) &&
    run?.head_branch === defaultBranch &&
    repositoryId !== undefined &&
    run?.head_repository?.id === repositoryId
  )
}

function payloadDigest(rawBody: string | undefined, payload: unknown): string {
  const source = rawBody ?? JSON.stringify(payload ?? '')
  return createHash('sha256').update(source).digest('hex')
}

function repositoryIdentity(repository: RepositoryPayload): {
  id: number
  owner: string
  name: string
  defaultBranch: string
} | null {
  const owner = repository.owner?.login ?? repository.full_name?.split('/')[0]
  const name = repository.name ?? repository.full_name?.split('/')[1]
  if (!repository.id || !owner || !name) return null
  return {
    id: repository.id,
    owner,
    name,
    defaultBranch: repository.default_branch ?? 'main',
  }
}

export function createWebhookService(deps: WebhookDependencies) {
  /** Both rows are keyed on GitHub's numeric ids, so this is safe to repeat. */
  async function bind(store: WebhookStore, payload: EventPayload) {
    const installationId = payload.installation?.id
    if (!installationId) return { installationRowId: null, repositoryRowId: null }

    const installationRowId = await store.upsertInstallation({
      githubInstallationId: installationId,
      accountLogin: payload.installation?.account?.login ?? 'unknown',
      accountType: payload.installation?.account?.type ?? 'Organization',
    })

    const listed = [
      ...(payload.repository ? [payload.repository] : []),
      ...(payload.repositories ?? []),
      // `added` is the only action that names new repos. `removed` stays stored
      // so a later failure on that repo can still heal; this event never starts one.
      ...(payload.action === 'added' ? (payload.repositories_added ?? []) : []),
    ]
    const seen = new Set<number>()
    let primaryRowId: string | null = null
    let onlyRowId: string | null = null
    let count = 0

    for (const repository of listed) {
      const identity = repositoryIdentity(repository)
      if (!identity || seen.has(identity.id)) continue
      seen.add(identity.id)
      const rowId = await store.upsertRepository({
        installationId: installationRowId,
        githubRepoId: identity.id,
        owner: identity.owner,
        name: identity.name,
        defaultBranch: identity.defaultBranch,
      })
      count += 1
      onlyRowId = rowId
      if (payload.repository?.id === identity.id) primaryRowId = rowId
    }

    // An installation-wide event names many repos. Don't pin the delivery to one of them.
    const repositoryRowId = primaryRowId ?? (count === 1 ? onlyRowId : null)
    return { installationRowId, repositoryRowId }
  }

  async function handleWorkflowRun(
    store: WebhookStore,
    deliveryId: string,
    payload: EventPayload,
    repositoryRowId: string | null,
  ): Promise<string | null> {
    if (payload.action !== 'completed') return null
    if (payload.workflow_run?.conclusion !== 'failure') return null

    const headSha = payload.workflow_run.head_sha
    if (!repositoryRowId || !headSha) return null
    if (!failedOnDefaultBranch(payload)) return null

    // One heal per commit. Each failing workflow sends its own delivery, and
    // the heal already reads every failed job at this SHA, so a second run
    // would only race the first to a competing PR.
    const runId = randomUUID()
    const created = await store.createQueuedRun({
      runId,
      repositoryId: repositoryRowId,
      sourceSha: headSha,
      idempotencyKey: `workflow_run:${headSha}`,
    })

    if (!created) return null

    await store.recordAudit(created, 'run.queued', { deliveryId, sourceSha: headSha })
    return created
  }

  async function handlePullRequest(
    store: WebhookStore,
    deliveryId: string,
    payload: EventPayload,
    repositoryRowId: string | null,
  ): Promise<null> {
    if (payload.action !== 'closed' || !payload.pull_request?.merged) return null

    const prNumber = payload.pull_request.number
    if (!repositoryRowId || !prNumber) return null

    // A merge confirms a run we opened. It never starts a heal, and it never
    // merges anything a second time.
    const runId = await store.findRunByPullRequest(repositoryRowId, prNumber)
    if (runId) await store.markRunSucceeded(runId)
    await store.recordAudit(runId, 'pull_request.merged', {
      deliveryId,
      prNumber,
      ours: runId !== null,
    })

    return null
  }

  async function dispatch(
    store: WebhookStore,
    deliveryId: string,
    event: string,
    payload: EventPayload,
    repositoryRowId: string | null,
  ): Promise<string | null> {
    switch (event) {
      case 'workflow_run':
        return handleWorkflowRun(store, deliveryId, payload, repositoryRowId)
      case 'pull_request':
        return handlePullRequest(store, deliveryId, payload, repositoryRowId)
      case 'installation':
      case 'installation_repositories':
      case 'ping':
        // The delivery row already stores `event`. Repos were upserted in bind().
        return null
      default:
        return null
    }
  }

  return {
    async processEvent(
      deliveryId: string,
      event: string,
      rawPayload: unknown,
      rawBody?: string,
    ): Promise<WebhookResult> {
      return deps.store.transaction(async (store) => {
        const payload = (rawPayload ?? {}) as EventPayload
        const { installationRowId, repositoryRowId } = await bind(store, payload)

        const stored = await store.recordDelivery({
          deliveryId,
          eventType: event,
          installationId: installationRowId,
          repositoryId: repositoryRowId,
          payloadDigest: payloadDigest(rawBody, rawPayload),
        })

        if (!stored) {
          throw new DuplicateDeliveryError()
        }

        const runId = await dispatch(store, deliveryId, event, payload, repositoryRowId)
        await store.markDeliveryProcessed(deliveryId, runId ? 'processed' : 'ignored')

        return { runId }
      })
    },
  }
}

export type WebhookService = ReturnType<typeof createWebhookService>

let cached: WebhookService | null = null

/**
 * Postgres-backed when `DATABASE_URL` is set, in-memory otherwise, so the API
 * still answers locally without a database. Resolved on first use, not at
 * import, so tests decide which one they get.
 */
export function defaultWebhookService(): WebhookService {
  if (cached) return cached

  const url = process.env.DATABASE_URL
  cached = url
    ? createWebhookService({
        store: createPostgresWebhookStore(createDb(url)),
      })
    : createWebhookService({
        store: createMemoryWebhookStore(),
      })

  return cached
}

/** Test seam: drops the memoised service so the next call re-reads the env. */
export function resetWebhookService(): void {
  cached = null
}
