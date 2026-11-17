/**
 * Minimal API client. All calls are relative (/api/...), so in development
 * they go through the Vite proxy to NestJS on the same origin, and the
 * HttpOnly session cookie is sent automatically.
 *
 * CSRF: state-changing requests carry X-CSRF-Token. The token comes from
 * GET /api/auth/csrf (or the login response) and is kept in memory only.
 *
 * Never put secrets in this folder: everything under src/ ships to the browser.
 * Role checks in the UI are for presentation only; the backend enforces access.
 */

export class ApiError extends Error {
  readonly status: number
  readonly retryAfterSeconds?: number

  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

let csrfToken: string | null = null

export function setCsrfToken(token: string | null) {
  csrfToken = token
}

interface ParsedResponse {
  status: number
  ok: boolean
  body: unknown
  retryAfter?: number
}

async function rawRequest(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<ParsedResponse> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken

  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  const retry = Number(res.headers.get('Retry-After'))
  return { status: res.status, ok: res.ok, body: parsed, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined }
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message
    if (typeof m === 'string') return m
    if (Array.isArray(m)) return m.join(', ')
  }
  return `Request failed with status ${status}`
}

function unwrap<T>(r: ParsedResponse): T {
  if (!r.ok) throw new ApiError(r.status, errorMessage(r.body, r.status), r.retryAfter)
  return r.body as T
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return unwrap<T>(await rawRequest('GET', path, undefined, signal))
}

async function ensureCsrfToken(): Promise<void> {
  if (!csrfToken) {
    const { csrfToken: token } = await getJson<{ csrfToken: string }>('/auth/csrf')
    csrfToken = token
  }
}

const isCsrfFailure = (r: ParsedResponse) => r.status === 403 && errorMessage(r.body, r.status).includes('CSRF')

/** POST/PUT/DELETE with CSRF token. Refreshes a stale token once (e.g. after the session expired). */
export async function send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  await ensureCsrfToken()
  let r = await rawRequest(method, path, body)
  if (isCsrfFailure(r)) {
    csrfToken = null
    await ensureCsrfToken()
    r = await rawRequest(method, path, body)
  }
  return unwrap<T>(r)
}

/** For the access-check panels: returns the HTTP status instead of throwing. */
export async function probe(path: string): Promise<number> {
  return (await rawRequest('GET', path)).status
}

export interface HealthResponse {
  status: 'ok'
  timestamp: string
}

export const fetchHealth = (signal?: AbortSignal) => getJson<HealthResponse>('/health', signal)
