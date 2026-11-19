import { useEffect, useState } from 'react'
import { fetchPublicImages, type PublicImages } from '../api/images'
import { AccessChecks } from './AccessChecks'
import { Alert, Card, Spinner } from './ui'

type State = { kind: 'loading' } | { kind: 'ready'; images: PublicImages } | { kind: 'error' }

/**
 * Visible to everyone, including anonymous visitors. Images load directly from
 * their permanent public S3 URLs (no login, no AWS credentials); only images the
 * backend has verified and published are listed.
 */
export function PublicGallery({ showVisitorChecks }: { showVisitorChecks: boolean }) {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    fetchPublicImages()
      .then((images) => !cancelled && setState({ kind: 'ready', images }))
      .catch(() => !cancelled && setState({ kind: 'error' }))
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="space-y-4 md:col-span-2">
        {state.kind === 'loading' && <Spinner label="Loading images…" />}
        {state.kind === 'error' && <Alert kind="error">Could not load the restaurant images.</Alert>}
        {state.kind === 'ready' && (
          <>
            <Card title="Restaurant logo">
              {state.images.logo ? (
                <img src={state.images.logo.url} alt="Restaurant logo" className="h-32 w-32 object-contain" />
              ) : (
                <p className="text-sm text-slate-500">No logo has been published yet.</p>
              )}
            </Card>
            <Card title="Dishes">
              {state.images.dishes.length === 0 ? (
                <p className="text-sm text-slate-500">No dish images have been published yet.</p>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2">
                  {state.images.dishes.map((d, i) => (
                    <li key={d.assetId}>
                      <img src={d.url} alt={`Dish ${i + 1}`} loading="lazy" className="aspect-video w-full rounded-lg object-cover" />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
      {showVisitorChecks && (
        <AccessChecks
          title="Visitor access checks"
          checks={[
            { label: 'Public health check', path: '/health', expected: 200 },
            { label: 'Published images (public)', path: '/public/images', expected: 200 },
            { label: 'My profile (requires login)', path: '/profile/me', expected: 401 },
            { label: 'Staff list (Owner only)', path: '/staff', expected: 401 },
            { label: 'A staff record', path: '/staff/staff-001', expected: 401 },
            { label: 'S3 health check (Owner only)', path: '/admin/storage/health', expected: 401 },
          ]}
        />
      )}
    </div>
  )
}
