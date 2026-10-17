# Performance

Time goes to installs, tests, model calls, and waiting on people — not to Hono
vs Fastify.

The run path needs the items below. Local mode, fingerprints, desktop
notifications, and parallel candidate patches are later.

## Run path

- Parse the CI log in code first (first error, `file:line`, test names). Do
  not send the raw dump to the model.
- Download only the failed jobs' logs.
- Push `adamant/{run_id}` **once**, after the sandbox passes — not on every
  attempt.
- Cap `diagnose_attempts`.
- While retrying, run only the failing tests; run the full suite once before
  merge. `focusTestCommand` turns the parsed test names into a run of just
  those tests for vitest, jest, mocha, `node --test` and pytest. A retry (and
  every `try_patch` of the fixer) runs that first; only when it passes does
  the full suite run, and only the full suite can say `pass`.
- Mint an installation token once per installation and reuse it from worker
  memory until shortly before it expires. A heal made five mints; the GitHub
  sync made one per repository per minute.
- Prefer a worktree at the failing SHA over `git clone` every run (a mirror
  can wait if it slows you down).
- Overlap waits on different hosts. The checkout (the repository) and the
  failed-job logs (the Actions API) are fetched together in `retrieveNode`.
- Pull the sandbox image when the worker boots, not when the first heal does
  (`warmSandboxImage`). A failed pull only means `docker run` pulls later.

## Targets (revise when we have timings)

| Measure                          | Target  |
| -------------------------------- | ------- |
| Job picked up after trigger      | < 1 s   |
| Verified fix, cloud (warm image) | < 3 min |

## Cloud loop

`graphile-worker` uses `LISTEN/NOTIFY`, so keep a worker running.

**Code:** one bare mirror per repo if you have time; per run `git fetch` +
`git worktree add --detach`. Evict unused mirrors when disk is low.

**Install cache:** one directory per repository under the workspace root
(`ADAMANT_SANDBOX_CACHE_ROOT`), mounted at `/adamant-cache` into the install
container only, with npm, pnpm, yarn and pip pointed at it. A warm install
reads from disk and the registry only confirms. It is scoped per repository
so one repository's install never reads what another's wrote, and a cache no
install has touched for `ADAMANT_SANDBOX_CACHE_MAX_AGE_DAYS` (14) is removed
when the worker boots. A lockfile-tagged image can still come later. Tests
run with the network off and without the mount.

### Model calls

Official `openai` SDK, `OPENAI_API_KEY` in the worker only.

- One model (`OPENAI_MODEL`, default GPT-6). Effort `low` to sort the
  failure, `high` to write the patch.
- Keep the prompt prefix stable (tools, system, repo). Put run IDs and log
  lines after it. `prompt_cache_key` is a digest of that prefix, so every
  step and attempt of a run lands on the same cache and nothing from the run
  itself is sent as the key.
- Every call is a `model.call` audit event with `step`, `effort`,
  `durationMs` and `usage.{input,cached,output,reasoning}`. `cached` is the
  prompt-cache hit; a drop after a prompt change is the first thing to check.
  With the Agents SDK steps, each agent run is one `agent.run` event with
  `requests` and the same `usage` summed over its calls, and its
  `prompt_cache_key` is the same digest.
- One SDK client per key per process. Its connections stay open across runs.
- Edit with apply-patch / str-replace. Do not rewrite whole files.
- When the model asks for several tools, run them concurrently.

## Timings

Where a heal's time went is in the tables, per run:

| Step             | Where                                                          |
| ---------------- | -------------------------------------------------------------- |
| Each tool call   | `tool_invocations.started_at` / `finished_at`                  |
| Each model call  | `audit_events` `model.call` (`durationMs`, `usage`)            |
| Each agent run   | `audit_events` `agent.run` (`requests`, `durationMs`, `usage`) |
| Each sandbox run | `sandbox_results.started_at` / `finished_at` (install + test)  |

## Later

Local mode (same `server/agent` on the developer's checkout; model calls
through the API). Failure fingerprints. `/adamant approve`. Parallel
candidate patches. A timing UI over the rows above. A lockfile-tagged image.
Cache eviction by disk pressure (today it is by age, at boot).

## Checklist for changes to the run path

Use this when reviewing worker, agent, or sandbox code. The
`performance-review` skill applies it.

- [ ] Failed-job logs only; parsed before the model
- [ ] Edits via apply-patch / str-replace
- [ ] Parallel tool results in one message
- [ ] Targeted tests during retries (the parser's `failingTests` reach the
      sandbox as `focus`; a new runner needs its flag in `focus.ts`)
- [ ] Push only after the sandbox passes
- [ ] No fresh `git clone` per run if a mirror already exists
- [ ] Independent waits (checkout and logs, rows that do not depend on each
      other) run together, not one after another
- [ ] A new step records how long it took (`model.call`, `sandbox_results`,
      `tool_invocations`)
