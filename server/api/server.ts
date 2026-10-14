import { Hono, type MiddlewareHandler } from 'hono'

import { createDb, type Db } from '../db/client.ts'
import { createApp, resourceNames } from './app.ts'
import { createAuthMiddleware } from './middleware/auth.ts'
import { type AuthenticatedSession } from './services/authService.ts'
import { createActivityRoute } from './routes/activity.ts'
import { createAuthRoute, type OAuthConfig } from './routes/auth.ts'
import {
  createGithubInstallRoute,
  createGithubInstallUnavailableRoute,
} from './routes/githubInstall.ts'
import { createRunsRoute } from './routes/runs.ts'
import {
  createActivityService,
  listenForActivity,
  type ActivityService,
} from './services/activityService.ts'
import {
  createMemoryRunApiStore,
  createPostgresRunApiStore,
  type RunApiStore,
} from './services/runStore.ts'
import { findInstalledRepository, listInstalledRepositories } from './services/repositoryLookup.ts'
import { createWebhookService } from './services/webhookService.ts'
import { createPostgresWebhookStore } from './services/webhookStore.ts'
import { createGithubWebhookRoute } from './webhooks/github.ts'

/**
 * Auth is applied here per resource (looping resourceNames so a new resource
 * cannot ship unauthenticated by omission). GitHub calls /webhooks/github with
 * its own signature, and /health stays open for infra checks.
 *
 * With a database, /runs is the Postgres-backed router and the in-memory
 * schema CRUD is not mounted: its rows never reach Postgres, its maps grow
 * without bound, and its POST /audit-events would publish forged events to
 * every `adamant watch`. Without a database the CRUD is the local stand-in,
 * except /runs, which keeps the CLI's contract through an in-memory store.
 */
export type ServerOptions = {
  database?: Db
  oauthConfig?: OAuthConfig
  fetch?: typeof globalThis.fetch
  activityService?: ActivityService
  /** Tests inject a session lookup. Production uses the database. */
  authenticate?: (token: string) => Promise<AuthenticatedSession | null>
}

function readOAuthConfig(): OAuthConfig {
  const provider = (name: 'GITHUB' | 'GOOGLE') => {
    const clientId = process.env[`${name}_OAUTH_CLIENT_ID`]
    const clientSecret = process.env[`${name}_OAUTH_CLIENT_SECRET`]
    const redirectUri = process.env[`${name}_OAUTH_REDIRECT_URI`]
    return clientId && clientSecret && redirectUri
      ? { clientId, clientSecret, redirectUri }
      : undefined
  }

  const github = provider('GITHUB')
  const google = provider('GOOGLE')
  return {
    ...(github ? { github } : {}),
    ...(google ? { google } : {}),
  }
}

const alreadyAuthenticated: MiddlewareHandler = async (_c, next) => {
  await next()
}

export function createServerApp(runStore?: RunApiStore, options: ServerOptions = {}) {
  const app = new Hono()
  const database =
    options.database ?? (process.env.DATABASE_URL ? createDb(process.env.DATABASE_URL) : undefined)
  const authMiddleware = createAuthMiddleware({
    ...(database ? { database } : {}),
    ...(options.authenticate ? { authenticate: options.authenticate } : {}),
  })
  const resolvedActivityService =
    options.activityService ??
    createActivityService({
      ...(database ? { database, changes: listenForActivity(database.$client) } : {}),
    })
  const resolvedRunStore =
    runStore ??
    (database
      ? createPostgresRunApiStore(database)
      : createMemoryRunApiStore({ activity: resolvedActivityService }))

  for (const name of [...resourceNames, 'activity']) {
    app.use(`/${name}`, authMiddleware)
    app.use(`/${name}/*`, authMiddleware)
  }

  // The loop above already authenticated /runs; a second pass would repeat
  // the session lookup on every request.
  app.route('/runs', createRunsRoute(resolvedRunStore, alreadyAuthenticated))

  // Outer middleware authenticates. The route's own middleware is a no-op so
  // the session lookup does not run twice. Without Postgres, 404 would mean
  // "not installed yet" and the CLI would poll an in-memory row forever.
  app.use('/github', authMiddleware)
  app.use('/github/*', authMiddleware)
  if (database) {
    app.route(
      '/github',
      createGithubInstallRoute(
        {
          findRepository: (owner, name) => findInstalledRepository(database, owner, name),
          listRepositories: () => listInstalledRepositories(database),
          readAppSlug: () => process.env.GITHUB_APP_SLUG,
        },
        alreadyAuthenticated,
      ),
    )
    app.route(
      '/auth',
      createAuthRoute(database, options.oauthConfig ?? readOAuthConfig(), {
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    )
    app.get('/health', (c) => c.json({ status: 'ok' }))
  } else {
    app.route('/github', createGithubInstallUnavailableRoute(alreadyAuthenticated))
    createApp(undefined, app, resolvedActivityService, ['runs'])
  }

  // One pool per process: the webhook store reuses the server's database.
  app.route(
    '/webhooks/github',
    createGithubWebhookRoute(
      database ? createWebhookService({ store: createPostgresWebhookStore(database) }) : undefined,
    ),
  )
  app.route('/activity', createActivityRoute(resolvedActivityService))

  return app
}

export type ApiType = ReturnType<typeof createServerApp>

/** The parts of `node:http.Server` a shutdown needs; HTTP/2 servers lack the last two. */
export type ClosableServer = {
  close(callback?: (error?: Error) => void): unknown
  closeIdleConnections?(): void
  closeAllConnections?(): void
}

export type ShutdownOptions = {
  /** How long in-flight requests and open streams get before they are cut. */
  timeoutMs?: number
  exit?: (code: number) => void
}

// Orchestrators send SIGTERM and wait about 30 s before SIGKILL; leave margin.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * Stops accepting connections, lets in-flight requests finish, then exits.
 * `/activity` streams never finish on their own, so whatever is still open
 * at the deadline is cut; node-server aborts those streams, which unsubscribes
 * them. Without this a SIGTERM killed the process mid-webhook, and GitHub does
 * not redeliver on its own.
 */
export function shutdownGracefully(server: ClosableServer, options: ShutdownOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const exit = options.exit ?? ((code: number) => process.exit(code))
  let finished = false
  const finish = (code: number) => {
    if (finished) return
    finished = true
    clearTimeout(deadline)
    exit(code)
  }
  const deadline = setTimeout(() => {
    server.closeAllConnections?.()
    finish(0)
  }, timeoutMs)
  deadline.unref()

  server.close((error) => finish(error ? 1 : 0))
  // Keep-alive connections with no request in flight would otherwise hold
  // `close` open until the client's idle timeout.
  server.closeIdleConnections?.()
}

export function installShutdownHandlers(server: ClosableServer, options: ShutdownOptions = {}) {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => shutdownGracefully(server, options))
  }
}
