import { app, BrowserWindow, session, shell } from 'electron'
import { denyPermissions, guardNavigation } from './harden.mjs'
import { registerIpcHandlers } from './ipc'
import { createMainWindow } from './window'

// A second launch should focus the running window instead of starting a rival
// instance that fights over the same workspace state.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.on('web-contents-created', (_event, contents) => {
    guardNavigation(contents, (href) => shell.openExternal(href))
  })

  app.whenReady().then(() => {
    denyPermissions(session.defaultSession)
    registerIpcHandlers()
    createMainWindow()

    // macOS keeps the process alive after the last window closes.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
