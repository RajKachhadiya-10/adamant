import { UserSettingsSchema } from '@adamant/contract'
import { Hono, type MiddlewareHandler } from 'hono'
import { createAuthMiddleware, type AuthVariables } from '../middleware/auth.ts'
import { type SettingsStore } from '../services/settingsStore.ts'

const BODY_ERROR = 'Send {"autoMerge": true} or {"autoMerge": false}.'
const NO_USER = 'The session user no longer exists.'

/**
 * The terminal saves its approval mode here, so heals the worker runs while the
 * terminal is closed still follow it.
 */
export function createSettingsRoute(
  store: SettingsStore,
  requireSession: MiddlewareHandler = createAuthMiddleware(),
) {
  const route = new Hono<{ Variables: AuthVariables }>()
  route.use('*', requireSession)

  route.get('/', async (c) => {
    const settings = await store.read(c.get('userId'))
    if (!settings) return c.json({ error: NO_USER }, 404)
    return c.json(settings)
  })

  route.put('/', async (c) => {
    const parsed = UserSettingsSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: BODY_ERROR }, 400)
    const saved = await store.write(c.get('userId'), parsed.data)
    if (!saved) return c.json({ error: NO_USER }, 404)
    return c.json(saved)
  })

  return route
}
