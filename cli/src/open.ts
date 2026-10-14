import { spawn, type ChildProcess } from 'node:child_process'

// `xdg-open` can sit forever with no display. `/install` still has to poll.
const OPEN_TIMEOUT_MS = 3_000

export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: readonly string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  // The first quoted argument of `start` is a window title, not the URL.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  return { command: 'xdg-open', args: [url] }
}

/**
 * Best-effort. A missing opener or a non-zero exit is false. A process that
 * does not exit is left running after a few seconds so the command can move on.
 */
export function openInstallUrl(url: string): Promise<boolean> {
  const { command, args } = browserOpenCommand(process.platform, url)
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    } catch {
      resolve(false)
      return
    }

    let settled = false
    const finish = (opened: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(opened)
    }
    const timer = setTimeout(() => finish(true), OPEN_TIMEOUT_MS)
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
    child.unref()
  })
}
