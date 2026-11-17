import { useState } from 'react'
import { probe } from '../api/client'
import { Card } from './ui'

export interface AccessCheck {
  label: string
  path: string
  expected: number
}

type Result = { status: number } | { error: true }

const STATUS_TEXT: Record<number, string> = {
  200: 'Allowed',
  400: 'Bad request',
  401: 'Not logged in',
  403: 'Forbidden',
  404: 'Not found',
  429: 'Rate limited',
}

/**
 * Calls real backend endpoints and shows the HTTP status the SERVER returned.
 * This demonstrates server-side enforcement: the UI does not decide anything here.
 */
export function AccessChecks({ title, checks }: { title: string; checks: AccessCheck[] }) {
  const [results, setResults] = useState<Record<string, Result>>({})
  const [running, setRunning] = useState(false)

  async function run() {
    setRunning(true)
    const next: Record<string, Result> = {}
    for (const c of checks) {
      try {
        next[c.path] = { status: await probe(c.path) }
      } catch {
        next[c.path] = { error: true }
      }
    }
    setResults(next)
    setRunning(false)
  }

  return (
    <Card
      title={title}
      aside={
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {running ? 'Checking…' : 'Run checks'}
        </button>
      }
    >
      <p className="mb-3 text-xs text-slate-500">
        Each row calls the backend directly. The result is decided by NestJS guards, not by this page.
      </p>
      <ul className="divide-y divide-slate-100 text-sm">
        {checks.map((c) => {
          const r = results[c.path]
          const status = r && 'status' in r ? r.status : undefined
          const matches = status === c.expected
          return (
            <li key={c.path} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <div className="text-slate-800">{c.label}</div>
                <code className="text-xs text-slate-500">GET /api{c.path}</code>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">expect {c.expected}</span>
                {r &&
                  ('error' in r ? (
                    <span className="rounded bg-rose-100 px-2 py-0.5 font-medium text-rose-800">network error</span>
                  ) : (
                    <span
                      className={`rounded px-2 py-0.5 font-medium ${matches ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}
                    >
                      {status} {STATUS_TEXT[status!] ?? ''} {matches ? '✓' : '✗ unexpected'}
                    </span>
                  ))}
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
