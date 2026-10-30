import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createPostgresWebhookStore } from '../../server/api/services/webhookStore.ts'
import {
  createDb,
  githubInstallations,
  repositories,
  runs,
  userIdentities,
  users,
  type Db,
} from '../../server/db/client.ts'
import { createPostgresRecorder } from '../../server/worker/recorder.ts'
import { createRunStore } from '../../server/worker/runs.ts'

/**
 * The SQL half of the merge gate. Runs only when ADAMANT_TEST_DATABASE_URL
 * names a scratch database, which it migrates and writes to. Its rows are
 * deleted afterwards, but never point it at a database whose data matters.
 */
const url = process.env.ADAMANT_TEST_DATABASE_URL

const HEAD_SHA = 'ab12'.repeat(10)

describe(
  'merge gate on Postgres',
  { skip: url ? false : 'ADAMANT_TEST_DATABASE_URL is not set' },
  () => {
    let database: Db | undefined
    const installationIds: string[] = []
    const repositoryIds: string[] = []
    const runIds: string[] = []
    const userIds: string[] = []
    const db = () => {
      if (!database) throw new Error('The database is not open')
      return database
    }

    before(async () => {
      database = createDb(url ?? '')
      await migrate(database, {
        migrationsFolder: path.resolve(import.meta.dirname, '../../server/db/drizzle'),
      })
    })

    after(async () => {
      if (!database) return
      // Runs take their publications with them; repositories restrict deleting a
      // run's repository, so the order matters.
      if (runIds.length > 0) await database.delete(runs).where(inArray(runs.id, runIds))
      if (repositoryIds.length > 0) {
        await database.delete(repositories).where(inArray(repositories.id, repositoryIds))
      }
      if (installationIds.length > 0) {
        await database
          .delete(githubInstallations)
          .where(inArray(githubInstallations.id, installationIds))
      }
      // Identities go with their users (on delete cascade).
      if (userIds.length > 0) await database.delete(users).where(inArray(users.id, userIds))
      await database.$client.end()
    })

    /** A signed-in Adamant user with this GitHub id and merge setting. */
    async function addGithubUser(githubId: number, autoMerge: boolean) {
      const [user] = await db()
        .insert(users)
        .values({ username: `merge-gate-${githubId}`, autoMerge })
        .returning({ id: users.id })
      if (!user) throw new Error('No user was created')
      userIds.push(user.id)
      await db()
        .insert(userIdentities)
        .values({ userId: user.id, provider: 'github', providerUserId: String(githubId) })
    }

    async function addRun(account: {
      type: 'User' | 'Organization'
      githubId: number
      installedByGithubId?: number
    }) {
      const [installation] = await db()
        .insert(githubInstallations)
        .values({
          githubInstallationId: randomInt(1, 2 ** 47),
          accountLogin: `acct-${account.githubId}`,
          accountGithubId: account.githubId,
          installedByGithubId: account.installedByGithubId ?? null,
          accountType: account.type,
        })
        .returning({ id: githubInstallations.id })
      if (!installation) throw new Error('No installation was created')
      installationIds.push(installation.id)

      const [repository] = await db()
        .insert(repositories)
        .values({
          installationId: installation.id,
          githubRepoId: randomInt(1, 2 ** 47),
          owner: `acct-${account.githubId}`,
          name: 'eval',
        })
        .returning({ id: repositories.id })
      if (!repository) throw new Error('No repository was created')
      repositoryIds.push(repository.id)

      const [run] = await db()
        .insert(runs)
        .values({
          repositoryId: repository.id,
          sourceSha: 'deadbeef',
          targetBranch: 'adamant/pending',
          status: 'running',
        })
        .returning({ id: runs.id })
      if (!run) throw new Error('No run was created')
      runIds.push(run.id)

      return { runId: run.id, repositoryId: repository.id, installationId: installation.id }
    }

    it('stores the pushed head commit with the PR and reads it back for the merge', async () => {
      const run = await addRun({ type: 'User', githubId: randomInt(1, 2 ** 47) })
      const recorder = createPostgresRecorder(db(), run)

      assert.equal(await recorder.publishedHeadSha(), null)
      await recorder.prPublication({
        prNumber: 7,
        prUrl: 'https://github.com/acme/eval/pull/7',
        baseSha: 'deadbeef',
        candidateHash: 'hash',
        headSha: HEAD_SHA,
      })

      assert.equal(await recorder.publishedPrNumber(), 7)
      assert.equal(await recorder.publishedHeadSha(), HEAD_SHA)
    })

    it("follows the installer's manual setting on an organization's repository", async () => {
      const installer = randomInt(1, 2 ** 47)
      await addGithubUser(installer, false)
      // The organization's own id matches no user: organizations never sign in.
      const run = await addRun({
        type: 'Organization',
        githubId: randomInt(1, 2 ** 47),
        installedByGithubId: installer,
      })

      assert.equal(await createRunStore(db()).autoMerge(run.runId), false)
    })

    it("follows the installer's auto setting on an organization's repository", async () => {
      const installer = randomInt(1, 2 ** 47)
      await addGithubUser(installer, true)
      const run = await addRun({
        type: 'Organization',
        githubId: randomInt(1, 2 ** 47),
        installedByGithubId: installer,
      })

      assert.equal(await createRunStore(db()).autoMerge(run.runId), true)
    })

    it("still follows a personal account's own setting", async () => {
      const account = randomInt(1, 2 ** 47)
      await addGithubUser(account, false)
      const run = await addRun({ type: 'User', githubId: account })

      assert.equal(await createRunStore(db()).autoMerge(run.runId), false)
    })

    it('keeps the existing default when neither account nor installer has signed in', async () => {
      const run = await addRun({
        type: 'Organization',
        githubId: randomInt(1, 2 ** 47),
        installedByGithubId: randomInt(1, 2 ** 47),
      })

      assert.equal(await createRunStore(db()).autoMerge(run.runId), true)
    })

    it('keeps the recorded installer when a later event does not name one', async () => {
      const githubInstallationId = randomInt(1, 2 ** 47)
      const store = createPostgresWebhookStore(db())
      const input = { githubInstallationId, accountLogin: 'acme', accountType: 'Organization' }

      const id = await store.upsertInstallation({ ...input, installedByGithubId: 777 })
      installationIds.push(id)
      await store.upsertInstallation(input)

      const [row] = await db()
        .select({ installedBy: githubInstallations.installedByGithubId })
        .from(githubInstallations)
        .where(eq(githubInstallations.id, id))
      assert.equal(row?.installedBy, 777)
    })
  },
)
