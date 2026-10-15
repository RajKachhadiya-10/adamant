export const DATABASE_UNAVAILABLE = 'The database is unavailable'

// Postgres is down, restarting, out of connections or unreachable. SQLSTATE
// class 08 (connection exception) is matched by prefix below.
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now: still starting up
  '53300', // too_many_connections
])

// node-postgres reports these with no code.
const UNAVAILABLE_MESSAGES = [
  /^Connection terminated/,
  /timeout exceeded when trying to connect/,
  /Cannot use a pool after calling end on the pool/,
]

/** Each error in a chain of causes, including every attempt of an AggregateError. */
function* chain(error: unknown): Generator<Error> {
  const seen = new Set<unknown>()
  const pending: unknown[] = [error]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!(current instanceof Error) || seen.has(current)) continue
    seen.add(current)
    yield current
    pending.push(current.cause)
    if (current instanceof AggregateError) pending.push(...current.errors)
  }
}

/**
 * Whether a failure means "the database cannot be reached right now", which a
 * client should retry (503), rather than a bug or a misconfiguration (500). Drizzle
 * wraps the driver's error as `cause`, and `localhost` refusing on both address
 * families arrives as an AggregateError.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  for (const current of chain(error)) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && (UNAVAILABLE_CODES.has(code) || code.startsWith('08'))) {
      return true
    }
    if (UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(current.message))) return true
  }
  return false
}

/**
 * The error as it may be logged. Drizzle's message quotes every bound parameter and
 * pg's `detail` quotes the conflicting row; in auth those are OAuth states, PKCE
 * verifiers and token hashes. A database failure is reduced to its SQL text (values
 * bound as $n) and each cause's name, code and message. Anything else is unchanged.
 */
export function redactDatabaseError(error: unknown): unknown {
  const causes = [...chain(error)]
  const fromDatabase = causes.some(
    (cause) => 'params' in cause || 'detail' in cause || 'severity' in cause,
  )
  if (!fromDatabase || !(error instanceof Error)) return error

  const summary = causes.slice(0, 5).map((cause) => {
    const code = (cause as { code?: unknown }).code
    const query = (cause as { query?: unknown }).query
    const message = typeof query === 'string' ? `Failed query: ${query}` : cause.message
    return `${cause.name}${typeof code === 'string' ? ` ${code}` : ''}: ${message}`
  })
  const redacted = new Error(summary.join('\n  caused by '))
  redacted.name = 'DatabaseError'
  // Frames only: the stack's head repeats the message, parameters and all.
  const frames = (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line))
  redacted.stack = [`${redacted.name}: ${redacted.message}`, ...frames].join('\n')
  return redacted
}
