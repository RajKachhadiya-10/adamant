import {
  GithubAppSlugSchema,
  GithubInstallationStatusSchema,
  GithubInstallUrlSchema,
  GithubOwnerSchema,
  GithubRepoNameSchema,
  INSTALL_CONFIRMATION_NEEDS_DATABASE,
  type GithubInstallationStatus,
} from '@adamant/contract'
import { Hono, type MiddlewareHandler } from 'hono'
import { createAuthMiddleware, type AuthVariables } from '../middleware/auth.ts'

export const APP_SLUG_UNCONFIGURED = 'The GitHub App slug is not configured.'
export const APP_SLUG_INVALID = 'GITHUB_APP_SLUG is not a single GitHub App slug.'

const NAME_ERROR = 'owner and name must be a single GitHub repository.'
const QUERY_ERROR = 'Only owner and name are accepted.'

export type FindInstalledRepository = (
  owner: string,
  name: string,
) => Promise<GithubInstallationStatus | null>

export type GithubInstallRouteOptions = {
  findRepository: FindInstalledRepository
  /** Read at request time so a missing slug is a 503, not a URL with an empty segment. */
  readAppSlug?: () => string | undefined
}

/**
 * Answers when Postgres is not configured. A missing route would be a 404, and
 * 404 on the status path means the repository is not installed yet — the CLI
 * would poll forever, or worse, treat an in-memory schema row as an install.
 */
export function createGithubInstallUnavailableRoute(
  requireSession: MiddlewareHandler = createAuthMiddleware(),
) {
  const route = new Hono<{ Variables: AuthVariables }>()
  route.use('*', requireSession)
  route.get('/install', (c) => c.json({ error: INSTALL_CONFIRMATION_NEEDS_DATABASE }, 503))
  route.get('/installations/status', (c) =>
    c.json({ error: INSTALL_CONFIRMATION_NEEDS_DATABASE }, 503),
  )
  return route
}

export function createGithubInstallRoute(
  options: GithubInstallRouteOptions,
  requireSession: MiddlewareHandler = createAuthMiddleware(),
) {
  const readAppSlug = options.readAppSlug ?? (() => process.env.GITHUB_APP_SLUG)
  const route = new Hono<{ Variables: AuthVariables }>()
  route.use('*', requireSession)

  route.get('/install', (c) => {
    const slug = readAppSlug()?.trim() ?? ''
    if (!slug) return c.json({ error: APP_SLUG_UNCONFIGURED }, 503)
    const parsedSlug = GithubAppSlugSchema.safeParse(slug)
    if (!parsedSlug.success) return c.json({ error: APP_SLUG_INVALID }, 503)

    const body = GithubInstallUrlSchema.safeParse({
      url: `https://github.com/apps/${parsedSlug.data}/installations/new`,
    })
    if (!body.success) return c.json({ error: APP_SLUG_INVALID }, 503)
    return c.json(body.data)
  })

  route.get('/installations/status', async (c) => {
    const query = c.req.queries()
    for (const key of Object.keys(query)) {
      if (key !== 'owner' && key !== 'name') return c.json({ error: QUERY_ERROR }, 400)
    }
    const owner = single(query.owner)
    const name = single(query.name)
    if (
      !owner ||
      !name ||
      !GithubOwnerSchema.safeParse(owner).success ||
      !GithubRepoNameSchema.safeParse(name).success
    ) {
      return c.json({ error: NAME_ERROR }, 400)
    }

    const found = await options.findRepository(owner, name)
    if (!found) return c.json({ error: 'Adamant is not installed on this repository.' }, 404)

    const body = GithubInstallationStatusSchema.safeParse({
      owner: found.owner,
      name: found.name,
      defaultBranch: found.defaultBranch,
    })
    if (!body.success) return c.json({ error: 'Adamant is not installed on this repository.' }, 404)
    return c.json(body.data)
  })

  return route
}

/** One value. Repeated keys would let a second name hide behind the first. */
function single(values: string[] | undefined): string | undefined {
  if (!values || values.length !== 1) return undefined
  const value = values[0]
  return value ? value : undefined
}
