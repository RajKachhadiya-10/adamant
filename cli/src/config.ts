export type CliConfig = {
  apiUrl: URL
  session: string
}

function isLocalDevelopmentOrigin(url: URL): boolean {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
  )
}

// The API is not hosted yet, so the CLI targets a local `pnpm dev` API until it is.
const DEFAULT_API_URL = 'http://localhost:8787'

export function loadCliConfig(env = process.env): CliConfig {
  const apiUrlValue = env.ADAMANT_API_URL?.trim() || DEFAULT_API_URL
  const session = env.ADAMANT_SESSION?.trim()

  if (!session) {
    throw new Error('ADAMANT_SESSION is required. Use a session issued by the Adamant API.')
  }

  let apiUrl: URL
  try {
    apiUrl = new URL(apiUrlValue)
  } catch {
    throw new Error('ADAMANT_API_URL must be a valid absolute URL.')
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
