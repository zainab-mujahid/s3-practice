import { useCallback, useEffect, useState } from 'react'
import { fetchCurrentUser, logout, type User } from './api/auth'
import { fetchHealth } from './api/client'
import { OwnerDashboard, StaffDashboard } from './components/Dashboards'
import { LoginForm } from './components/LoginForm'
import { PublicGallery } from './components/PublicGallery'
import { Alert, RoleBadge, Spinner } from './components/ui'

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
  const dot = { checking: 'bg-slate-400', up: 'bg-emerald-500', down: 'bg-rose-500' }[state.kind]
  const label = { checking: 'Checking backend…', up: 'Backend connected', down: 'Backend unreachable' }[state.kind]

  return (
    <span
      role="status"
      title={state.kind === 'up' ? `Last check: ${state.at}` : undefined}
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ${styles}`}
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

type Auth = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: User }
type View = 'gallery' | 'login' | 'dashboard'

export default function App() {
  const [auth, setAuth] = useState<Auth>({ status: 'loading' })
  const [view, setView] = useState<View>('gallery')
  const [notice, setNotice] = useState<{ kind: 'info' | 'warning' | 'error'; text: string } | null>(null)

  // Restore the session after a refresh (the HttpOnly cookie is sent automatically).
  useEffect(() => {
    fetchCurrentUser()
      .then((user) => {
        if (user) {
          setAuth({ status: 'authenticated', user })
          setView('dashboard')
        } else {
          setAuth({ status: 'anonymous' })
        }
      })
      .catch(() => {
        setAuth({ status: 'anonymous' })
        setNotice({ kind: 'error', text: 'Could not check your session. Is the backend running?' })
      })
  }, [])

  const handleUnauthorized = useCallback(() => {
    setAuth({ status: 'anonymous' })
    setView('login')
    setNotice({ kind: 'warning', text: 'Your session has expired or was signed out. Please log in again.' })
  }, [])

  async function handleLogout() {
    try {
      await logout()
      setNotice({ kind: 'info', text: 'You have been logged out.' })
    } catch {
      setNotice({ kind: 'warning', text: 'Logout request failed; your local view was reset. Reload to verify.' })
    }
    setAuth({ status: 'anonymous' })
    setView('gallery')
  }

  const user = auth.status === 'authenticated' ? auth.user : null
  const tab = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium ${active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Restaurant S3 Practice</h1>
            <p className="text-xs text-slate-500">React → NestJS → presigned URLs → Amazon S3</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <BackendStatus />
            {auth.status !== 'loading' && (
              <div className="flex items-center gap-2 text-sm">
                <RoleBadge role={user?.role ?? 'VISITOR'} />
                {user ? (
                  <>
                    <span className="text-slate-700">{user.displayName}</span>
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="rounded-md border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-100"
                    >
                      Log out
                    </button>
                  </>
                ) : (
                  view !== 'login' && (
                    <button
                      type="button"
                      onClick={() => setView('login')}
                      className="rounded-md bg-slate-900 px-3 py-1 text-sm font-medium text-white hover:bg-slate-700"
                    >
                      Log in
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        </div>
        {user && (
          <nav className="mx-auto flex max-w-5xl gap-2 px-4 pb-3">
            <button type="button" className={tab(view === 'dashboard')} onClick={() => setView('dashboard')}>
              {user.role === 'OWNER' ? 'Owner dashboard' : 'Staff dashboard'}
            </button>
            <button type="button" className={tab(view === 'gallery')} onClick={() => setView('gallery')}>
              Public gallery
            </button>
          </nav>
        )}
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        {notice && (
          <Alert kind={notice.kind} onClose={() => setNotice(null)}>
            {notice.text}
          </Alert>
        )}

        {auth.status === 'loading' && <Spinner label="Checking your session…" />}

        {auth.status === 'anonymous' && view === 'login' && (
          <LoginForm
            onLoggedIn={(u) => {
              setAuth({ status: 'authenticated', user: u })
              setView('dashboard')
              setNotice(null)
            }}
            onCancel={() => setView('gallery')}
          />
        )}

        {auth.status !== 'loading' && view === 'gallery' && <PublicGallery showVisitorChecks={!user} />}

        {user && view === 'dashboard' && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
              Signed in as <span className="font-medium text-slate-900">{user.username}</span>
              <RoleBadge role={user.role} />
              {user.staffId && <span className="font-mono text-xs text-slate-500">({user.staffId})</span>}
            </div>
            {user.role === 'OWNER' ? (
              <OwnerDashboard user={user} onUnauthorized={handleUnauthorized} />
            ) : (
              <StaffDashboard user={user} onUnauthorized={handleUnauthorized} />
            )}
          </>
        )}
      </main>
    </div>
  )
}
