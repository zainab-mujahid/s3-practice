/**
 * Minimal API client. All calls are relative (/api/...), so in development
 * they go through the Vite proxy to NestJS on the same origin.
 *
 * Never put secrets in this folder: everything under src/ ships to the browser.
 */

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!res.ok) {
    throw new ApiError(res.status, `Request failed with status ${res.status}`)
  }
  return (await res.json()) as T
}

export interface HealthResponse {
  status: 'ok'
  timestamp: string
}

export const fetchHealth = (signal?: AbortSignal) => getJson<HealthResponse>('/health', signal)
