import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type AppInfo } from '../../electron/shared/src/index.ts'
import { loadAppInfo } from '../../electron/adamant/src/bridge.ts'

const info: AppInfo = {
  name: 'Adamant',
  version: '0.1.0',
  platform: 'darwin',
  arch: 'arm64',
  isPackaged: false,
  versions: { electron: '44.4.1', chrome: '146.0.0.0', node: '24.0.0', v8: '14.6' },
}

describe('renderer bridge', () => {
  it('passes the main process answer through', async () => {
    assert.deepEqual(await loadAppInfo({ getAppInfo: async () => info }), info)
  })

  it('rejects, rather than throws, when the preload script never installed the bridge', async () => {
    // A synchronous throw here is what made the effect in App.tsx crash the
    // tree instead of rendering its "bridge unavailable" row.
    await assert.rejects(loadAppInfo(undefined), { message: 'the preload bridge did not load' })
    await assert.rejects(loadAppInfo({}), { message: 'the preload bridge did not load' })
  })

  it('turns a bridge method that throws into a rejection', async () => {
    const broken = {
      getAppInfo: (): Promise<AppInfo> => {
        throw new Error('ipcRenderer.invoke failed')
      },
    }
    await assert.rejects(loadAppInfo(broken), { message: 'ipcRenderer.invoke failed' })
  })
})
