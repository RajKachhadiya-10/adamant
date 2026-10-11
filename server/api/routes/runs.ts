import { Hono } from 'hono'
import { type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createAuthMiddleware, type AuthVariables } from '../middleware/auth.ts'
import {
  createDefaultRunApiStore,
  UnknownRepositoryError,
  type RunApiStore,
} from '../services/runStore.ts'

// The worker passes this to `git fetch` and `git checkout`. Anything but a full
// hex object id could be read as an option, and a short one cannot be fetched.
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

// A run request is two short strings. The body is buffered before it is parsed,
// so anything larger is refused unread rather than held in memory.
const MAX_RUN_REQUEST_BYTES = 16 * 1024

// The key is stored verbatim as `runs.idempotency_key` and compared on every
// retry; a client-chosen value has no reason to be longer than this.
const MAX_IDEMPOTENCY_KEY_LENGTH = 255

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function createRunsRoute(
  store: RunApiStore = createDefaultRunApiStore(),
  requireSession: MiddlewareHandler = createAuthMiddleware(),
) {
  const route = new Hono<{ Variables: AuthVariables }>()
  route.use('*', requireSession)

  route.post('/', bodyLimit({ maxSize: MAX_RUN_REQUEST_BYTES }), async (c) => {
    const key = c.req.header('idempotency-key')
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    // A regex test coerces its argument, so `['<sha>']` passed as a SHA and was
    // stored as a Postgres array literal the worker then handed to git.
    const repositoryId = readString(body?.repositoryId)
    const sourceSha = readString(body?.sourceSha)
    if (!key || !repositoryId || !sourceSha) {
      return c.json({ error: 'Idempotency-Key, repositoryId, and sourceSha are required' }, 400)
    }
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return c.json(
        { error: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters` },
        400,
      )
    }
    if (!COMMIT_SHA.test(sourceSha)) {
      return c.json({ error: 'sourceSha must be a full commit SHA' }, 400)
    }
    try {
      const result = await store.create({
        repositoryId,
        sourceSha,
        idempotencyKey: key,
        userId: c.get('userId'),
      })
      return c.json({ run: result.run }, result.created ? 202 : 200)
    } catch (error) {
      if (error instanceof UnknownRepositoryError) {
        return c.json({ error: error.message }, 404)
      }
      throw error
    }
  })

  route.get('/', async (c) => c.json({ runs: await store.list(c.get('userId')) }))
  route.get('/:id', async (c) => {
    const detail = await store.detail(c.get('userId'), c.req.param('id'))
    return detail ? c.json(detail) : c.json({ error: 'Run not found' }, 404)
  })
  return route
}
