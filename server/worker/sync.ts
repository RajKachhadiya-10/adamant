import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { type WebhookStore } from '../api/services/webhookStore.ts'
import {
  auditEvents,
  githubInstallations,
  prPublications,
  repositories,
  runs,
  type Db,
} from '../db/client.ts'
import { type GitHubClient } from './github.ts'

/**
 * Webhooks are the fast path, not the only one. GitHub does not redeliver a delivery
 * that failed or went to the wrong URL, so a missed `installation` event left the CLI
 * waiting on an install forever, and a missed `workflow_run` left a red build unhealed.
 * This reads the same facts from GitHub's API: which repositories the App is on, and
 * whether each default branch's newest commit has a failed workflow. A heal it queues
 * uses the webhook's idempotency key, so the two paths never heal one commit twice.
 *
 * It also settles heals left for review (manual mode): a PR merged by hand marks the
 * run succeeded, one closed without merging marks it aborted.
 */
export type SyncGitHub = Pick<
  GitHubClient,
  'listInstallations' | 'listInstallationRepositories' | 'headWorkflowRuns' | 'pullRequestState'
>

export interface ReviewRun {
  readonly runId: string
  readonly owner: string
  readonly name: string
  readonly installationId: string
  readonly prNumber: number
}

export interface SyncStore extends Pick<
  WebhookStore,
  'upsertInstallation' | 'upsertRepository' | 'createQueuedRun' | 'recordAudit'
> {
  /** A queued run and its audit row land together or not at all. */
  transaction<T>(
    callback: (store: Pick<WebhookStore, 'createQueuedRun' | 'recordAudit'>) => Promise<T>,
  ): Promise<T>
  /** Runs whose PR is open and waiting for a person. */
  awaitingReview(): Promise<ReviewRun[]>
  /** False when the run already left review, as when the merge webhook got there first. */
  finishReview(runId: string, status: 'succeeded' | 'aborted', prNumber: number): Promise<boolean>
}

export interface SyncReport {
  readonly installations: number
  readonly repositories: number
  readonly queued: string[]
  readonly reviewed: string[]
  readonly errors: string[]
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function syncGithub(
  github: SyncGitHub,
  store: SyncStore,
  newRunId: () => string = randomUUID,
): Promise<SyncReport> {
  const report = {
    installations: 0,
    repositories: 0,
    queued: [] as string[],
    reviewed: [] as string[],
    errors: [] as string[],
  }

  for (const installation of await github.listInstallations()) {
    // A suspended installation cannot mint tokens; its rows stay for history.
    if (installation.suspended) continue
    try {
      const installationRowId = await store.upsertInstallation({
        githubInstallationId: installation.id,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        ...(installation.accountId === null ? {} : { accountGithubId: installation.accountId }),
      })
      report.installations += 1

      const listed = await github.listInstallationRepositories(String(installation.id))
      for (const repo of listed) {
        const repositoryRowId = await store.upsertRepository({
          installationId: installationRowId,
          githubRepoId: repo.id,
          owner: repo.owner,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
        })
        report.repositories += 1
        // Nothing can be pushed to an archived repository.
        if (repo.archived) continue
        try {
          const runId = await queueRedHead(github, store, newRunId, {
            installationId: String(installation.id),
            repositoryRowId,
            githubRepoId: repo.id,
            owner: repo.owner,
            name: repo.name,
            defaultBranch: repo.defaultBranch,
          })
          if (runId) report.queued.push(runId)
        } catch (error) {
          report.errors.push(`${repo.owner}/${repo.name}: ${message(error)}`)
        }
      }
    } catch (error) {
      report.errors.push(`installation ${installation.id}: ${message(error)}`)
    }
  }

  for (const run of await store.awaitingReview()) {
    try {
      const pr = await github.pullRequestState(run)
      const outcome = pr.merged ? 'succeeded' : pr.state === 'closed' ? 'aborted' : null
      if (outcome && (await store.finishReview(run.runId, outcome, run.prNumber))) {
        report.reviewed.push(run.runId)
      }
    } catch (error) {
      report.errors.push(`run ${run.runId}: ${message(error)}`)
    }
  }

  return report
}

/**
 * The same test the webhook applies (failedOnDefaultBranch): a failed run on the
 * default branch of this repository, not a fork's. Only the newest commit counts; a
 * failure an older commit already fixed is not a red build.
 */
async function queueRedHead(
  github: SyncGitHub,
  store: SyncStore,
  newRunId: () => string,
  repo: {
    installationId: string
    repositoryRowId: string
    githubRepoId: number
    owner: string
    name: string
    defaultBranch: string
  },
): Promise<string | null> {
  const head = await github.headWorkflowRuns({
    installationId: repo.installationId,
    owner: repo.owner,
    name: repo.name,
    branch: repo.defaultBranch,
  })
  if (!head) return null
  const failed = head.runs.filter(
    (run) =>
      run.conclusion === 'failure' &&
      run.headBranch === repo.defaultBranch &&
      run.headRepositoryId === repo.githubRepoId,
  )
  if (failed.length === 0) return null

  return store.transaction(async (tx) => {
    const runId = await tx.createQueuedRun({
      runId: newRunId(),
      repositoryId: repo.repositoryRowId,
      sourceSha: head.headSha,
      idempotencyKey: `workflow_run:${head.headSha}`,
    })
    if (!runId) return null
    await tx.recordAudit(runId, 'run.queued', {
      sourceSha: head.headSha,
      repository: `${repo.owner}/${repo.name}`,
      // Says the heal came from the sync, not a webhook, when someone asks why.
      via: 'sync',
      workflows: failed.map((run) => run.name),
    })
    return runId
  })
}

export function createPostgresSyncStore(db: Db, webhookStore: WebhookStore): SyncStore {
  return {
    transaction: (callback) => webhookStore.transaction(callback),
    upsertInstallation: (input) => webhookStore.upsertInstallation(input),
    upsertRepository: (input) => webhookStore.upsertRepository(input),
    createQueuedRun: (input) => webhookStore.createQueuedRun(input),
    recordAudit: (runId, eventType, payload) => webhookStore.recordAudit(runId, eventType, payload),

    async awaitingReview() {
      const rows = await db
        .select({
          runId: runs.id,
          owner: repositories.owner,
          name: repositories.name,
          installationId: githubInstallations.githubInstallationId,
          prNumber: prPublications.githubPrNumber,
        })
        .from(runs)
        .innerJoin(prPublications, eq(prPublications.runId, runs.id))
        .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
        .innerJoin(githubInstallations, eq(githubInstallations.id, repositories.installationId))
        .where(eq(runs.status, 'awaiting_hitl'))
      return rows.map((row) => ({ ...row, installationId: String(row.installationId) }))
    },

    finishReview(runId, status, prNumber) {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(runs)
          .set({ status, updatedAt: new Date(), version: sql`${runs.version} + 1` })
          .where(and(eq(runs.id, runId), eq(runs.status, 'awaiting_hitl')))
          .returning({ id: runs.id })
        if (updated.length !== 1) return false
        await tx.insert(auditEvents).values({
          runId,
          eventType: status === 'succeeded' ? 'run.merged' : 'run.aborted',
          payload:
            status === 'succeeded'
              ? { prNumber, by: 'review' }
              : { prNumber, reason: 'The PR was closed without merging.' },
        })
        return true
      })
    },
  }
}
