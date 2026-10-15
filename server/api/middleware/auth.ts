import { type Context, type Next } from 'hono'
import { getCookie } from 'hono/cookie'

import { type Db } from '../../db/client.ts'
import { authenticateSession, type AuthenticatedSession } from '../services/authService.ts'
import {
  DATABASE_UNAVAILABLE,
  isDatabaseUnavailable,
  redactDatabaseError,
} from '../services/databaseErrors.ts'

export type AuthVariables = {
  userId: string
  sessionId: string
}

export const SESSION_COOKIE_NAME = 'adamant_session'

export type AuthMiddlewareOptions = {
  database?: Db
  authenticate?: (token: string) => Promise<AuthenticatedSession | null>
}

// Issued tokens are 43 base64url characters. Anything else cannot match a
// session, so it is refused without a database round trip.
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,512}$/

/**
 * The session token this request presents: `undefined` when it presents none,
 * '' when it presents one that cannot be a session token.
 *
 * Never the query string: a URL is written to every access log, proxy and
 * browser history between the client and this process. The first credential
 * present wins (ADAMANT_SESSION, then Authorization: Bearer, then the cookie),
 * and a present but bad one never falls through to the next, so a wrong
 * explicit token is a 401 rather than whoever owns the browser's cookie.
 */
export function readSessionToken(c: Context): string | undefined {
  // An empty header is a client sending an unset variable, not a credential.
  const header = c.req.header('ADAMANT_SESSION') || undefined
  const bearer = header ? undefined : c.req.header('Authorization')?.match(/^Bearer(?:\s+(.*))?$/i)
  const token = header ?? (bearer ? (bearer[1] ?? '') : getCookie(c, SESSION_COOKIE_NAME))
  if (token === undefined) return undefined
  return SESSION_TOKEN_PATTERN.test(token) ? token : ''
}

export function createAuthMiddleware(options: AuthMiddlewareOptions = {}) {
  const database = options.database
  const authenticate =
    options.authenticate ??
    (database ? (token: string) => authenticateSession(database, token) : undefined)

  return async function authMiddleware(c: Context, next: Next) {
    const token = readSessionToken(c)
    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    let session: AuthenticatedSession | null
    try {
      if (!authenticate) {
        throw new Error('No session authentication method is configured')
      }
      session = await authenticate(token)
    } catch (error) {
      console.error('Failed to authenticate session', redactDatabaseError(error))
      // An outage is worth retrying; anything else here is this server's setup.
      if (isDatabaseUnavailable(error)) return c.json({ error: DATABASE_UNAVAILABLE }, 503)
      return c.json({ error: 'Server misconfiguration' }, 500)
    }

    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    c.set('userId', session.userId)
    c.set('sessionId', session.sessionId)
    // Outside the try: a failure in the route is the route's, not an auth failure.
    await next()
  }
}
