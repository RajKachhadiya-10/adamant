import { and, asc, desc, eq } from 'drizzle-orm'
import {
  GithubInstallationStatusSchema,
  GithubRepositorySchema,
  type GithubInstallationStatus,
  type GithubRepository,
} from '@adamant/contract'
import { repositories, type Db } from '../../db/client.ts'

/**
 * Exact `owner` and `name`. Equality, not LIKE, so `_` and `%` are never
 * wildcards, and the row's installation id stays in Postgres. Owner+name is
 * not unique across a rename, so the newest webhook write wins.
 */
export async function findInstalledRepository(
  db: Db,
  owner: string,
  name: string,
): Promise<GithubInstallationStatus | null> {
  const rows = await db
    .select({
      owner: repositories.owner,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
    })
    .from(repositories)
    .where(and(eq(repositories.owner, owner), eq(repositories.name, name)))
    .orderBy(desc(repositories.updatedAt))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  const parsed = GithubInstallationStatusSchema.safeParse(row)
  return parsed.success ? parsed.data : null
}

/**
 * Repositories the webhook has already written. No GitHub call and no user
 * token: a session only authorizes reading this table.
 */
export async function listInstalledRepositories(db: Db): Promise<GithubRepository[]> {
  const rows = await db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
    })
    .from(repositories)
    .orderBy(asc(repositories.owner), asc(repositories.name), desc(repositories.updatedAt))

  const listed: GithubRepository[] = []
  for (const row of rows) {
    const parsed = GithubRepositorySchema.safeParse(row)
    if (parsed.success) listed.push(parsed.data)
  }
  return listed
}
