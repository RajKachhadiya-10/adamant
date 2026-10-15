import { getConnInfo } from '@hono/node-server/conninfo'
import { type Context, type MiddlewareHandler } from 'hono'

export type RateLimitOptions = {
  /** Requests a client may make at once. */
  burst: number
  /** Requests a client earns back per minute, up to `burst`. */
  perMinute: number
  /** Clients remembered at once; past this the least recently seen is forgotten. */
  maxClients?: number
  now?: () => number
  /** Which client a request counts against. Defaults to its peer address. */
  clientKey?: (c: Context) => string
}

type Bucket = { tokens: number; at: number }

const DEFAULT_MAX_CLIENTS = 10_000

/**
 * A client's IPv6 provider hands it a whole /64, so the /64 is the client; an
 * IPv4-mapped address is its IPv4 address. Anything unparseable keys as itself.
 */
export function clientKeyForAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mapped?.[1]) return mapped[1]
  if (!address.includes(':')) return address

  const bare = address.replace(/%.*$/, '').toLowerCase()
  const [head = '', tail, ...extra] = bare.split('::')
  if (extra.length > 0) return bare
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const missing = tail === undefined ? 0 : 8 - left.length - right.length
  if (missing < 0) return bare
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right]
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return bare
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`
}

/**
 * The TCP peer. Forwarded headers are not read: any client can write one, so
 * trusting it would let a flood name a fresh address per request. Behind a proxy
 * every request comes from the proxy, so the limit becomes one shared budget;
 * limit at the proxy as well in that setup.
 */
function peerKey(c: Context): string {
  try {
    const address = getConnInfo(c).remote.address
    return address ? clientKeyForAddress(address) : 'unknown'
  } catch {
    // app.request() in tests has no socket.
    return 'unknown'
  }
}

/**
 * A token bucket per client, held in this process: each instance limits on its own,
 * so N instances allow N times the budget, and a restart forgets it. It is meant
 * for the unauthenticated routes that write a row per request, so a flood cannot
 * fill Postgres faster than the hourly cleanup empties it.
 */
export function createRateLimit(options: RateLimitOptions): MiddlewareHandler {
  const now = options.now ?? Date.now
  const keyOf = options.clientKey ?? peerKey
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS
  const perMs = options.perMinute / 60_000
  const buckets = new Map<string, Bucket>()

  return async function rateLimit(c, next) {
    const key = keyOf(c)
    const time = now()
    const previous = buckets.get(key)
    const tokens = previous
      ? Math.min(options.burst, previous.tokens + (time - previous.at) * perMs)
      : options.burst

    // Re-inserting keeps the Map in least-recently-seen order for eviction.
    buckets.delete(key)
    if (tokens < 1) {
      buckets.set(key, { tokens, at: time })
      c.header('Retry-After', String(Math.ceil((1 - tokens) / perMs / 1000)))
      c.header('Cache-Control', 'no-store')
      return c.json({ error: 'Too many sign-in attempts. Try again shortly.' }, 429)
    }
    buckets.set(key, { tokens: tokens - 1, at: time })
    for (const oldest of buckets.keys()) {
      if (buckets.size <= maxClients) break
      buckets.delete(oldest)
    }
    await next()
  }
}
