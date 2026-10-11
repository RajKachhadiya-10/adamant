import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import {
  denyPermissions,
  guardNavigation,
  type GuardedContents,
  type GuardedSession,
} from '../../electron/main/src/harden.mts'

type Listener = (...args: never[]) => void

/** A stand-in for `webContents` that records the handlers the guard installs. */
function fakeContents(currentUrl: string) {
  const listeners = new Map<string, Listener>()
  let windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null

  const contents: GuardedContents = {
    getURL: () => currentUrl,
    on(event: string, listener: Listener) {
      listeners.set(event, listener)
      return contents
    },
    setWindowOpenHandler(handler) {
      windowOpenHandler = handler
    },
  }

  function willNavigate(url: string) {
    const event = { prevented: false, preventDefault: () => void (event.prevented = true) }
    const listener = listeners.get('will-navigate')
    assert.ok(listener, 'will-navigate listener installed')
    listener(event as never, url as never)
    return event.prevented
  }

  function willFrameNavigate(url: string, isMainFrame: boolean) {
    const details = {
      url,
      isMainFrame,
      prevented: false,
      preventDefault: () => void (details.prevented = true),
    }
    const listener = listeners.get('will-frame-navigate')
    assert.ok(listener, 'will-frame-navigate listener installed')
    listener(details as never)
    return details.prevented
  }

  function windowOpen(url: string) {
    assert.ok(windowOpenHandler, 'window open handler installed')
    return windowOpenHandler({ url }).action
  }

  return { contents, willNavigate, willFrameNavigate, windowOpen }
}

describe('navigation guard', () => {
  it('sends a main-frame navigation off the app to the browser instead', () => {
    const opened: string[] = []
    const { contents, willNavigate } = fakeContents('file:///app/index.html')
    guardNavigation(contents, async (href) => void opened.push(href))

    assert.equal(willNavigate('https://github.com/acme/eval/pull/1'), true)
    assert.deepEqual(opened, ['https://github.com/acme/eval/pull/1'])
  })

  it('lets a reload of the current page through', () => {
    const opened: string[] = []
    const { contents, willNavigate } = fakeContents('http://localhost:5273/')
    guardNavigation(contents, async (href) => void opened.push(href))

    assert.equal(willNavigate('http://localhost:5273/'), false)
    assert.deepEqual(opened, [])
  })

  it('drops navigations to schemes the browser must not receive', () => {
    const opened: string[] = []
    const { contents, willNavigate, windowOpen } = fakeContents('file:///app/index.html')
    guardNavigation(contents, async (href) => void opened.push(href))

    assert.equal(willNavigate('file:///etc/passwd'), true)
    assert.equal(windowOpen('javascript:alert(1)'), 'deny')
    assert.deepEqual(opened, [])
  })

  it('denies window.open and hands web URLs to the browser', () => {
    const opened: string[] = []
    const { contents, windowOpen } = fakeContents('file:///app/index.html')
    guardNavigation(contents, async (href) => void opened.push(href))

    assert.equal(windowOpen('https://adamant.example/docs'), 'deny')
    assert.deepEqual(opened, ['https://adamant.example/docs'])
  })

  it('blocks subframe navigation, which will-navigate never sees', () => {
    const opened: string[] = []
    const { contents, willFrameNavigate } = fakeContents('file:///app/index.html')
    guardNavigation(contents, async (href) => void opened.push(href))

    assert.equal(willFrameNavigate('https://evil.example/', false), true)
    assert.equal(willFrameNavigate('file:///app/other.html', false), true)
    // The main frame is will-navigate's job; the same event must not open
    // the browser twice or block the reload case.
    assert.equal(willFrameNavigate('https://github.com/', true), false)
    assert.deepEqual(opened, [])
  })

  it('leaves the DevTools document, which frames its own panels, alone', () => {
    const { contents, willFrameNavigate } = fakeContents(
      'devtools://devtools/bundled/devtools_app.html?remoteBase=x',
    )
    guardNavigation(contents, async () => {})

    assert.equal(willFrameNavigate('devtools://devtools/bundled/panel.html', false), false)
  })

  it('reports a browser that refuses the URL instead of leaving a rejection unhandled', async () => {
    const error = mock.method(console, 'error', () => {})
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => void rejections.push(reason)
    process.on('unhandledRejection', onRejection)

    try {
      const { contents, willNavigate } = fakeContents('file:///app/index.html')
      guardNavigation(contents, () => Promise.reject(new Error('no browser')))
      willNavigate('https://github.com/')
      await new Promise((resolve) => setImmediate(resolve))

      assert.deepEqual(rejections, [])
      assert.equal(error.mock.callCount(), 1)
    } finally {
      process.off('unhandledRejection', onRejection)
      error.mock.restore()
    }
  })
})

describe('permission policy', () => {
  it('refuses every permission request and check', () => {
    const installed: {
      request?: (c: unknown, p: string, cb: (granted: boolean) => void) => void
      check?: (c: unknown, p: string) => boolean
    } = {}
    const session: GuardedSession = {
      setPermissionRequestHandler: (handler) => void (installed.request = handler),
      setPermissionCheckHandler: (handler) => void (installed.check = handler),
    }

    denyPermissions(session)

    const { request, check } = installed
    assert.ok(request && check, 'both handlers installed')
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read']) {
      const granted: boolean[] = []
      request(null, permission, (value) => void granted.push(value))
      assert.deepEqual(granted, [false], `${permission} request`)
      assert.equal(check(null, permission), false, `${permission} check`)
    }
  })
})
