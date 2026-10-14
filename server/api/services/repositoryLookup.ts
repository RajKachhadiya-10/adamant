import { and, desc, eq } from 'drizzle-orm'
import { GithubInstallationStatusSchema, type GithubInstallationStatus } from '@adamant/contract'
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
