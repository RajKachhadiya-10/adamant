import { useEffect, useState } from 'react'
import type { AppInfo } from '@adamant/shared'
import { loadAppInfo } from './bridge'
import { TitleBar } from './components/TitleBar'

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    loadAppInfo(window.adamant)
      .then((result) => {
        if (!cancelled) setInfo(result)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="app">
      <TitleBar />
      <main className="app__body">
        <h1 className="app__title">Adamant</h1>
        <p className="app__tagline">Self-healing codebase agent for developers.</p>

        <section className="panel">
          <h2 className="panel__heading">Runtime</h2>
          {error && <p className="panel__error">Bridge unavailable: {error}</p>}
          {!error && !info && <p className="panel__muted">Loading…</p>}
          {info && (
            <dl className="panel__grid">
              <Row
                label="Version"
                value={`${info.version} (${info.isPackaged ? 'packaged' : 'dev'})`}
              />
              <Row label="Platform" value={`${info.platform} · ${info.arch}`} />
              <Row label="Electron" value={info.versions.electron} />
              <Row label="Chromium" value={info.versions.chrome} />
              <Row label="Node" value={info.versions.node} />
            </dl>
          )}
        </section>
      </main>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="panel__key">{label}</dt>
      <dd className="panel__value">{value}</dd>
    </>
  )
}
