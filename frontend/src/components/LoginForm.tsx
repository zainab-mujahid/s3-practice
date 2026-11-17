import { type FormEvent, useState } from 'react'
import { login, type User } from '../api/auth'
import { ApiError } from '../api/client'
import { Alert, Card } from './ui'

function describeLoginError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Invalid username or password.'
    if (err.status === 429) {
      const minutes = err.retryAfterSeconds ? Math.ceil(err.retryAfterSeconds / 60) : null
      return minutes
        ? `Too many failed attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
        : 'Too many login attempts. Please wait a minute and try again.'
    }
    if (err.status === 400) return 'Please enter a valid username and password.'
    if (err.status === 403) return 'The request was rejected (security check). Reload the page and try again.'
    if (err.status === 503) return 'The server is temporarily unavailable. Please try again.'
    return err.message
  }
  return 'Cannot reach the backend. Is it running?'
}

export function LoginForm({ onLoggedIn, onCancel }: { onLoggedIn: (u: User) => void; onCancel: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const user = await login(username, password)
      setPassword('')
      onLoggedIn(user)
    } catch (err) {
      setError(describeLoginError(err))
    } finally {
      setSubmitting(false)
    }
  }

  const input =
    'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500'

  return (
    <div className="mx-auto max-w-sm">
      <Card title="Owner / Staff login">
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert kind="error">{error}</Alert>}
          <label className="block text-sm font-medium text-slate-700">
            Username
            <input
              className={input}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={64}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="owner, staff-001 or staff-002"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Password
            <input
              className={input}
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-800">
              ← Back to gallery
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Test accounts are created by running <code>npm run setup:accounts</code> in the backend. Passwords are never stored
            in this frontend.
          </p>
        </form>
      </Card>
    </div>
  )
}
