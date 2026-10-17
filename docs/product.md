# Product

When CI goes red, Adamant proves a fix in a sandbox, opens a PR, and **merges
that PR**. It targets TypeScript repositories on GitHub Actions.

You use it in two places:

| Where            | What it is                            | What you see                                                      |
| ---------------- | ------------------------------------- | ----------------------------------------------------------------- |
| **GitHub**       | A GitHub App (the plugin) on the repo | Always on. Failed checks start a heal. Merged PRs are recorded.   |
| **Your machine** | A CLI                                 | Follows the **hosted** API's heals live, and runs a coding agent. |

The App does **not** run inside GitHub. You install it on the repo; the
**hosted** API and worker stay up and GitHub **pushes events** to them.
That is the continuous check — not a poll loop. Heals run on the hosted
worker, never on the laptop. The CLI follows them, and its own agent works
on your checkout only when you ask it to.

How to build it: [tasks.md](tasks.md). Wiring:
[backend-architecture.md](backend-architecture.md).

## How the GitHub App works

1. Create a GitHub App. Install it on the eval repo (contents + PRs + Actions).
2. Subscribe to `workflow_run`, `pull_request`, `installation`, and
   `installation_repositories`. Webhook URL → the **hosted** API
   (`/webhooks/github`). Use smee/ngrok only when developing the API on a
   laptop. Adding a repository to an existing installation is an
   `installation_repositories` event with action `added`; that writes the
   `repositories` row. `removed` does not delete it.
3. Host API + worker + Postgres and leave them running.
4. On **failed** `workflow_run` → create a run, heal, merge **our** PR.
5. On **merged** `pull_request` → if it is our heal, mark the run `succeeded`.
   If it is any other merge, store the delivery so the CLI can show it.
   A merge alone does **not** start a heal.

Tokens: installation tokens are minted on demand and live only in the
worker's memory until shortly before they expire. Never store one.

## How the CLI works

The `adamant` terminal (`tui/`) talks to the **hosted** API. Set
`ADAMANT_API_URL` to that origin and give it a session: `/login` keeps one
in `~/.adamant/session`, or set a seeded one in `ADAMANT_SESSION`. No GitHub
token. Healing stays on the server.

Plain text is a prompt for the terminal's agent, as in Codex: it runs shell
commands, reads and edits files in the working directory, and calls the
hosted API (status, runs, repositories, start a heal). The model key is the
user's own (`OPENAI_API_KEY` or `~/.adamant/openai_key`); it goes to the model
API and nowhere else, and commands the agent runs do not inherit it.
Approvals are `auto` (the default) or `manual`, which asks before each
command, file write, or heal; shift-tab or `/auto` and `/manual` switch.
The mode is saved on the server too: in auto a heal merges its PR, in
manual it stops at an open PR for you to review and merge.

After `/login` (or on `/repos`) the terminal lists the user's GitHub
repositories through their own `gh` login, or only their public ones without
`gh`, since an App's user token sees only repositories the App is already on.
Enter opens GitHub's install page with the picks preselected and waits for
each one to be bound, by the webhook or, if that never arrives, by the
worker's GitHub sync within about a minute. From then on the terminal follows the feed by
itself: each heal shows as queued, started, sandbox verdicts, PR opened, and
merged.

```
adamant status              # hosted API up?
adamant install <owner>/<repo>  # open the App install page; wait until the repo is bound
adamant runs                # list runs
adamant run <id>            # one run + audit
adamant watch               # stay connected: live feed
```

`install` asks the hosted API for the public GitHub App URL and polls until
that exact repository is in Postgres. The CLI does not hold `GITHUB_APP_SLUG`,
a private key, or an installation token. Confirmation is the `repositories`
row, written by the webhook or by the worker's sync, which reads the App's
installations from GitHub (and finds red default branches the webhook
missed).

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
