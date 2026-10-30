import { and, eq, or, sql } from 'drizzle-orm'
import { redactText } from '../agent/recorder.ts'
import {
  auditEvents,
  createDb,
  githubInstallations,
  repositories,
  runs,
  userIdentities,
  users,
  type Db,
} from '../db/client.ts'

/** Graph input loaded from a queued run. `source_sha` is the commit to check out. */
export type HealRun = {
  runId: string
  baseSha: string
  repositoryId: string
  owner: string
  name: string
  /** PR base branch. A SHA cannot be one, so it is read from the repo row. */
  defaultBranch: string
  installationId: string
}

export type FinishedStatus = 'succeeded' | 'failed' | 'awaiting_hitl'

export type RunStore = {
  loadRun: (runId: string) => Promise<HealRun | null>
  markRunning: (runId: string, retry: boolean) => Promise<boolean>
  /** `reason` is why a run failed outside the graph, such as a missing key. */
  markFinished: (runId: string, status: FinishedStatus, reason?: string) => Promise<void>
  /**
   * Whether this run may merge its own PR. The terminal's approval mode decides: the
   * mode of whoever started the run with /trigger, else of the Adamant user signed in
   * with the GitHub account that owns the repository. With neither (an organization's
   * repository, or an owner who never signed in) it merges, as the product does.
   */
  autoMerge: (runId: string) => Promise<boolean>
}

// Enough to say what broke; the worker log has the stack.
const MAX_REASON_LENGTH = 500

export function createRunStore(db: Db): RunStore {
  return {
    async loadRun(runId) {
      const rows = await db
        .select({
          runId: runs.id,
          baseSha: runs.sourceSha,
          repositoryId: runs.repositoryId,
          owner: repositories.owner,
          name: repositories.name,
          defaultBranch: repositories.defaultBranch,
          installationId: githubInstallations.githubInstallationId,
        })
        .from(runs)
        .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
        .innerJoin(githubInstallations, eq(githubInstallations.id, repositories.installationId))
        .where(eq(runs.id, runId))
        .limit(1)

      const row = rows[0]
      if (!row) return null

      return {
        runId: row.runId,
        baseSha: row.baseSha,
        repositoryId: row.repositoryId,
        owner: row.owner,
        name: row.name,
        defaultBranch: row.defaultBranch,
        installationId: String(row.installationId),
      }
    },

    // Status changes are audited in the same transaction, so `adamant watch`
    // and `adamant run` show a run start and end even when the graph never
    // reaches a tool (a missing key, an unreachable installation).
    markRunning(runId, retry) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(runs)
          .set({ status: 'running', updatedAt: new Date(), version: sql`${runs.version} + 1` })
          .where(
            and(
              eq(runs.id, runId),
              retry
                ? or(eq(runs.status, 'queued'), eq(runs.status, 'running'))
                : eq(runs.status, 'queued'),
            ),
          )
          .returning({ id: runs.id })
        if (rows.length !== 1) return false
        await tx.insert(auditEvents).values({ runId, eventType: 'run.started', payload: { retry } })
        return true
      })
    },

    async markFinished(runId, status, reason) {
      await db.transaction(async (tx) => {
        await setStatus(tx, runId, status)
        await tx.insert(auditEvents).values({
          runId,
          eventType: `run.${status}`,
          // Error text can quote a token; it is redacted like any audit payload.
          payload: reason ? { reason: redactText(reason).slice(0, MAX_REASON_LENGTH) } : {},
        })
      })
    },

    async autoMerge(runId) {
      const owners = await db
        .select({
          createdBy: runs.createdByUserId,
          accountGithubId: githubInstallations.accountGithubId,
          installedByGithubId: githubInstallations.installedByGithubId,
        })
        .from(runs)
        .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
        .innerJoin(githubInstallations, eq(githubInstallations.id, repositories.installationId))
        .where(eq(runs.id, runId))
        .limit(1)
      const owner = owners[0]
      if (!owner) return true

      if (owner.createdBy) {
        const rows = await db
          .select({ autoMerge: users.autoMerge })
          .from(users)
          .where(eq(users.id, owner.createdBy))
          .limit(1)
        return rows[0]?.autoMerge ?? true
      }
      // A personal installation's account is a person who can sign in. An
      // organization never signs in, so its installer's setting is the one that
      // applies; without it, manual mode was ignored on every org repository.
      for (const githubId of [owner.accountGithubId, owner.installedByGithubId]) {
        if (githubId === null) continue
        const rows = await db
          .select({ autoMerge: users.autoMerge })
          .from(userIdentities)
          .innerJoin(users, eq(users.id, userIdentities.userId))
          .where(
            and(
              eq(userIdentities.provider, 'github'),
              eq(userIdentities.providerUserId, String(githubId)),
            ),
          )
          .limit(1)
        if (rows[0]) return rows[0].autoMerge
      }
      return true
    },
  }
}

async function setStatus(
  db: Pick<Db, 'update'>,
  runId: string,
  status: 'running' | FinishedStatus,
) {
  await db
    .update(runs)
    .set({
      status,
      updatedAt: new Date(),
      version: sql`${runs.version} + 1`,
    })
    .where(eq(runs.id, runId))
}

export function createWorkerDb(url: string, maxConnections?: number) {
  return createDb(url, maxConnections ? { maxConnections } : {})
}
