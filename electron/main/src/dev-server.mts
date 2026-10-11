const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The renderer URL for a development session, or `null` to load the bundled
 * renderer.
 *
 * `scripts/dev.mjs` injects `VITE_DEV_SERVER_URL`, and it is the only thing
 * that should. A packaged build that honoured it would load whatever page the
 * environment names, with the preload bridge attached and devtools open, so
 * the variable is ignored once packaged, and in development only a loopback
 * http URL qualifies.
 */
export function devServerUrl(
  env: Record<string, string | undefined>,
  isPackaged: boolean,
): string | null {
  const raw = env.VITE_DEV_SERVER_URL
  if (isPackaged || !raw) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) return null

  return raw
}
