<h1 align="center">Adamant</h1>

**A build goes red. Adamant works out why, proves a fix in a sealed container, opens a pull
request, and merges _that_ pull request.** It merges nothing else.

[![CI](https://github.com/vaishcodescape/adamant/actions/workflows/ci.yaml/badge.svg)](https://github.com/vaishcodescape/adamant/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)

Adamant is a GitHub App, an always-on backend, and a terminal. GitHub pushes an event the moment
a workflow fails; a worker diagnoses the failure, patches the code, and ships only once the
repository's own tests pass in a throwaway Docker container. It targets TypeScript repositories
on GitHub Actions, with a Python profile for the sandbox.

Written for the IT-314 software engineering course. [docs/product.md](docs/product.md) is the
full picture.

## How it works

```mermaid
flowchart LR
  Red[Failed workflow_run] -->|signed webhook| Api[API]
  Api -->|queued run + job| Pg[(PostgreSQL)]
  Pg -->|graph_step| Worker[Worker: heal agent]
  Worker --> Box[Sandbox container]
  Box -->|pass or fail| Worker
  Worker -->|push adamant/run_id, open PR, merge it| Gh[GitHub]
  Tui[adamant terminal] -. reads .-> Api
```

1. **Webhook.** A failed `workflow_run` on the default branch reaches `/webhooks/github`. The
   HMAC is checked and the delivery id stored, so a replay is acknowledged and never run twice.
2. **Queue.** The API inserts a `queued` run and one `graph_step` job. It never calls a model or
   Docker.
3. **Heal.** A worker claims the job and runs the graph with `thread_id = run_id`, so a worker
   that dies resumes from its checkpoint. The agent downloads only the failed jobs' logs, parses
   them in code, reads the files they name, and commits a candidate patch in a per-run worktree.
4. **Prove.** The sandbox installs with the network on, runs the tests with it off, and writes
   `pass` or `fail`. A fail goes back to diagnose, up to a capped number of attempts. Nothing is
   pushed yet.
5. **Ship.** On a pass, and only then, the agent pushes `refs/heads/adamant/{run_id}`, opens a PR
   that states cause, evidence, fix, what was verified and what was not, and merges that PR. In
   manual mode it leaves the PR open for a person.

Every tool call, model call and sandbox run is on `tool_invocations`, `audit_events` and
`sandbox_results`, keyed by run, with its timing.

## Quick start

You need Node.js 22.12+, pnpm 10+, Docker (Postgres and the sandbox), and a Rust toolchain
(`cargo`) for the terminal.

### Backend

```bash
pnpm install
cp .env.example .env                       # fill in what you need; the comments say which process reads each value
docker compose up -d postgres
DATABASE_URL=postgres://adamant:adamant@localhost:5432/adamant \
  pnpm --filter @adamant/server db:migrate
docker compose up                          # API on :8787, worker on the queue
```

`curl localhost:8787/health` answers `{"status":"ok"}`. The worker logs
`@adamant/worker connected and waiting for jobs` once it has the queue, and pulls the sandbox
image in the background so the first heal does not wait on the registry.

Without Compose, run the two processes in watch mode:

```bash
pnpm --filter @adamant/server dev          # API
pnpm --filter @adamant/server dev:worker   # worker
```

GitHub needs a public URL for the webhook. Host the API, or set `ADAMANT_WEBHOOK_PROXY_URL` to a
smee.io channel and let the launcher below forward it. Creating and subscribing the App is in
[docs/product.md](docs/product.md#how-the-github-app-works).

### Terminal

`tui/` is the `adamant` terminal: a Rust client of the API that follows heals live, installs the
App on repositories you pick, and runs a Codex-style coding agent on your checkout in `auto` or
`manual` approval mode (Shift+Tab switches). It holds your session and your own `OPENAI_API_KEY`;
it never receives a GitHub credential and cannot merge a pull request.

```bash
./scripts/adamant install      # once: link `adamant` into a directory on PATH
adamant                        # start the local API and worker, then open the terminal
adamant down                   # stop the API and worker the launcher started
```

`pnpm adamant [command]` runs the terminal alone against an API that is already up. The
launcher logs to `.adamant/logs/`.

Sign in with `/login` when GitHub OAuth is configured on the API. Otherwise mint a session; the
token is printed once, only its hash is stored, and it lasts 30 days:

```bash
export ADAMANT_SESSION=$(pnpm --silent --filter @adamant/server session:create)
```

Type `/` in the terminal for the commands: `/status`, `/login`, `/me`, `/repos`, `/install`,
`/runs`, `/run <id>`, `/watch`, `/trigger <repository> <sha>`, `/help`. `?` on an empty prompt
lists the shortcuts. `status` checks the session as well as the API, so start there when
something else fails.

### Checks

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm format:check && pnpm build
```

Exactly what CI runs.

## Configuration

Secrets are split by process on purpose: the API can verify a webhook but cannot call a model or
touch a repository, and the worker does the work but never sees a user session.

| Variable                                                 | Read by     | What it is                                                                                                                           |
| -------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                           | API, worker | Postgres connection string                                                                                                           |
| `PORT`                                                   | API         | HTTP port, default `8787`                                                                                                            |
| `GITHUB_WEBHOOK_SECRET`                                  | API         | HMAC on every delivery; a bad signature is a 401 and stores nothing                                                                  |
| `GITHUB_APP_SLUG`                                        | API         | Public App slug for the install URL; not a credential                                                                                |
| `GITHUB_OAUTH_CLIENT_ID`, `_SECRET`, `_REDIRECT_URI`     | API         | Enables `/auth/github` and `/login`; all three or the provider stays off                                                             |
| `GOOGLE_OAUTH_CLIENT_ID`, `_SECRET`, `_REDIRECT_URI`     | API         | Same, for `/auth/google`                                                                                                             |
| `OPENAI_API_KEY`, `OPENAI_MODEL`                         | Worker      | Model calls happen here only, never in the API or the Electron shell                                                                 |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`                | Worker      | Installation tokens are minted on demand, held in worker memory only, and stored nowhere                                             |
| `ADAMANT_SANDBOX_IMAGE`, `_INSTALL`, `_TEST`, `_PROFILE` | Worker      | What the sandbox runs; `_PROFILE=fixed` turns off Python detection                                                                   |
| `ADAMANT_HEAL_AGENT`                                     | Worker      | `agents` (default: explores the checkout and tries fixes) or `classic`                                                               |
| `ADAMANT_WORKER_CONCURRENCY`, `ADAMANT_WORKSPACE_ROOT`   | Worker      | Heals in flight per process; where run worktrees live                                                                                |
| `ADAMANT_SANDBOX_CACHE_ROOT`, `_MAX_AGE_DAYS`            | Worker      | Package caches, one per repository; default under the workspace root, `none` turns them off; idle ones go after `_MAX_AGE_DAYS` (14) |
| `ADAMANT_API_URL`, `ADAMANT_SESSION`                     | Terminal    | Hosted API origin and session                                                                                                        |
| `ADAMANT_WEBHOOK_PROXY_URL`                              | Launcher    | smee.io channel forwarded to the local API                                                                                           |

`.env.example` lists every value with the same notes.

## HTTP API

| Route                               | Auth                  | Does                                              |
| ----------------------------------- | --------------------- | ------------------------------------------------- |
| `GET /health`                       | none                  | Liveness                                          |
| `POST /webhooks/github`             | `X-Hub-Signature-256` | Store the delivery; a failed build starts one run |
| `GET /auth/{github,google}`         | none, rate-limited    | Browser sign-in                                   |
| `POST /auth/github/cli/*`           | none, rate-limited    | Terminal sign-in confirmed in the browser         |
| `GET /auth/me`, `POST /auth/logout` | session               | Current user; revoke the session                  |
| `POST /runs`                        | session               | Start a run; needs an `Idempotency-Key`           |
| `GET /runs`, `GET /runs/:id`        | session               | List runs; one run with its audit trail           |
| `GET /activity`                     | session               | Server-Sent Events feed for `/watch`              |
| `GET /github/install`               | session               | Public install URL; 503 without the slug          |
| `GET /github/installations/status`  | session               | Whether that owner/name is a bound repository     |

A session arrives as `Authorization: Bearer` or the `adamant_session` cookie, never in the URL.
Postgres stores its SHA-256 only. `/activity` LISTENs on Postgres, so a new row reaches the
terminal in milliseconds, with a one-second poll as the fallback.

## Commands

| Command                       | What it does                              |
| ----------------------------- | ----------------------------------------- |
| `pnpm test`                   | Node's test runner over `tests/`          |
| `pnpm typecheck`, `pnpm lint` | `tsc --noEmit`; ESLint                    |
| `pnpm format:check`           | Prettier                                  |
| `pnpm build`                  | Production bundles for every package      |
| `pnpm dev`                    | Electron shell with Vite and watch builds |
| `pnpm adamant [command]`      | The terminal                              |
| `pnpm package`                | Desktop installers in `release/`          |

Backend scripts run through `pnpm --filter @adamant/server <script>`: `dev` / `start` (API),
`dev:worker` / `start:worker`, `db:generate`, `db:migrate`, `db:studio`, and
`session:create [username]`.

## Layout

```
contract/          @adamant/contract: zod schemas shared by API and worker
server/            @adamant/server: one package.json, one tsconfig.json
  api/             Hono: webhooks, auth, runs, activity
  db/              Drizzle schema and migrations
  worker/          graphile-worker: graph_step, GitHub sync, sandbox warm-up
  agent/           heal graph, model steps and tools; no HTTP
  sandbox/         Docker runner
tui/               adamant terminal (Rust, ratatui)
electron/          desktop shell (main, preload, renderer, shared types)
tests/             node:test suites, one folder per area
docs/              design docs
scripts/adamant    local API + worker, then the terminal
.agents/skills/    task instructions for coding agents
```

`server/api` does not import `server/agent`, and `server/agent` does not import Hono. The
worker is the only process that holds both.

## Safety rails

These are invariants, not defaults. [AGENTS.md](AGENTS.md) is the version reviewers check against.

- The agent pushes exactly one ref, `refs/heads/adamant/{run_id}`. No force-push, no push to a
  default branch. The adapter sets the refspec; the model does not.
- It may merge only the PR that run opened, and only after reading a passing `sandbox_results`
  row back from the table. Push and open-PR use the same gate.
- Every tool is allowlisted and logged with its `run_id`. Unknown calls fail closed.
- GitHub installation tokens are minted on demand, reused only from worker memory until shortly
  before they expire, and kept out of the terminal, checkpoints, prompts, logs, the database and
  the sandbox.
- The sandbox runs one container per command and destroys it: network off during tests, no
  Docker socket, dropped capabilities, read-only `.git`, and memory, CPU, PID and time limits.
- The Electron renderer is untrusted: context isolation, no Node integration, a typed bridge
  with every argument validated in main, and no direct calls to the backend.

Infra failures, missing secrets and flakes are reported and the run stops. Tests are never
weakened to get a green build.

## Docs

| Doc                                                          | Covers                              |
| ------------------------------------------------------------ | ----------------------------------- |
| [docs/product.md](docs/product.md)                           | What we're building, and for whom   |
| [docs/tasks.md](docs/tasks.md)                               | Task list                           |
| [docs/backend-architecture.md](docs/backend-architecture.md) | API, worker, agent, GitHub, sandbox |
| [docs/database.md](docs/database.md)                         | Postgres schema                     |
| [docs/db-and-worker-setup.md](docs/db-and-worker-setup.md)   | Running the backend locally         |
| [docs/tech-stack.md](docs/tech-stack.md)                     | Stack, and why each piece           |
| [docs/performance.md](docs/performance.md)                   | Speed rules for the run path        |
| [docs/glossary.md](docs/glossary.md)                         | Words the other docs use            |
| [CONTRIBUTING.md](CONTRIBUTING.md)                           | Branches, commits, review, merge    |
| [AGENTS.md](AGENTS.md)                                       | Rules for agents and reviewers      |

## Why "Adamant"?

Wolverine's adamantium skeleton makes him nearly indestructible. It also slowly poisons him.

AI carries the same contradiction. It makes us feel superhuman, and if we lean on it for every
answer it quietly weakens what it was meant to strengthen: independent thought, curiosity,
problem-solving. The name is a reminder that every powerful tool has a cost when used without
restraint.

**Use the power. Don't let the power use you.**

## Contributing

Branch from `main` as `feat/…`, `fix/…`, `docs/…` or `chore/…`. Never commit to `main`, and
leave `adamant/*` to the agent. Run the checks above, then open a PR with the template.
[CONTRIBUTING.md](CONTRIBUTING.md) has the review and merge flow. Claude Code, Cursor and Codex
read [AGENTS.md](AGENTS.md) and `.agents/skills/`; you still own what you submit.

## License

[MIT](LICENSE) © vaishcodescape
