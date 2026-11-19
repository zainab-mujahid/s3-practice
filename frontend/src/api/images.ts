/**
 * Public restaurant images (Step 4).
 *
 * Upload flow (OWNER only — the backend enforces this, not the UI):
 *   1. POST /api/admin/images/uploads             -> uploadId + presigned POST (url + form fields)
 *   2. multipart POST of fields + file straight to S3 (no cookies, no AWS secret in the browser)
 *   3. POST /api/admin/images/uploads/:id/complete -> backend verifies the bytes and publishes
 *
 * The presigned fields are kept in memory for one upload only and are never
 * logged or displayed. The staging key is never shown as an image URL: only
 * URLs returned by the backend after publication are rendered.
 */
import { getJson, send } from './client'

export type ImageKind = 'LOGO' | 'DISH'

export interface PublicImage {
  assetId: string
  kind: ImageKind
  url: string
  contentType: string
  sizeBytes: number
  updatedAt: string
}

export interface PublicImages {
  logo: PublicImage | null
  dishes: PublicImage[]
}

export interface UploadAuthorization {
  uploadId: string
  expiresAt: string
  completeBy: string
  upload: { url: string; fields: Record<string, string> }
}

/** Mirrors the backend rules for early feedback only; the backend re-checks everything. */
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const MIN_BYTES = 32
export const MAX_BYTES = 5 * 1024 * 1024

export function checkFile(file: File): string | null {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) return 'Only JPEG, PNG and WebP images are allowed.'
  if (file.size < MIN_BYTES) return 'This file is too small to be an image.'
  if (file.size > MAX_BYTES) return 'This file is too large (maximum 5 MB).'
  return null
}

export const fetchPublicImages = () => getJson<PublicImages>('/public/images')

export function requestUpload(kind: ImageKind, file: File, targetAssetId?: string): Promise<UploadAuthorization> {
  return send<UploadAuthorization>('POST', '/admin/images/uploads', {
    kind,
    ...(targetAssetId ? { targetAssetId } : {}),
    fileName: file.name,
    contentType: file.type,
    size: file.size,
  })
}

export const completeUpload = (uploadId: string) =>
  send<{ image: PublicImage; replaced: boolean }>('POST', `/admin/images/uploads/${encodeURIComponent(uploadId)}/complete`)

export const deleteImage = (assetId: string) => send<null>('DELETE', `/admin/images/${encodeURIComponent(assetId)}`)

export type S3UploadFailure = 'expired' | 'too_large' | 'too_small' | 'rejected' | 'network' | 'aborted'

export class S3UploadError extends Error {
  readonly reason: S3UploadFailure
  constructor(reason: S3UploadFailure) {
    super(S3_MESSAGES[reason])
    this.name = 'S3UploadError'
    this.reason = reason
  }
}

const S3_MESSAGES: Record<S3UploadFailure, string> = {
  expired: 'The upload link expired before the upload finished. Please try again.',
  too_large: 'Amazon S3 rejected the file as too large (maximum 5 MB).',
  too_small: 'Amazon S3 rejected the file as too small.',
  rejected: 'Amazon S3 rejected the upload. Please try again.',
  network: 'The upload to Amazon S3 failed (network or CORS error). Check your connection and try again.',
  aborted: 'The upload was cancelled.',
}

/** Maps an S3 XML error body to a safe reason. The raw body (request IDs etc.) is never shown. */
function classifyS3Error(status: number, body: string): S3UploadFailure {
  const code = /<Code>([^<]{1,64})<\/Code>/.exec(body)?.[1] ?? ''
  const message = /<Message>([^<]{0,300})<\/Message>/.exec(body)?.[1] ?? ''
  if (code === 'EntityTooLarge') return 'too_large'
  if (code === 'EntityTooSmall') return 'too_small'
  if (/expired/i.test(message) || code === 'ExpiredToken' || code === 'RequestExpired') return 'expired'
  return status === 0 ? 'network' : 'rejected'
}

/**
 * Multipart POST straight to S3. All signed fields first, the file LAST (S3
 * ignores fields after the file). No credentials/cookies are sent to S3.
 *
 * Progress: listening to upload progress makes the browser send a CORS
 * preflight (OPTIONS). The bucket's CORS rule (origin http://localhost:5173,
 * method POST, no extra headers) is expected to allow it; if not, this fails
 * with 'network' and the CORS rule must be reviewed (not widened) manually.
 */
export function uploadToS3(
  auth: UploadAuthorization,
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (Date.parse(auth.expiresAt) <= Date.now()) return Promise.reject(new S3UploadError('expired'))

  return new Promise<void>((resolve, reject) => {
    const form = new FormData()
    for (const [name, value] of Object.entries(auth.upload.fields)) form.append(name, value)
    form.append('file', file)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', auth.upload.url)
    xhr.withCredentials = false
    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(Math.min(e.loaded / e.total, 1))
      })
    }
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1)
        resolve()
      } else {
        reject(new S3UploadError(classifyS3Error(xhr.status, typeof xhr.responseText === 'string' ? xhr.responseText : '')))
      }
    })
    xhr.addEventListener('error', () => reject(new S3UploadError('network')))
    xhr.addEventListener('timeout', () => reject(new S3UploadError('network')))
    xhr.addEventListener('abort', () => reject(new S3UploadError('aborted')))
    if (signal) {
      if (signal.aborted) return reject(new S3UploadError('aborted'))
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    xhr.send(form)
  })
}

export type UploadStage = 'authorizing' | 'uploading' | 'verifying'

/** The whole flow. Throws ApiError (backend) or S3UploadError (S3). */
export async function uploadImage(input: {
  kind: ImageKind
  file: File
  targetAssetId?: string
  onStage?: (stage: UploadStage) => void
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}): Promise<{ image: PublicImage; replaced: boolean }> {
  input.onStage?.('authorizing')
  const auth = await requestUpload(input.kind, input.file, input.targetAssetId)
  input.onStage?.('uploading')
  await uploadToS3(auth, input.file, input.onProgress, input.signal)
  input.onStage?.('verifying')
  return completeUpload(auth.uploadId)
}
