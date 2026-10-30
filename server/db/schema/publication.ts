import { pgTable, uuid, text, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { runs } from './runs.ts'
import { repositories } from './github.ts'

/**
 * UNIQUE(runId) enforces the project rule "one draft PR per run." `repositoryId` is
 * denormalized here (also reachable via runId -> runs.repositoryId) purely to support
 * a direct (repositoryId, githubPrNumber) lookup for C7's "reconcile an existing PR"
 * check without a join — it is written once at insert time and never updated
 * afterward, since a PR's owning repository cannot change.
 */
export const prPublications = pgTable(
  'pr_publications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    githubPrNumber: integer('github_pr_number').notNull(),
    prUrl: text('pr_url').notNull(),
    baseSha: text('base_sha').notNull(),
    candidateHash: text('candidate_hash').notNull(),
    /**
     * The commit the worker pushed after the sandbox passed. The merge is pinned to
     * it, so a later push to `adamant/{run_id}` is never merged untested. Null on
     * rows written before it was recorded; those runs are not merged by Adamant.
     */
    headSha: text('head_sha'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('pr_publications_run_id_uidx').on(table.runId),
    uniqueIndex('pr_publications_repo_pr_number_uidx').on(table.repositoryId, table.githubPrNumber),
  ],
)
