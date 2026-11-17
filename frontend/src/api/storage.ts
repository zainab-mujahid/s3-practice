import { getJson } from './client'

export type StorageCheck =
  | 'ok'
  | 'denied'
  | 'bucket_not_found'
  | 'wrong_region'
  | 'no_credentials'
  | 'unavailable'
  | 'not_configured'

export interface StorageHealth {
  ok: boolean
  publicBucket: StorageCheck
  privateBucket: StorageCheck
  checkedAt: string
}

/** Owner only. Makes one read-only S3 call per bucket on the backend; call it on demand only. */
export function fetchStorageHealth(): Promise<StorageHealth> {
  return getJson<StorageHealth>('/admin/storage/health')
}
