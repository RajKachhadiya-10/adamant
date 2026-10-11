import { externalUrl } from '@adamant/shared'

/**
 * The slice of `Electron.WebContents` the navigation guard touches. Declared
 * structurally so the policy can be exercised without an Electron runtime.
 */
export interface GuardedContents {
  getURL(): string
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): unknown
  on(
    event: 'will-frame-navigate',
    listener: (details: { preventDefault(): void; url: string; isMainFrame: boolean }) => void,
  ): unknown
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
}

/** The slice of `Electron.Session` the permission policy touches. */
export interface GuardedSession {
  setPermissionRequestHandler(
    handler: (
      contents: unknown,
      permission: string,
      callback: (permissionGranted: boolean) => void,
    ) => void,
  ): void
  setPermissionCheckHandler(handler: (contents: unknown, permission: string) => boolean): void
}

/**
 * Renderer content must never be able to navigate the app frame elsewhere or
 * spawn unaudited windows; external links go to the user's real browser.
 */
export function guardNavigation(
  contents: GuardedContents,
  openExternal: (href: string) => Promise<void>,
): void {
  const leaveForBrowser = (url: string) => {
    const href = externalUrl(url)
    if (!href) return
    openExternal(href).catch((cause: unknown) => {
      console.error(`Could not open ${href} in the browser`, cause)
    })
  }

  contents.on('will-navigate', (event, url) => {
    if (url === contents.getURL()) return
    event.preventDefault()
    leaveForBrowser(url)
  })

  // `will-navigate` only covers the main frame. The CSP already pins frames
  // to 'self' and the renderer has none, so nothing legitimate is lost by
  // refusing every subframe navigation outright.
  contents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return
    details.preventDefault()
  })

  contents.setWindowOpenHandler(({ url }) => {
    leaveForBrowser(url)
    return { action: 'deny' }
  })
}

/**
 * Electron grants every permission request (camera, microphone, geolocation,
 * notifications, …) unless a handler says otherwise, and does so without a
 * prompt. The renderer needs none of them.
 */
export function denyPermissions(session: GuardedSession): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
}
