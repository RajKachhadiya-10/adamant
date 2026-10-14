import { type Context, type Next } from 'hono'
import { getCookie } from 'hono/cookie'

import { type Db } from '../../db/client.ts'
import { authenticateSession, type AuthenticatedSession } from '../services/authService.ts'

export type AuthVariables = {
  userId: string
  sessionId: string
}

export const SESSION_COOKIE_NAME = 'adamant_session'

export type AuthMiddlewareOptions = {
  database?: Db
  authenticate?: (token: string) => Promise<AuthenticatedSession | null>
}

function readBearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  return match?.[1]
}

export function createAuthMiddleware(options: AuthMiddlewareOptions = {}) {
  const database = options.database
  const authenticate =
    options.authenticate ??
    (database ? (token: string) => authenticateSession(database, token) : undefined)

  return async function authMiddleware(c: Context, next: Next) {
    // Never the query string: a URL is written to every access log, proxy and
    // browser history between the client and this process. Every caller can
    // set a header or carries the cookie.
    const token =
      c.req.header('ADAMANT_SESSION') ??
      readBearerToken(c.req.header('Authorization')) ??
      getCookie(c, SESSION_COOKIE_NAME)

    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      if (!authenticate) {
        throw new Error('No session authentication method is configured')
      }

      const session = await authenticate(token)

      if (!session) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      c.set('userId', session.userId)
      c.set('sessionId', session.sessionId)
      await next()
    } catch (error) {
      console.error('Failed to authenticate session', error)
      return c.json({ error: 'Server misconfiguration' }, 500)
    }
  }
}
