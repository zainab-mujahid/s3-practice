import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import {
  checkFile,
  deleteImage,
  fetchPublicImages,
  type ImageKind,
  type PublicImage,
  type PublicImages,
  S3UploadError,
  uploadImage,
  type UploadStage,
} from '../api/images'
import { Alert, Card, Spinner } from './ui'

type Notice = { kind: 'success' | 'error' | 'warning'; text: string }

const STAGE_TEXT: Record<UploadStage, string> = {
  authorizing: 'Requesting upload permission…',
  uploading: 'Uploading to Amazon S3…',
  verifying: 'Verifying and publishing…',
}

function describeError(err: unknown): string {
  if (err instanceof S3UploadError) return err.message
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to manage restaurant images.'
    if (err.status === 429) return 'Too many requests. Please wait a minute and try again.'
    if (err.status >= 500) return err.status === 503 ? err.message : 'The server could not complete the request. Please try again.'
    return err.message
  }
  return 'Something went wrong. Check your connection and try again.'
}

type Selected = { file: File; preview: string } | null

/**
 * The selected (not yet uploaded) file and a local object-URL preview of it.
 * The previous object URL is revoked on every change and on unmount.
 */
function useSelectedFile(): [Selected, (file: File | null) => void] {
  const [selected, setSelected] = useState<Selected>(null)
  const current = useRef<string | null>(null)
  const select = useCallback((file: File | null) => {
    if (current.current) URL.revokeObjectURL(current.current)
    current.current = file ? URL.createObjectURL(file) : null
    setSelected(file && current.current ? { file, preview: current.current } : null)
  }, [])
  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current)
    },
    [],
  )
  return [selected, select]
}

interface UploadPanelProps {
  label: string
  kind: ImageKind
  targetAssetId?: string
  disabled: boolean
  setBusy: (busy: boolean) => void
  onDone: (notice: Notice) => void
  onUnauthorized: () => void
  onCancel?: () => void
}

/** File picker + preview + upload with progress. One upload at a time (the parent holds `busy`). */
function UploadPanel({ label, kind, targetAssetId, disabled, setBusy, onDone, onUnauthorized, onCancel }: UploadPanelProps) {
  const [selected, setFile] = useSelectedFile()
  const file = selected?.file ?? null
  const [stage, setStage] = useState<UploadStage | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const preview = selected?.preview ?? null
  const inputId = `upload-${kind}-${targetAssetId ?? 'new'}`

  useEffect(() => () => abortRef.current?.abort(), [])

  function choose(f: File | null) {
    setError(null)
    if (f) {
      const problem = checkFile(f)
      if (problem) {
        setFile(null)
        setError(problem)
        if (inputRef.current) inputRef.current.value = ''
        return
      }
    }
    setFile(f)
  }

  function reset() {
    setFile(null)
    setStage(null)
    setProgress(0)
    if (inputRef.current) inputRef.current.value = ''
  }

  async function submit() {
    if (!file || stage || disabled) return // prevents duplicate submissions
    setBusy(true)
    setError(null)
    abortRef.current = new AbortController()
    try {
      const res = await uploadImage({ kind, file, targetAssetId, onStage: setStage, onProgress: setProgress, signal: abortRef.current.signal })
      reset()
      onDone({ kind: 'success', text: res.replaced ? 'Image replaced and published.' : 'Image uploaded and published.' })
    } catch (err) {
      setStage(null)
      setProgress(0)
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      setError(describeError(err))
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  const uploading = stage !== null
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <label htmlFor={inputId} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={uploading || disabled}
        onChange={(e) => choose(e.target.files?.[0] ?? null)}
        className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-200 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-slate-300"
      />
      {preview && (
        <img src={preview} alt="Selected file preview" className="h-24 w-24 rounded-md border border-slate-200 object-cover" />
      )}
      {uploading && (
        <div role="status" aria-live="polite" className="space-y-1">
          <div className="text-xs text-slate-600">
            {STAGE_TEXT[stage]}
            {stage === 'uploading' && ` ${Math.round(progress * 100)}%`}
          </div>
          {stage === 'uploading' && (
            <div className="h-1.5 w-full overflow-hidden rounded bg-slate-200">
              <div className="h-full bg-slate-700 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!file || uploading || disabled}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
        {uploading && stage === 'uploading' && (
          <button type="button" onClick={() => abortRef.current?.abort()} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700">
            Cancel upload
          </button>
        )}
        {onCancel && !uploading && (
          <button type="button" onClick={onCancel} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700">
            Close
          </button>
        )}
      </div>
    </div>
  )
}

/** Two-step delete: the first click asks for confirmation. */
function DeleteButton({ what, disabled, onConfirm }: { what: string; disabled: boolean; onConfirm: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  if (!confirming) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setConfirming(true)}
        className="rounded-md border border-rose-300 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
      >
        Delete
      </button>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-rose-700">Delete {what} permanently?</span>
      <button
        type="button"
        disabled={working || disabled}
        onClick={async () => {
          setWorking(true)
          try {
            await onConfirm()
          } finally {
            setWorking(false)
            setConfirming(false)
          }
        }}
        className="rounded-md bg-rose-600 px-2.5 py-1 font-medium text-white hover:bg-rose-700 disabled:opacity-50"
      >
        {working ? 'Deleting…' : 'Yes, delete'}
      </button>
      <button type="button" disabled={working} onClick={() => setConfirming(false)} className="rounded-md border border-slate-300 px-2.5 py-1 text-slate-700">
        Cancel
      </button>
    </span>
  )
}

/** OWNER: manage the restaurant logo and dish images (public bucket). */
export function OwnerImageManager({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [images, setImages] = useState<PublicImages | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [replacing, setReplacing] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setImages(await fetchPublicImages())
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchPublicImages()
      .then((data) => !cancelled && setImages(data))
      .catch(() => !cancelled && setLoadError(true))
    return () => {
      cancelled = true
    }
  }, [])

  const done = useCallback(
    (n: Notice) => {
      setNotice(n)
      setReplacing(null)
      void reload()
    },
    [reload],
  )

  async function remove(image: PublicImage) {
    setBusy(true)
    try {
      await deleteImage(image.assetId)
      done({ kind: 'success', text: image.kind === 'LOGO' ? 'Logo deleted.' : 'Dish image deleted.' })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      setNotice({ kind: 'error', text: describeError(err) })
      void reload()
    } finally {
      setBusy(false)
    }
  }

  const common = { disabled: busy, setBusy, onDone: done, onUnauthorized }

  return (
    <Card title="Restaurant images" aside={<span className="text-xs text-slate-400">Public bucket · Owner only</span>}>
      <div className="space-y-5">
        {notice && (
          <Alert kind={notice.kind} onClose={() => setNotice(null)}>
            {notice.text}
          </Alert>
        )}
        {loadError && <Alert kind="error">Could not load the current images.</Alert>}
        {!images && !loadError && <Spinner />}

        {images && (
          <>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-800">Logo</h3>
              {images.logo ? (
                <div className="flex flex-wrap items-center gap-3">
                  <img src={images.logo.url} alt="Current restaurant logo" className="h-20 w-20 rounded-md border border-slate-200 object-contain" />
                  <DeleteButton what="the logo" disabled={busy} onConfirm={() => remove(images.logo!)} />
                </div>
              ) : (
                <p className="text-sm text-slate-500">No logo yet.</p>
              )}
              <UploadPanel label={images.logo ? 'Replace logo' : 'Upload logo'} kind="LOGO" {...common} />
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-800">Dish images ({images.dishes.length})</h3>
              {images.dishes.length === 0 && <p className="text-sm text-slate-500">No dish images yet.</p>}
              <ul className="grid gap-3 sm:grid-cols-2">
                {images.dishes.map((d, i) => (
                  <li key={d.assetId} className="space-y-2 rounded-lg border border-slate-200 p-2">
                    <img src={d.url} alt={`Dish image ${i + 1}`} className="aspect-video w-full rounded-md object-cover" loading="lazy" />
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setReplacing(replacing === d.assetId ? null : d.assetId)}
                        className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                      >
                        Replace
                      </button>
                      <DeleteButton what={`dish image ${i + 1}`} disabled={busy} onConfirm={() => remove(d)} />
                    </div>
                    {replacing === d.assetId && (
                      <UploadPanel label={`Replace dish image ${i + 1}`} kind="DISH" targetAssetId={d.assetId} onCancel={() => setReplacing(null)} {...common} />
                    )}
                  </li>
                ))}
              </ul>
              <UploadPanel label="Add a dish image" kind="DISH" {...common} />
            </section>
            <p className="text-xs text-slate-500">JPEG, PNG or WebP, up to 5 MB. Files go straight to Amazon S3 and are published only after the server verifies them.</p>
          </>
        )}
      </div>
    </Card>
  )
}
