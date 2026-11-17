import type { ReactNode } from 'react'
import type { Role } from '../api/auth'

export function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

export function Placeholder({ step, children }: { step: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
      <span className="mr-2 rounded bg-slate-200 px-1.5 py-0.5 text-xs font-medium text-slate-600">{step}</span>
      {children}
    </div>
  )
}

const ALERT_STYLES = {
  error: 'border-rose-200 bg-rose-50 text-rose-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  info: 'border-sky-200 bg-sky-50 text-sky-800',
}

export function Alert({ kind, children, onClose }: { kind: keyof typeof ALERT_STYLES; children: ReactNode; onClose?: () => void }) {
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${ALERT_STYLES[kind]}`}>
      <div>{children}</div>
      {onClose && (
        <button type="button" onClick={onClose} className="text-xs font-medium opacity-70 hover:opacity-100" aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  )
}

export function RoleBadge({ role }: { role: Role | 'VISITOR' }) {
  const styles = {
    OWNER: 'bg-violet-100 text-violet-800 ring-violet-200',
    STAFF: 'bg-sky-100 text-sky-800 ring-sky-200',
    VISITOR: 'bg-slate-100 text-slate-700 ring-slate-200',
  }[role]
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${styles}`}>{role}</span>
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
      {label}
    </div>
  )
}
