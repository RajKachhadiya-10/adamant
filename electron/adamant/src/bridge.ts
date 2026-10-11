import { type AdamantApi, type AppInfo } from '@adamant/shared'

/**
 * `window.adamant` only exists when the preload script ran. When it did not
 * (a stale build, an exception in preload) reading `.getAppInfo` off
 * `undefined` throws synchronously inside the effect; React treats that as a
 * crash and unmounts the tree, so the "bridge unavailable" message the panel
 * was written to show never appears. Every failure is a rejection instead.
 */
export async function loadAppInfo(bridge: Partial<AdamantApi> | undefined): Promise<AppInfo> {
  if (typeof bridge?.getAppInfo !== 'function') {
    throw new Error('the preload bridge did not load')
  }
  return bridge.getAppInfo()
}
