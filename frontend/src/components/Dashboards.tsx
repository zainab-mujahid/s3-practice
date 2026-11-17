import { type ReactNode, useEffect, useState } from 'react'
import { fetchProfile, fetchStaffList, type Profile, type StaffRecord, type User } from '../api/auth'
import { ApiError } from '../api/client'
import { AccessChecks } from './AccessChecks'
import { Alert, Card, Placeholder, RoleBadge, Spinner } from './ui'

type Load<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; message: string }

function useLoad<T>(loader: () => Promise<T>, onUnauthorized: () => void): Load<T> {
  const [result, setResult] = useState<Load<T>>({ state: 'loading' })
  useEffect(() => {
    let cancelled = false
    loader()
      .then((data) => !cancelled && setResult({ state: 'ready', data }))
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) return onUnauthorized()
        const message =
          err instanceof ApiError && err.status === 403 ? 'You do not have permission to view this.' : 'Could not load data.'
        setResult({ state: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [loader, onUnauthorized])
  return result
}

function ProfileCard({ profile }: { profile: Profile }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-slate-500">Name</dt>
      <dd className="text-slate-900">{profile.displayName}</dd>
      <dt className="text-slate-500">Username</dt>
      <dd className="font-mono text-slate-900">{profile.username}</dd>
      <dt className="text-slate-500">Role</dt>
      <dd>
        <RoleBadge role={profile.role} />
      </dd>
      {profile.staffId && (
        <>
          <dt className="text-slate-500">Staff ID</dt>
          <dd className="font-mono text-slate-900">{profile.staffId}</dd>
        </>
      )}
      <dt className="text-slate-500">Position</dt>
      <dd className="text-slate-900">{profile.position}</dd>
    </dl>
  )
}

function Loaded<T>({ load, children }: { load: Load<T>; children: (data: T) => ReactNode }) {
  if (load.state === 'loading') return <Spinner />
  if (load.state === 'error') return <Alert kind="error">{load.message}</Alert>
  return <>{children(load.data)}</>
}

export function OwnerDashboard({ onUnauthorized }: { user: User; onUnauthorized: () => void }) {
  const staff = useLoad<StaffRecord[]>(fetchStaffList, onUnauthorized)

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="space-y-4 md:col-span-2">
        <Card title="Staff members" aside={<span className="text-xs text-slate-400">GET /api/staff · Owner only</span>}>
          <Loaded load={staff}>
            {(rows) => (
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-1 pr-2">Staff ID</th>
                    <th className="py-1 pr-2">Name</th>
                    <th className="py-1">Position</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((s) => (
                    <tr key={s.staffId}>
                      <td className="py-2 pr-2 font-mono">{s.staffId}</td>
                      <td className="py-2 pr-2">{s.displayName}</td>
                      <td className="py-2">{s.position}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Loaded>
          <div className="mt-3">
            <Placeholder step="Step 5">Upload, replace, view and delete staff profile pictures (private bucket).</Placeholder>
          </div>
        </Card>
        <Card title="Restaurant images">
          <Placeholder step="Step 4">Upload, replace and delete the logo and dish photos (public bucket).</Placeholder>
        </Card>
      </div>
      <AccessChecks
        title="Owner access checks"
        checks={[
          { label: 'My profile', path: '/profile/me', expected: 200 },
          { label: 'List all staff', path: '/staff', expected: 200 },
          { label: 'Staff A record', path: '/staff/staff-001', expected: 200 },
          { label: 'Staff B record', path: '/staff/staff-002', expected: 200 },
          { label: 'Unknown staff ID', path: '/staff/staff-999', expected: 404 },
          { label: 'Path traversal attempt', path: '/staff/..%2Fowner', expected: 400 },
        ]}
      />
    </div>
  )
}

export function StaffDashboard({ user, onUnauthorized }: { user: User; onUnauthorized: () => void }) {
  const profile = useLoad<Profile>(fetchProfile, onUnauthorized)
  // Probe targets only; the backend decides the outcome.
  const own = user.staffId ?? 'staff-001'
  const other = own === 'staff-001' ? 'staff-002' : 'staff-001'

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="space-y-4 md:col-span-2">
        <Card title="My profile" aside={<span className="text-xs text-slate-400">GET /api/profile/me</span>}>
          <Loaded load={profile}>{(p) => <ProfileCard profile={p} />}</Loaded>
        </Card>
        <Card title="My profile picture">
          <Placeholder step="Step 5">
            Upload or replace your own picture; view it through a short-lived presigned URL from the private bucket.
          </Placeholder>
        </Card>
      </div>
      <AccessChecks
        title="Staff access checks"
        checks={[
          { label: 'My profile', path: '/profile/me', expected: 200 },
          { label: `My staff record (${own})`, path: `/staff/${own}`, expected: 200 },
          { label: `Another staff member (${other})`, path: `/staff/${other}`, expected: 403 },
          { label: 'List all staff (Owner only)', path: '/staff', expected: 403 },
          { label: 'Unknown staff ID', path: '/staff/staff-999', expected: 403 },
        ]}
      />
    </div>
  )
}
