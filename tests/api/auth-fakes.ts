import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { type TestContext } from 'node:test'
import { inspect } from 'node:util'

import { getTableColumns, type SQL } from 'drizzle-orm'
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core'

import { type Db } from '../../server/db/client.ts'
import { oauthStates, sessions, userIdentities, users } from '../../server/db/schema/index.ts'

type Row = Record<string, unknown>
type Fields = Record<string, unknown> | undefined

const dialect = new PgDialect()
const tables: PgTable[] = [users, userIdentities, sessions, oauthStates]
const columnKeys = new Map<unknown, string>(
  tables.flatMap((table) =>
    Object.entries(getTableColumns(table)).map(([key, column]) => [column, key] as const),
  ),
)

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export const github = {
  clientId: 'github-client-id',
  clientSecret: 'github-client-secret-value',
  redirectUri: 'http://localhost/auth/github/callback',
}

export const google = {
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret-value',
  redirectUri: 'http://localhost/auth/google/callback',
}

function project(rows: Row[], fields: Fields): Row[] {
  if (!fields) return rows
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(fields).map(([key, column]) => [key, row[columnKeys.get(column) ?? key]]),
    ),
  )
}

/** A builder step that runs once, whether it is awaited or asked for `returning`/`limit`. */
function step(run: () => Row[], fields?: Fields) {
  let done: Row[] | undefined
  const once = () => (done ??= run())
  return {
    then<A = Row[], B = never>(
      resolve?: ((rows: Row[]) => A | PromiseLike<A>) | null,
      reject?: ((error: unknown) => B | PromiseLike<B>) | null,
    ): Promise<A | B> {
      return Promise.resolve()
        .then(() => project(once(), fields))
        .then(resolve, reject)
    },
    returning: async (returned?: Fields) => project(once(), returned),
    limit: async (count: number) => project(once(), fields).slice(0, count),
  }
}

/**
 * Enough of Drizzle's builder for the auth routes, over in-memory rows. A
 * condition matches a row when each bound parameter equals one of its values,
 * which holds for every lookup auth makes by id, token hash, state or provider
 * id, but not for `ne`: account linking is tested on Postgres instead
 * (auth-db.test.ts).
 */
export function createFakeAuthDb() {
  const rows = new Map<PgTable, Row[]>(tables.map((table) => [table, []]))
  let sequence = 0
  const rowsOf = (table: PgTable): Row[] => {
    const found = rows.get(table)
    if (!found) throw new Error('The fake database has no such table')
    return found
  }
  const matching = (table: PgTable, condition: SQL | undefined) => {
    const params = condition ? dialect.sqlToQuery(condition).params : []
    return rowsOf(table).filter(
      (row) =>
        params.every((param) => Object.values(row).some((value) => value === param)) &&
        // The only parameterless clause auth sends that changes a result.
        (table !== oauthStates || (row.expiresAt as Date) > new Date()),
    )
  }
  const conflicts = (table: PgTable, value: Row) =>
    (table === userIdentities &&
      rowsOf(table).some(
        (row) => row.provider === value.provider && row.providerUserId === value.providerUserId,
      )) ||
    (table === users &&
      typeof value.email === 'string' &&
      rowsOf(table).some(
        (row) =>
          typeof row.email === 'string' &&
          row.email.toLowerCase() === String(value.email).toLowerCase(),
      ))

  const add = (table: PgTable, value: Row): Row => {
    sequence += 1
    const row: Row = {
      id: `row-${sequence}`,
      createdAt: new Date(),
      ...(table === sessions ? { revokedAt: null, lastUsedAt: null } : {}),
      ...(table === users ? { email: null } : {}),
      ...value,
    }
    rowsOf(table).push(row)
    return row
  }

  const db = {
    insert: (table: PgTable) => ({
      values: (value: Row) => {
        const insert = (skipConflicts: boolean) => () => {
          if (conflicts(table, value)) {
            if (skipConflicts) return []
            throw new Error('duplicate key value violates unique constraint')
          }
          return [add(table, value)]
        }
        return {
          ...step(insert(false)),
          onConflictDoNothing: () => step(insert(true)),
        }
      },
    }),
    select: (fields?: Fields) => ({
      from: (table: PgTable) => ({
        where: (condition?: SQL) => step(() => matching(table, condition), fields),
      }),
    }),
    update: (table: PgTable) => ({
      set: (values: Row) => ({
        where: (condition?: SQL) =>
          step(() => {
            const targets = matching(table, condition).filter(
              // `revoked_at IS NULL` is the other parameterless clause.
              (row) => !(table === sessions && 'revokedAt' in values && row.revokedAt),
            )
            for (const row of targets) Object.assign(row, values)
            return targets
          }),
      }),
    }),
    delete: (table: PgTable) => ({
      where: (condition?: SQL) =>
        step(() => {
          const targets = matching(table, condition)
          rows.set(
            table,
            rowsOf(table).filter((row) => !targets.includes(row)),
          )
          return targets
        }),
    }),
    transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(db),
  }

  return {
    db: db as unknown as Db,
    rows: rowsOf,
    add,
  }
}

export type FakeAuthDb = ReturnType<typeof createFakeAuthDb>

type ProviderHandler = (init: RequestInit | undefined) => Response | Promise<Response>

/** A provider that answers only the URLs it is given; anything else is a test failure. */
export function fakeProvider(routes: Record<string, ProviderHandler>) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    const handler = routes[url]
    if (!handler) throw new Error(`Unexpected provider request to ${url}`)
    return handler(init)
  }
  return { fetch, calls }
}

export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_USER_URL = 'https://api.github.com/user'
export const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_USER_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

export const PROVIDER_ACCESS_TOKEN = 'gho_provider-access-token-value'

export function githubProvider(
  overrides: Partial<Record<string, ProviderHandler>> = {},
): ReturnType<typeof fakeProvider> {
  return fakeProvider({
    [GITHUB_TOKEN_URL]: () => Response.json({ access_token: PROVIDER_ACCESS_TOKEN }),
    [GITHUB_USER_URL]: () => Response.json({ id: 123, login: 'octocat' }),
    [GITHUB_EMAILS_URL]: () => Response.json([]),
    ...definedOnly(overrides),
  })
}

export function googleProvider(
  overrides: Partial<Record<string, ProviderHandler>> = {},
): ReturnType<typeof fakeProvider> {
  return fakeProvider({
    [GOOGLE_TOKEN_URL]: () => Response.json({ access_token: PROVIDER_ACCESS_TOKEN }),
    [GOOGLE_USER_URL]: () =>
      Response.json({ sub: 'google-sub-1', email: 'Person@Example.com', email_verified: true }),
    ...definedOnly(overrides),
  })
}

function definedOnly(handlers: Partial<Record<string, ProviderHandler>>) {
  return Object.fromEntries(
    Object.entries(handlers).filter((entry): entry is [string, ProviderHandler] => !!entry[1]),
  )
}

/** Everything written to the console during the test, errors expanded with stack and cause. */
export function captureLogs(t: TestContext): () => string {
  const calls: unknown[][] = []
  for (const method of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      calls.push(args)
    })
  }
  return () =>
    calls.map((args) => args.map((arg) => inspect(arg, { depth: 8 })).join(' ')).join('\n')
}

export function cookieValue(response: Response, name: string): string | undefined {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))
  return cookie?.slice(name.length + 1).split(';')[0]
}

type AuthApp = {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>
}

/** The hidden CSRF token on the confirmation page. */
export function formToken(page: string): string {
  return /name="token" value="([^"]*)"/.exec(page)?.[1] ?? ''
}

/**
 * The browser half of a terminal sign-in against the /auth router: the terminal
 * opens beginPath on the full API, so `/auth` is dropped here.
 */
export function cliBrowser(app: AuthApp) {
  const page = async (cookie?: string) =>
    app.request('/github/cli/confirm', {
      headers: cookie ? { Cookie: `adamant_cli_confirm=${cookie}` } : {},
    })
  const decide = async (
    cookie: string | undefined,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    app.request('/github/cli/confirm', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: `adamant_cli_confirm=${cookie}` } : {}),
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    })

  /** Opens beginPath and comes back from GitHub with `query` (a code unless told otherwise). */
  const signIn = async (beginPath: string, query: Record<string, string> = { code: 'code' }) => {
    const begin = await app.request(beginPath.replace(/^\/auth/, ''))
    assert.equal(begin.status, 302)
    const state = new URL(begin.headers.get('location') ?? '').searchParams.get('state') ?? ''
    const callback = await app.request(
      `/github/callback?${new URLSearchParams({ ...query, state }).toString()}`,
      { headers: { Cookie: `adamant_oauth_github_state=${state}` } },
    )
    return { begin, state, callback, cookie: cookieValue(callback, 'adamant_cli_confirm') }
  }

  /** Through GitHub, then the page's "This is the code in my terminal" (or Cancel). */
  const approve = async (beginPath: string, action: 'confirm' | 'cancel' = 'confirm') => {
    const signedIn = await signIn(beginPath)
    const shown = await page(signedIn.cookie)
    const html = await shown.text()
    const decided = await decide(
      signedIn.cookie,
      { token: formToken(html), action },
      { 'sec-fetch-site': 'same-origin' },
    )
    return { ...signedIn, shown, html, decided }
  }

  return { signIn, page, decide, approve }
}
