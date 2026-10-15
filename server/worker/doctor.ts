import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createGitHubClient,
  privateKeyProblem,
  readGitHubAppConfig,
  type AppInstallation,
  type AppWebhook,
} from './github.ts'

/**
 * What stops GitHub's webhooks from reaching this API, read from the App's own
 * settings. Each of these failed silently before: GitHub reports a delivery to a
 * smee channel as 200 OK whether or not anything forwards it, and an unsigned
 * delivery dies as a 401 in the API log. The sync still heals without webhooks;
 * these only cost the instant updates.
 */
export function webhookProblems(webhook: AppWebhook, env = process.env): string[] {
  const problems: string[] = []
  const forwarded = env.ADAMANT_WEBHOOK_PROXY_URL?.trim().replace(/^"|"$/g, '')
  if (!webhook.url) {
    problems.push('The GitHub App has no webhook URL; heals start only from the minute sync.')
  } else if (forwarded && webhook.url !== forwarded) {
    problems.push(
      `The GitHub App sends webhooks to ${webhook.url}, but this machine forwards ${forwarded}. Set ADAMANT_WEBHOOK_PROXY_URL to the App's URL, or point the App's webhook at this channel.`,
    )
  }
  if (!webhook.hasSecret) {
    problems.push(
      "The GitHub App has no webhook secret, so GitHub signs nothing and the API rejects every delivery. Set the App's webhook secret to GITHUB_WEBHOOK_SECRET.",
    )
  }
  for (const [label, level, why] of missing(webhook.permissions)) {
    problems.push(
      `The GitHub App cannot ${why}: it has ${label}: ${webhook.permissions[key(label)] ?? 'no access'}. Give it ${label}: ${level === 'write' ? 'Read and write' : 'Read-only'} under Permissions, then accept the change on each installation.`,
    )
  }
  if (!webhook.events.includes('workflow_run')) {
    problems.push(
      'The GitHub App is not subscribed to workflow_run; red builds are found only by the minute sync.',
    )
  }
  return problems
}

// A heal pushes its branch and merges (contents), opens its PR (pull_requests) and reads
// the failed jobs' logs (actions). Without one it fails at that step, late.
const NEEDED: readonly [label: string, level: 'read' | 'write', why: string][] = [
  ['Contents', 'write', 'push the fix branch or merge'],
  ['Pull requests', 'write', 'open the PR'],
  ['Actions', 'read', "read the failed jobs' logs"],
]

function key(label: string): string {
  return label.toLowerCase().replace(' ', '_')
}

function missing(granted: Readonly<Record<string, string>>) {
  return NEEDED.filter(([label, level]) => {
    const has = granted[key(label)]
    return has !== 'write' && has !== level
  })
}

/**
 * Installations that have not accepted what a heal needs. Changing the App's
 * permissions only asks each account; until someone approves, its tokens keep the old
 * ones and the heal fails at the push with a 403.
 */
export function installationProblems(installations: readonly AppInstallation[]): string[] {
  const problems: string[] = []
  for (const installation of installations) {
    if (installation.suspended) continue
    const gaps = missing(installation.permissions)
    if (gaps.length === 0) continue
    const settings =
      installation.accountType === 'Organization'
        ? `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.id}`
        : `https://github.com/settings/installations/${installation.id}`
    const names = gaps.map(([label, level]) => `${label}: ${level}`).join(', ')
    problems.push(
      `The installation on ${installation.accountLogin} has not granted ${names}, so heals there fail. Approve the App's updated permissions at ${settings}`,
    )
  }
  return problems
}

/** Everything wrong with the App setup, or [] when webhooks should flow. */
export async function appProblems(env = process.env): Promise<string[]> {
  const config = readGitHubAppConfig(env)
  if (!config) return ['GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are not set.']
  const keyProblem = privateKeyProblem(config.privateKey)
  if (keyProblem) return [keyProblem]
  const github = createGitHubClient(config)
  const [webhook, installations] = await Promise.all([
    github.appWebhook(),
    github.listInstallations(),
  ])
  return [...webhookProblems(webhook, env), ...installationProblems(installations)]
}

function isDirectRun() {
  const entry = process.argv[1]
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry ?? '')).href
}

// `scripts/adamant` runs this before the terminal starts and prints what it finds.
if (isDirectRun()) {
  appProblems()
    .then((problems) => {
      for (const problem of problems) console.error(`adamant: ${problem}`)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`adamant: could not read the GitHub App's webhook settings: ${message}`)
    })
}
