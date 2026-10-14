export type CliConfig = {
  apiUrl: URL
  session: string
}

// WHATWG URLs keep the brackets on an IPv6 host, so `[::1]`, never `::1`.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function isLocalDevelopmentOrigin(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

// The API is not hosted yet, so the CLI targets a local `pnpm dev` API until it is.
const DEFAULT_API_URL = 'http://localhost:8787'

export function loadCliConfig(env = process.env): CliConfig {
  const apiUrlValue = env.ADAMANT_API_URL?.trim() || DEFAULT_API_URL
  const session = env.ADAMANT_SESSION?.trim()

  if (!session) {
    throw new Error('ADAMANT_SESSION is required. Use a session issued by the Adamant API.')
  }
  // It travels as `Authorization: Bearer <session>`, which ends at whitespace.
  if (/[\s\p{Cc}]/u.test(session)) {
    throw new Error('ADAMANT_SESSION must not contain spaces or control characters.')
  }

  let apiUrl: URL
  try {
    apiUrl = new URL(apiUrlValue)
  } catch {
    throw new Error('ADAMANT_API_URL must be a valid absolute URL.')
  }

  // `localhost:8787` parses as a URL whose scheme is `localhost:`.
  if (apiUrl.protocol !== 'https:' && apiUrl.protocol !== 'http:') {
    throw new Error('ADAMANT_API_URL must start with https:// (or http:// for localhost).')
  }
  if (apiUrl.username || apiUrl.password) {
    // fetch() refuses such a URL, so every request would fail later instead.
    throw new Error('ADAMANT_API_URL must not contain credentials. Use ADAMANT_SESSION.')
  }
  if (apiUrl.pathname !== '/' || apiUrl.search || apiUrl.hash) {
    throw new Error('ADAMANT_API_URL must be an origin without a path, query, or fragment.')
  }
  if (apiUrl.protocol !== 'https:' && !isLocalDevelopmentOrigin(apiUrl)) {
    throw new Error('ADAMANT_API_URL must use HTTPS outside explicit localhost development.')
  }

  return { apiUrl, session }
}

export function resolveApiUrl(config: CliConfig, pathname: string): URL {
  return new URL(pathname, config.apiUrl)
}
