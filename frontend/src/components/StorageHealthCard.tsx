import { useState } from 'react'
import { ApiError } from '../api/client'
import { fetchStorageHealth, type StorageCheck, type StorageHealth } from '../api/storage'
import { Alert, Card, Spinner } from './ui'

const MEANING: Record<StorageCheck, string> = {
  ok: 'Reachable with the backend IAM identity.',
  denied: 'Access denied: check the IAM policy, the bucket policy and AWS_EXPECTED_BUCKET_OWNER.',
  bucket_not_found: 'Bucket not found: check the bucket name in backend/.env.',
  wrong_region: 'The bucket is in another region: check AWS_REGION.',
  no_credentials: 'No valid AWS credentials: check AWS_PROFILE and ~/.aws/credentials.',
  unavailable: 'S3 could not be reached (network, throttling or an AWS error).',
  not_configured: 'Bucket names in backend/.env are still placeholders, so no AWS call was made.',
}

function Row({ label, value }: { label: string; value: StorageCheck }) {
  const good = value === 'ok'
  return (
    <div className="flex items-start gap-3 py-2">
      <span className={`mt-0.5 rounded px-1.5 py-0.5 font-mono text-xs ${good ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
        {value}
      </span>
      <div className="text-sm">
        <div className="font-medium text-slate-800">{label}</div>
        <div className="text-slate-500">{MEANING[value]}</div>
      </div>
    </div>
  )
}

/**
 * On-demand check only (never automatic): each click makes one read-only
 * ListObjectsV2 call per bucket from the backend. The browser never talks to
 * AWS here and never sees bucket names, keys or credentials.
 */
export function StorageHealthCard({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [state, setState] = useState<{ loading: boolean; result?: StorageHealth; error?: string }>({ loading: false })

  const run = async () => {
    setState({ loading: true })
    try {
      setState({ loading: false, result: await fetchStorageHealth() })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      const message =
        err instanceof ApiError && err.status === 429 ? 'Too many checks: wait a minute and try again.' : 'The check could not be run.'
      setState({ loading: false, error: message })
    }
  }

  return (
    <Card title="S3 connection" aside={<span className="text-xs text-slate-400">GET /api/admin/storage/health · Owner only</span>}>
      <p className="mb-3 text-sm text-slate-600">
        Read-only check that the backend can reach both buckets with its own AWS identity.
      </p>
      <button
        type="button"
        onClick={() => void run()}
        disabled={state.loading}
        className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
      >
        Check S3 connection
      </button>
      <div className="mt-3">
        {state.loading && <Spinner />}
        {state.error && <Alert kind="error">{state.error}</Alert>}
        {state.result && (
          <div className="divide-y divide-slate-100">
            <Row label="Public bucket (dishes, logo)" value={state.result.publicBucket} />
            <Row label="Private bucket (staff pictures)" value={state.result.privateBucket} />
          </div>
        )}
      </div>
    </Card>
  )
}
