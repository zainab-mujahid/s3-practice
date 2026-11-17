import { AccessChecks } from './AccessChecks'
import { Card, Placeholder } from './ui'

/** Visible to everyone, including anonymous visitors. */
export function PublicGallery({ showVisitorChecks }: { showVisitorChecks: boolean }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="space-y-4 md:col-span-2">
        <Card title="Restaurant logo">
          <Placeholder step="Step 4">The logo will load from a public S3 URL, without logging in.</Placeholder>
        </Card>
        <Card title="Dishes">
          <Placeholder step="Step 4">Dish photos will load from public S3 URLs, without logging in.</Placeholder>
        </Card>
      </div>
      {showVisitorChecks && (
        <AccessChecks
          title="Visitor access checks"
          checks={[
            { label: 'Public health check', path: '/health', expected: 200 },
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
