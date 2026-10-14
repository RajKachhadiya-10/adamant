# Product

When CI goes red, Adamant proves a fix in a sandbox, opens a PR, and **merges
that PR**. It targets TypeScript repositories on GitHub Actions.

You use it in two places:

| Where            | What it is                            | What you see                                                        |
| ---------------- | ------------------------------------- | ------------------------------------------------------------------- |
| **GitHub**       | A GitHub App (the plugin) on the repo | Always on. Failed checks start a heal. Merged PRs are recorded.     |
| **Your machine** | A CLI                                 | Stays connected to the **hosted** API. `adamant watch` is the feed. |

The App does **not** run inside GitHub. You install it on the repo; the
**hosted** API and worker stay up and GitHub **pushes events** to them.
That is the continuous check — not a poll loop. The CLI does not run the
agent. It only reads the hosted backend.

How to build it: [tasks.md](tasks.md). Wiring:
[backend-architecture.md](backend-architecture.md).

## How the GitHub App works

1. Create a GitHub App. Install it on the eval repo (contents + PRs + Actions).
2. Subscribe to `workflow_run` and `pull_request`. Webhook URL → the
   **hosted** API (`/webhooks/github`). Use smee/ngrok only when developing
   the API on a laptop.
3. Host API + worker + Postgres and leave them running.
4. On **failed** `workflow_run` → create a run, heal, merge **our** PR.
5. On **merged** `pull_request` → if it is our heal, mark the run `succeeded`.
   If it is any other merge, store the delivery so the CLI can show it.
   A merge alone does **not** start a heal.

Tokens: mint an installation token per GitHub call. Never store it.

## How the CLI works

`@adamant/cli` is a thin client of the **hosted** API. Set
`ADAMANT_API_URL` to that origin and a seeded session
(`ADAMANT_SESSION`). No OpenAI key. No GitHub token. Healing stays on the
server.

```
adamant status              # hosted API up?
adamant runs                # list runs
adamant run <id>            # one run + audit
adamant watch               # stay connected: live feed
```

`watch` opens a long-lived SSE (or reconnecting poll) to
`GET /activity` on the hosted API. Close the terminal and the backend
keeps running; open `watch` again and you are back on the same feed.

Electron stays a shell. Heal-from-the-desktop is later.

## Rules

- Push only `refs/heads/adamant/{run_id}`. No force-push. No push to `main`.
- Merge **only** the PR this run opened, after `sandbox_results.verdict = pass`.
- Allowlisted tools, logged with `run_id`. Unknown tools fail closed.
- Do not weaken tests. Infra / secrets / flakes: report and stop.

PR body: **cause**, **evidence**, **fix**, **verified**, **not checked**.

## Later

Electron Heal / inbox / OAuth, HITL before merge, agent-on-your-checkout,
fingerprints, `.adamant.yml`, Dependabot replay.

| When  | Ships                                                       |
| ----- | ----------------------------------------------------------- |
| Done  | Electron shell and this repo’s CI.                          |
| Now   | App, always-on worker, CLI monitor, one heal **and merge**. |
| Later | Desktop Heal, OAuth, optional HITL.                         |
