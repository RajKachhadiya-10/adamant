import { describe, it } from 'node:test'
import * as assert from 'node:assert'
import { createMemoryWebhookStore } from '../../server/api/services/webhookStore.ts'
import { createWebhookService } from '../../server/api/services/webhookService.ts'
import {
  type AppInstallation,
  type InstallationRepository,
  type WorkflowRunSummary,
} from '../../server/worker/github.ts'
import {
  syncGithub,
  type ReviewRun,
  type SyncGitHub,
  type SyncStore,
} from '../../server/worker/sync.ts'

const RED = 'a'.repeat(40)
const GREEN = 'b'.repeat(40)

const installation = (overrides: Partial<AppInstallation> = {}): AppInstallation => ({
  id: 171643878,
  accountLogin: 'vaishcodescape',
  accountType: 'User',
  accountId: 99,
  suspended: false,
  permissions: { contents: 'write', pull_requests: 'write', actions: 'read' },
  ...overrides,
})

const repo = (overrides: Partial<InstallationRepository> = {}): InstallationRepository => ({
  id: 1420341093,
  owner: 'vaishcodescape',
  name: 'test-repo-swe',
  defaultBranch: 'main',
  archived: false,
  ...overrides,
})

const failed = (overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
  name: 'CI',
  conclusion: 'failure',
  headBranch: 'main',
  headRepositoryId: 1420341093,
  ...overrides,
})

type Fake = {
  installations?: AppInstallation[]
  repos?: Record<number, InstallationRepository[] | Error>
  heads?: Record<string, { headSha: string; runs: WorkflowRunSummary[] } | null | Error>
  prs?: Record<number, { state: string; merged: boolean }>
}

function fakeGithub(fake: Fake): SyncGitHub & { headCalls: string[] } {
  const headCalls: string[] = []
  return {
    headCalls,
    async listInstallations() {
      return fake.installations ?? [installation()]
    },
    async listInstallationRepositories(installationId) {
      const listed = fake.repos?.[Number(installationId)] ?? [repo()]
      if (listed instanceof Error) throw listed
      return listed
    },
    async headWorkflowRuns({ owner, name }) {
      headCalls.push(`${owner}/${name}`)
      const head = fake.heads?.[`${owner}/${name}`]
      if (head instanceof Error) throw head
      return head === undefined ? { headSha: RED, runs: [failed()] } : head
    },
    async pullRequestState({ prNumber }) {
      return fake.prs?.[prNumber] ?? { state: 'open', merged: false }
    },
  }
}

function memoryStore(review: ReviewRun[] = []) {
  const webhooks = createMemoryWebhookStore()
  const finished = new Map<string, string>()
  const store: SyncStore & { finished: Map<string, string> } = {
    finished,
    transaction: (callback) => callback(store),
    upsertInstallation: (input) => webhooks.upsertInstallation(input),
    upsertRepository: (input) => webhooks.upsertRepository(input),
    createQueuedRun: (input) => webhooks.createQueuedRun(input),
    recordAudit: (runId, eventType, payload) => webhooks.recordAudit(runId, eventType, payload),
    async awaitingReview() {
      return review.filter((run) => !finished.has(run.runId))
    },
    async finishReview(runId, status) {
      if (finished.has(runId)) return false
      finished.set(runId, status)
      return true
    },
  }
  return { store, webhooks }
}

let counter = 0
const ids = () => `run-${(counter += 1)}`

describe('GitHub sync', () => {
  it('binds an installation the webhook never delivered, with its account id', async () => {
    const { store, webhooks } = memoryStore()
    const report = await syncGithub(
      fakeGithub({ heads: { 'vaishcodescape/test-repo-swe': null } }),
      store,
      ids,
    )
    assert.strictEqual(report.installations, 1)
    assert.strictEqual(report.repositories, 1)
    assert.deepStrictEqual(webhooks.boundRepoIds, [1420341093])
    assert.strictEqual(webhooks.boundInstallations[0]?.accountGithubId, 99)
  })

  it('queues one heal for a red default branch, keyed like the webhook', async () => {
    const { store, webhooks } = memoryStore()
    const report = await syncGithub(fakeGithub({}), store, () => 'run-red')
    assert.deepStrictEqual(report.queued, ['run-red'])
    assert.deepStrictEqual(webhooks.queuedRuns, [
      {
        runId: 'run-red',
        repositoryId: 'repository-1420341093',
        sourceSha: RED,
        idempotencyKey: `workflow_run:${RED}`,
      },
    ])
    assert.deepStrictEqual(webhooks.audits, [{ runId: 'run-red', eventType: 'run.queued' }])
  })

  it('does not queue the same commit twice across syncs', async () => {
    const { store, webhooks } = memoryStore()
    await syncGithub(fakeGithub({}), store, ids)
    const second = await syncGithub(fakeGithub({}), store, ids)
    assert.deepStrictEqual(second.queued, [])
    assert.strictEqual(webhooks.queuedRuns.length, 1)
  })

  it('does not heal a commit the webhook already queued', async () => {
    const webhooks = createMemoryWebhookStore()
    const service = createWebhookService({ store: webhooks })
    await service.processEvent('delivery-1', 'workflow_run', {
      action: 'completed',
      installation: { id: 171643878, account: { id: 99, login: 'vaishcodescape' } },
      repository: {
        id: 1420341093,
        name: 'test-repo-swe',
        full_name: 'vaishcodescape/test-repo-swe',
        default_branch: 'main',
        owner: { login: 'vaishcodescape' },
      },
      workflow_run: {
        conclusion: 'failure',
        head_sha: RED,
        head_branch: 'main',
        head_repository: { id: 1420341093 },
      },
    })
    assert.strictEqual(webhooks.queuedRuns.length, 1)

    const store: SyncStore = {
      transaction: (callback) => callback(store),
      upsertInstallation: (input) => webhooks.upsertInstallation(input),
      upsertRepository: (input) => webhooks.upsertRepository(input),
      createQueuedRun: (input) => webhooks.createQueuedRun(input),
      recordAudit: (runId, eventType, payload) => webhooks.recordAudit(runId, eventType, payload),
      awaitingReview: async () => [],
      finishReview: async () => false,
    }
    const report = await syncGithub(fakeGithub({}), store, ids)
    assert.deepStrictEqual(report.queued, [])
    assert.strictEqual(webhooks.queuedRuns.length, 1)
  })

  it('leaves green, running, other-branch and fork failures alone', async () => {
    const cases: { headSha: string; runs: WorkflowRunSummary[] }[] = [
      { headSha: GREEN, runs: [failed({ conclusion: 'success' })] },
      { headSha: GREEN, runs: [failed({ conclusion: null })] },
      { headSha: GREEN, runs: [] },
      { headSha: GREEN, runs: [failed({ headBranch: 'feature' })] },
      { headSha: GREEN, runs: [failed({ headBranch: 'adamant/run-1' })] },
      { headSha: GREEN, runs: [failed({ headRepositoryId: 5 })] },
      { headSha: GREEN, runs: [failed({ conclusion: 'cancelled' })] },
    ]
    for (const head of cases) {
      const { store, webhooks } = memoryStore()
      const report = await syncGithub(
        fakeGithub({ heads: { 'vaishcodescape/test-repo-swe': head } }),
        store,
        ids,
      )
      assert.deepStrictEqual(report.queued, [], JSON.stringify(head))
      assert.strictEqual(webhooks.queuedRuns.length, 0)
    }
  })

  it('heals when one of several workflows at the head failed', async () => {
    const { store } = memoryStore()
    const report = await syncGithub(
      fakeGithub({
        heads: {
          'vaishcodescape/test-repo-swe': {
            headSha: RED,
            runs: [failed({ name: 'lint', conclusion: 'success' }), failed({ name: 'test' })],
          },
        },
      }),
      store,
      ids,
    )
    assert.strictEqual(report.queued.length, 1)
  })

  it('skips suspended installations and does not check archived repositories', async () => {
    const { store, webhooks } = memoryStore()
    const github = fakeGithub({
      installations: [installation({ id: 1, suspended: true }), installation({ id: 2 })],
      repos: { 2: [repo({ id: 10, name: 'old', archived: true }), repo({ id: 11, name: 'live' })] },
      heads: { 'vaishcodescape/live': null },
    })
    const report = await syncGithub(github, store, ids)
    assert.strictEqual(report.installations, 1)
    assert.deepStrictEqual(webhooks.boundRepoIds, [10, 11])
    assert.deepStrictEqual(github.headCalls, ['vaishcodescape/live'])
  })

  it('keeps going when one repository or installation fails', async () => {
    const { store } = memoryStore()
    const report = await syncGithub(
      fakeGithub({
        installations: [installation({ id: 1 }), installation({ id: 2 })],
        repos: {
          1: new Error('GitHub GET /installation/repositories failed: 401'),
          2: [repo({ id: 20, name: 'broken' }), repo({ id: 21, name: 'red' })],
        },
        heads: {
          'vaishcodescape/broken': new Error('GitHub GET failed: 502'),
          'vaishcodescape/red': { headSha: RED, runs: [failed({ headRepositoryId: 21 })] },
        },
      }),
      store,
      () => 'run-after-errors',
    )
    assert.deepStrictEqual(report.queued, ['run-after-errors'])
    assert.deepStrictEqual(report.errors, [
      'installation 1: GitHub GET /installation/repositories failed: 401',
      'vaishcodescape/broken: GitHub GET failed: 502',
    ])
  })

  it('fails the task when GitHub will not list installations', async () => {
    const { store } = memoryStore()
    const github = fakeGithub({})
    github.listInstallations = async () => {
      throw new Error('GITHUB_APP_PRIVATE_KEY is not a PEM private key.')
    }
    await assert.rejects(syncGithub(github, store, ids), /not a PEM/)
  })

  it('settles PRs left for review: merged succeeds, closed aborts, open waits', async () => {
    const review = (runId: string, prNumber: number): ReviewRun => ({
      runId,
      owner: 'vaishcodescape',
      name: 'test-repo-swe',
      installationId: '171643878',
      prNumber,
    })
    const { store } = memoryStore([review('merged', 1), review('closed', 2), review('open', 3)])
    const github = fakeGithub({
      heads: { 'vaishcodescape/test-repo-swe': null },
      prs: {
        1: { state: 'closed', merged: true },
        2: { state: 'closed', merged: false },
        3: { state: 'open', merged: false },
      },
    })
    const report = await syncGithub(github, store, ids)
    assert.deepStrictEqual(report.reviewed, ['merged', 'closed'])
    assert.deepStrictEqual(Object.fromEntries(store.finished), {
      merged: 'succeeded',
      closed: 'aborted',
    })
    const again = await syncGithub(github, store, ids)
    assert.deepStrictEqual(again.reviewed, [])
  })
})
