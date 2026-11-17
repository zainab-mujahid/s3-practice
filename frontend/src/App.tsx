import { useEffect, useState } from 'react'
import { fetchHealth } from './api/client'

type BackendState = { kind: 'checking' } | { kind: 'up'; at: string } | { kind: 'down' }

function BackendStatus() {
  const [state, setState] = useState<BackendState>({ kind: 'checking' })

  useEffect(() => {
    const controller = new AbortController()
    fetchHealth(controller.signal)
      .then((h) => setState({ kind: 'up', at: h.timestamp }))
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) setState({ kind: 'down' })
      })
    return () => controller.abort()
  }, [])

  const styles = {
    checking: 'bg-slate-100 text-slate-600 ring-slate-200',
    up: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    down: 'bg-rose-50 text-rose-700 ring-rose-200',
  }[state.kind]

  const label = {
    checking: 'Checking backend…',
    up: 'Backend connected',
    down: 'Backend unreachable',
  }[state.kind]

  return (
    <span
      role="status"
      title={state.kind === 'up' ? `Last check: ${state.at}` : undefined}
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ${styles}`}
    >
      <span
        className={`h-2 w-2 rounded-full ${
          state.kind === 'up' ? 'bg-emerald-500' : state.kind === 'down' ? 'bg-rose-500' : 'bg-slate-400'
        }`}
      />
      {label}
    </span>
  )
}

function PlaceholderCard({ title, step, children }: { title: string; step: string; children: string }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <span className="text-xs text-slate-400">{step}</span>
      </div>
      <p className="mt-2 text-sm text-slate-600">{children}</p>
    </section>
  )
}

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Restaurant S3 Practice</h1>
            <p className="text-xs text-slate-500">React → NestJS → presigned URLs → Amazon S3</p>
          </div>
          <BackendStatus />
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl gap-4 px-4 py-6 md:grid-cols-3">
        <PlaceholderCard title="Public gallery" step="Step 4">
          Restaurant logo and dish images, served from public S3 URLs. No login required.
        </PlaceholderCard>
        <PlaceholderCard title="Owner dashboard" step="Steps 2, 4, 5">
          Manage dishes, the logo and all staff profile pictures.
        </PlaceholderCard>
        <PlaceholderCard title="Staff dashboard" step="Steps 2, 5">
          View and replace your own private profile picture via short-lived presigned URLs.
        </PlaceholderCard>
      </main>
    </div>
  )
}
