/** Test doubles for fetch (backend) and XMLHttpRequest (direct S3 upload). No network is used. */
import { vi } from 'vitest'

export interface FetchCall {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

type Handler = (call: FetchCall) => { status: number; body?: unknown } | undefined

/** Stubs global fetch; `handler` returns a status/body per call (undefined -> 404). */
export function stubFetch(handler: Handler) {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: FetchCall = {
        method: init.method ?? 'GET',
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      }
      calls.push(call)
      const r = handler(call) ?? { status: 404, body: { message: 'Not found' } }
      return new Response(r.status === 204 || r.body === undefined ? null : JSON.stringify(r.body), { status: r.status })
    }),
  )
  return calls
}

export class FakeXHR {
  static instances: FakeXHR[] = []
  /** When set, every new request is answered automatically. */
  static autoRespond: { status: number; text?: string } | null = null

  readonly upload = new EventTarget()
  status = 0
  responseText = ''
  withCredentials = true
  method = ''
  url = ''
  body: FormData | null = null
  private readonly listeners = new Map<string, Array<() => void>>()

  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  send(body: FormData) {
    this.body = body
    FakeXHR.instances.push(this)
    const auto = FakeXHR.autoRespond
    if (auto) queueMicrotask(() => this.respond(auto.status, auto.text))
  }
  abort() {
    this.fire('abort')
  }
  progress(loaded: number, total: number) {
    this.upload.dispatchEvent(Object.assign(new Event('progress'), { lengthComputable: true, loaded, total }))
  }
  respond(status: number, text = '') {
    this.status = status
    this.responseText = text
    this.fire('load')
  }
  fail() {
    this.fire('error')
  }
  private fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn()
  }
}

export function installFakeXHR() {
  FakeXHR.instances = []
  FakeXHR.autoRespond = null
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
}

export const pngFile = (name = 'photo.png', size = 100) => new File([new Uint8Array(size)], name, { type: 'image/png' })

export const authorization = (overrides: Partial<{ expiresAt: string }> = {}) => ({
  uploadId: '11111111-1111-4111-8111-111111111111',
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  completeBy: new Date(Date.now() + 600_000).toISOString(),
  upload: {
    url: 'https://public-bucket.s3.us-east-2.amazonaws.com/',
    fields: { 'Content-Type': 'image/png', key: 'staging/abc', Policy: 'cG9saWN5', 'X-Amz-Signature': 'sig' },
  },
  ...overrides,
})

export const image = (kind: 'LOGO' | 'DISH', id: string) => ({
  assetId: id,
  kind,
  url: `https://public-bucket.s3.us-east-2.amazonaws.com/${kind === 'LOGO' ? 'logo' : 'dishes'}/${id}.png`,
  contentType: 'image/png',
  sizeBytes: 100,
  updatedAt: '2026-11-19T00:00:00.000Z',
})
