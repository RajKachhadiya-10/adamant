import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createMemoryWebhookStore,
  type DeliveryInput,
  type InstallationInput,
  type QueuedRunInput,
  type RepositoryInput,
} from '../../server/api/services/webhookStore.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstallation(overrides: Partial<InstallationInput> = {}): InstallationInput {
  return {
    githubInstallationId: 10,
    accountLogin: 'acme',
    accountType: 'Organization',
    ...overrides,
  }
}

function makeRepo(overrides: Partial<RepositoryInput> = {}): RepositoryInput {
  return {
    installationId: 'installation-10',
    githubRepoId: 200,
    owner: 'acme',
    name: 'eval',
    defaultBranch: 'main',
    ...overrides,
  }
}

function makeDelivery(overrides: Partial<DeliveryInput> = {}): DeliveryInput {
  return {
    deliveryId: 'delivery-abc',
    eventType: 'push',
    installationId: 'installation-10',
    repositoryId: 'repository-200',
    payloadDigest: 'deadbeef',
    ...overrides,
  }
}

function makeRun(overrides: Partial<QueuedRunInput> = {}): QueuedRunInput {
  return {
    runId: 'run-001',
    repositoryId: 'repository-200',
    sourceSha: 'abc123',
    idempotencyKey: 'idem-001',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createMemoryWebhookStore', () => {
  // 1. upsertInstallation — returns a deterministic id on first call
  it('upsertInstallation returns a deterministic id on the first call', async () => {
    const store = createMemoryWebhookStore()
    const id = await store.upsertInstallation(makeInstallation({ githubInstallationId: 42 }))

    assert.equal(id, 'installation-42')
  })

  // 2. upsertInstallation — idempotent: same githubInstallationId returns the same id
  it('upsertInstallation returns the same id for the same githubInstallationId', async () => {
    const store = createMemoryWebhookStore()
    const first = await store.upsertInstallation(makeInstallation({ githubInstallationId: 42 }))
    const second = await store.upsertInstallation(makeInstallation({ githubInstallationId: 42 }))

    assert.equal(first, second)
  })

  // 3. upsertInstallation — pushes to boundInstallations on every call, even repeated ones
  it('upsertInstallation appends to boundInstallations on every call', async () => {
    const store = createMemoryWebhookStore()
    const input = makeInstallation({ githubInstallationId: 42 })
    await store.upsertInstallation(input)
    await store.upsertInstallation(input)

    // boundInstallations records every call — the Map handles idempotency separately
    assert.equal(store.boundInstallations.length, 2)
    assert.deepEqual(store.boundInstallations[0], input)
    assert.deepEqual(store.boundInstallations[1], input)
  })

  // 4. upsertRepository — returns a deterministic id on first call
  it('upsertRepository returns a deterministic id on the first call', async () => {
    const store = createMemoryWebhookStore()
    const id = await store.upsertRepository(makeRepo({ githubRepoId: 300 }))

    assert.equal(id, 'repository-300')
  })

  // 5. upsertRepository — idempotent: same githubRepoId returns the same id
  it('upsertRepository returns the same id for the same githubRepoId', async () => {
    const store = createMemoryWebhookStore()
    const first = await store.upsertRepository(makeRepo({ githubRepoId: 300 }))
    const second = await store.upsertRepository(makeRepo({ githubRepoId: 300 }))

    assert.equal(first, second)
  })

  // 6. upsertRepository — boundRepoIds de-duplicates on repeated calls
  it('upsertRepository adds to boundRepoIds only once per githubRepoId', async () => {
    const store = createMemoryWebhookStore()
    await store.upsertRepository(makeRepo({ githubRepoId: 300 }))
    await store.upsertRepository(makeRepo({ githubRepoId: 300 }))

    assert.equal(store.boundRepoIds.length, 1)
    assert.equal(store.boundRepoIds[0], 300)
  })

  // 7. recordDelivery — returns true on first call, false on duplicate deliveryId
  it('recordDelivery returns true the first time and false for a duplicate deliveryId', async () => {
    const store = createMemoryWebhookStore()
    const input = makeDelivery({ deliveryId: 'dlv-1' })

    const first = await store.recordDelivery(input)
    const second = await store.recordDelivery(input)

    assert.equal(first, true)
    assert.equal(second, false)
  })

  // 8. recordDelivery — stores the full delivery on first call only
  it('recordDelivery stores the delivery input on first call only', async () => {
    const store = createMemoryWebhookStore()
    const input = makeDelivery({ deliveryId: 'dlv-2' })

    await store.recordDelivery(input)
    await store.recordDelivery({ ...input, eventType: 'pull_request', payloadDigest: 'cafe' })

    assert.deepEqual(store.deliveries.get('dlv-2'), input)
    assert.equal(store.deliveries.size, 1)
  })

  // 9. createQueuedRun — returns the runId on first call, null for duplicate idempotencyKey
  it('createQueuedRun returns runId the first time and null for a duplicate idempotencyKey', async () => {
    const store = createMemoryWebhookStore()
    const input = makeRun({ idempotencyKey: 'idem-x', runId: 'run-x' })

    const first = await store.createQueuedRun(input)
    const second = await store.createQueuedRun({ ...input, runId: 'run-x2' })

    assert.equal(first, 'run-x')
    assert.equal(second, null)
    // The duplicate is not queued or enqueued under its own run id either.
    assert.deepEqual(store.enqueuedRuns, ['run-x'])
    assert.equal(store.queuedRuns.length, 1)
  })

  // 10. createQueuedRun — populates queuedRuns and enqueuedRuns on first call
  it('createQueuedRun populates queuedRuns and enqueuedRuns', async () => {
    const store = createMemoryWebhookStore()
    const input = makeRun({ idempotencyKey: 'idem-y', runId: 'run-y' })

    await store.createQueuedRun(input)

    assert.equal(store.queuedRuns.length, 1)
    assert.deepEqual(store.queuedRuns[0], input)
    assert.equal(store.enqueuedRuns.length, 1)
    assert.equal(store.enqueuedRuns[0], 'run-y')
  })

  // 11. findRunByPullRequest — returns the seeded runId; returns null for unknown key
  it('findRunByPullRequest returns the seeded runId and null for an unknown key', async () => {
    const store = createMemoryWebhookStore()
    // publishedPrs is seeded by callers; the store provides read-only lookup
    store.publishedPrs.set('repository-200#42', 'run-seeded')

    const found = await store.findRunByPullRequest('repository-200', 42)
    const missing = await store.findRunByPullRequest('repository-200', 99)

    assert.equal(found, 'run-seeded')
    assert.equal(missing, null)
  })

  // 12. markRunSucceeded — sets the run status to 'succeeded' in runStatuses
  it('markRunSucceeded records the run status as succeeded', async () => {
    const store = createMemoryWebhookStore()

    await store.markRunSucceeded('run-z')

    assert.equal(store.runStatuses.get('run-z'), 'succeeded')
  })

  // 13. recordAudit — appends { runId, eventType } to the audits array
  it('recordAudit appends the correct shape to the audits array', async () => {
    const store = createMemoryWebhookStore()

    await store.recordAudit('run-a', 'run.queued', { sourceSha: 'abc' })
    await store.recordAudit(null, 'webhook.received', {})

    assert.equal(store.audits.length, 2)
    assert.deepEqual(store.audits[0], { runId: 'run-a', eventType: 'run.queued' })
    assert.deepEqual(store.audits[1], { runId: null, eventType: 'webhook.received' })
  })

  // 14. transaction — executes the callback with the store and returns the callback's value
  it('transaction passes the store to the callback and returns its result', async () => {
    const store = createMemoryWebhookStore()

    const result = await store.transaction(async (txStore) => {
      // Verify the callback receives the same store instance
      assert.equal(txStore, store)
      return 'sentinel'
    })

    assert.equal(result, 'sentinel')
  })
})
