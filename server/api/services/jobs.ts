import { sql } from 'drizzle-orm'
import { type Db } from '../../db/client.ts'

type Executor = Pick<Db, 'execute'>

/**
 * Queues the heal for a run. Call it inside the transaction that inserted the
 * run, so a run row never exists without its job.
 *
 * The payload is bound as one `::json` parameter. `json_build_object('runId',
 * $1)` cannot infer a type for `$1` (Postgres 42P18), which failed every insert.
 */
/**
 * Asks the worker to read installations and red builds from GitHub now, instead of at
 * the next scheduled sync. A pending request absorbs the next one: the key keeps one
 * job queued and `preserve_run_at` stops repeat asks from pushing it back.
 */
export async function enqueueGithubSync(executor: Executor): Promise<void> {
  await executor.execute(sql`select graphile_worker.add_job(
    'sync_github', '{}'::json,
    job_key := 'sync_github', job_key_mode := 'preserve_run_at', max_attempts := 1
  )`)
}

/** Runs `run` at most once per `everyMs`; calls in between return at once. */
export function throttle(
  run: () => Promise<void>,
  everyMs: number,
  now: () => number = Date.now,
): () => Promise<void> {
  let last = Number.NEGATIVE_INFINITY
  return async () => {
    const at = now()
    if (at - last < everyMs) return
    last = at
    await run()
  }
}

export async function enqueueGraphStep(executor: Executor, runId: string): Promise<void> {
  await executor.execute(sql`select graphile_worker.add_job(
    'graph_step', ${JSON.stringify({ runId })}::json,
    job_key := ${runId}, max_attempts := 3
  )`)
}
