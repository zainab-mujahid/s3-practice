import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authorization, FakeXHR, installFakeXHR, pngFile, stubFetch } from '../test/fakes'
import { ApiError, setCsrfToken } from './client'
import { checkFile, S3UploadError, uploadImage, uploadToS3 } from './images'

beforeEach(() => {
  setCsrfToken('csrf-token')
  installFakeXHR()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('checkFile (early feedback only)', () => {
  it.each([
    [new File([new Uint8Array(100)], 'a.gif', { type: 'image/gif' }), /JPEG, PNG and WebP/],
    [new File([new Uint8Array(100)], 'a.svg', { type: 'image/svg+xml' }), /JPEG, PNG and WebP/],
    [pngFile('a.png', 31), /too small/],
    [pngFile('a.png', 5 * 1024 * 1024 + 1), /too large/],
  ])('rejects case %#', (file, msg) => {
    expect(checkFile(file)).toMatch(msg)
  })

  it('accepts a normal PNG', () => {
    expect(checkFile(pngFile())).toBeNull()
  })
})

describe('uploadToS3', () => {
  it('posts every signed field first and the file last, without credentials', async () => {
    const file = pngFile()
    const progress: number[] = []
    const p = uploadToS3(authorization(), file, (f) => progress.push(f))
    const xhr = FakeXHR.instances[0]
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('https://public-bucket.s3.us-east-2.amazonaws.com/')
    expect(xhr.withCredentials).toBe(false)
    const names = [...xhr.body!.keys()]
    expect(names.at(-1)).toBe('file')
    expect(names.slice(0, -1).sort((a, b) => a.localeCompare(b))).toEqual(['Content-Type', 'key', 'Policy', 'X-Amz-Signature'])
    expect(xhr.body!.get('file')).toBeInstanceOf(File)
    xhr.progress(50, 100)
    xhr.respond(204)
    await p
    expect(progress).toEqual([0.5, 1])
  })

  it('does not even try when the presigned POST has already expired', async () => {
    await expect(uploadToS3(authorization({ expiresAt: new Date(Date.now() - 1).toISOString() }), pngFile())).rejects.toMatchObject({
      reason: 'expired',
    })
    expect(FakeXHR.instances).toHaveLength(0)
  })

  it.each([
    [403, '<Error><Code>AccessDenied</Code><Message>Invalid according to Policy: Policy expired.</Message><RequestId>R1</RequestId></Error>', 'expired'],
    [400, '<Error><Code>EntityTooLarge</Code><Message>Your proposed upload exceeds the maximum allowed size</Message></Error>', 'too_large'],
    [400, '<Error><Code>EntityTooSmall</Code></Error>', 'too_small'],
    [403, '<Error><Code>AccessDenied</Code><Message>Invalid according to Policy: Policy Condition failed</Message></Error>', 'rejected'],
  ])('maps an S3 %i response to a safe reason (case %#)', async (status, xml, reason) => {
    const p = uploadToS3(authorization(), pngFile())
    FakeXHR.instances[0].respond(status, xml)
    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(S3UploadError)
    expect(err).toMatchObject({ reason })
    expect((err as Error).message).not.toMatch(/RequestId|R1|Policy/)
  })

  it('reports network/CORS failures', async () => {
    const p = uploadToS3(authorization(), pngFile())
    FakeXHR.instances[0].fail()
    await expect(p).rejects.toMatchObject({ reason: 'network' })
  })

  it('can be cancelled', async () => {
    const ac = new AbortController()
    const p = uploadToS3(authorization(), pngFile(), undefined, ac.signal)
    ac.abort()
    await expect(p).rejects.toMatchObject({ reason: 'aborted' })
  })
})

describe('uploadImage (full flow)', () => {
  it('authorizes with CSRF, uploads to S3, then completes; reports each stage', async () => {
    const calls = stubFetch((c) => {
      if (c.url === '/api/admin/images/uploads') return { status: 201, body: authorization() }
      if (c.url.endsWith('/complete')) return { status: 200, body: { image: { assetId: 'a' }, replaced: true } }
      return undefined
    })
    FakeXHR.autoRespond = { status: 204 }
    const stages: string[] = []
    const res = await uploadImage({ kind: 'DISH', file: pngFile('Dish.png'), targetAssetId: 'd1', onStage: (s) => stages.push(s) })

    expect(res.replaced).toBe(true)
    expect(stages).toEqual(['authorizing', 'uploading', 'verifying'])
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/admin/images/uploads',
      'POST /api/admin/images/uploads/11111111-1111-4111-8111-111111111111/complete',
    ])
    expect(calls[0].body).toEqual({ kind: 'DISH', targetAssetId: 'd1', fileName: 'Dish.png', contentType: 'image/png', size: 100 })
    expect(calls[0].headers['X-CSRF-Token']).toBe('csrf-token')
    expect(calls[1].headers['X-CSRF-Token']).toBe('csrf-token')
  })

  it('does not call complete when the S3 upload fails', async () => {
    const calls = stubFetch((c) => (c.url === '/api/admin/images/uploads' ? { status: 201, body: authorization() } : undefined))
    FakeXHR.autoRespond = { status: 403, text: '<Error><Code>AccessDenied</Code></Error>' }
    await expect(uploadImage({ kind: 'LOGO', file: pngFile() })).rejects.toBeInstanceOf(S3UploadError)
    expect(calls).toHaveLength(1)
  })

  it('surfaces backend refusals as ApiError without touching S3', async () => {
    stubFetch(() => ({ status: 403, body: { message: 'You do not have permission to perform this action' } }))
    const err = await uploadImage({ kind: 'LOGO', file: pngFile() }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 403 })
    expect(FakeXHR.instances).toHaveLength(0)
  })
})
