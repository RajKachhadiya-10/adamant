import { describe, it } from 'node:test'
import * as assert from 'node:assert'
import { installationProblems, webhookProblems } from '../../server/worker/doctor.ts'
import { type AppInstallation } from '../../server/worker/github.ts'

const healthy = {
  url: 'https://smee.io/AppChannelExample',
  hasSecret: true,
  events: ['workflow_run', 'pull_request'],
  permissions: { contents: 'write', pull_requests: 'write', actions: 'read', metadata: 'read' },
}

describe('GitHub App webhook doctor', () => {
  it('finds nothing wrong when the App sends signed events to the forwarded channel', () => {
    assert.deepStrictEqual(
      webhookProblems(healthy, { ADAMANT_WEBHOOK_PROXY_URL: 'https://smee.io/AppChannelExample' }),
      [],
    )
  })

  it('names both channels when the App sends somewhere this machine does not forward', () => {
    const [problem] = webhookProblems(healthy, {
      ADAMANT_WEBHOOK_PROXY_URL: 'https://smee.io/LocalChannelExample',
    })
    assert.match(problem ?? '', /sends webhooks to https:\/\/smee.io\/AppChannelExample/)
    assert.match(problem ?? '', /forwards https:\/\/smee.io\/LocalChannelExample/)
  })

  it('reads a quoted .env value the way the launcher does', () => {
    assert.deepStrictEqual(
      webhookProblems(healthy, {
        ADAMANT_WEBHOOK_PROXY_URL: '"https://smee.io/AppChannelExample"',
      }),
      [],
    )
  })

  it('does not compare channels on a hosted API that forwards nothing', () => {
    assert.deepStrictEqual(
      webhookProblems({ ...healthy, url: 'https://api.example.com/webhooks/github' }, {}),
      [],
    )
  })

  it('says an unsigned App would have every delivery rejected', () => {
    const problems = webhookProblems({ ...healthy, hasSecret: false }, {})
    assert.strictEqual(problems.length, 1)
    assert.match(problems[0] ?? '', /no webhook secret/)
  })

  it('reports a missing URL and a missing workflow_run subscription', () => {
    const problems = webhookProblems({ ...healthy, url: null, events: ['pull_request'] }, {})
    assert.strictEqual(problems.length, 2)
    assert.match(problems[0] ?? '', /no webhook URL/)
    assert.match(problems[1] ?? '', /not subscribed to workflow_run/)
  })

  it('says which permission a heal would fail on, as the App is set up today', () => {
    const problems = webhookProblems(
      {
        ...healthy,
        permissions: { actions: 'read', metadata: 'read', pull_requests: 'write' },
      },
      {},
    )
    assert.deepStrictEqual(problems, [
      'The GitHub App cannot push the fix branch or merge: it has Contents: no access. Give it Contents: Read and write under Permissions, then accept the change on each installation.',
    ])
  })

  it('accepts write where read is enough', () => {
    assert.deepStrictEqual(
      webhookProblems(
        { ...healthy, permissions: { ...healthy.permissions, actions: 'write' } },
        {},
      ),
      [],
    )
  })

  it('names an installation that has not accepted the permissions a heal needs', () => {
    const installation = (overrides: Partial<AppInstallation>): AppInstallation => ({
      id: 171643878,
      accountLogin: 'vaishcodescape',
      accountType: 'User',
      accountId: 1,
      suspended: false,
      permissions: { contents: 'write', pull_requests: 'write', actions: 'read' },
      ...overrides,
    })
    assert.deepStrictEqual(
      installationProblems([
        installation({
          permissions: { actions: 'read', metadata: 'read', pull_requests: 'write' },
        }),
        installation({ id: 2, accountLogin: 'acme', accountType: 'Organization', permissions: {} }),
        installation({ id: 3, suspended: true, permissions: {} }),
        installation({ id: 4 }),
      ]),
      [
        "The installation on vaishcodescape has not granted Contents: write, so heals there fail. Approve the App's updated permissions at https://github.com/settings/installations/171643878",
        "The installation on acme has not granted Contents: write, Pull requests: write, Actions: read, so heals there fail. Approve the App's updated permissions at https://github.com/organizations/acme/settings/installations/2",
      ],
    )
  })
})
