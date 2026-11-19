import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../api/auth'
import { setCsrfToken } from '../api/client'
import { authorization, FakeXHR, type FetchCall, image, installFakeXHR, pngFile, stubFetch } from '../test/fakes'
import { OwnerDashboard, StaffDashboard } from './Dashboards'
import { OwnerImageManager } from './OwnerImageManager'
import { PublicGallery } from './PublicGallery'

const LOGO = image('LOGO', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const DISH = image('DISH', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

let published: { logo: unknown; dishes: unknown[] }

beforeEach(() => {
  setCsrfToken('csrf-token')
  installFakeXHR()
  published = { logo: LOGO, dishes: [DISH] }
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Backend fake for the image endpoints (plus the dashboard's other GETs). */
function backend(overrides: (c: FetchCall) => { status: number; body?: unknown } | undefined = () => undefined) {
  return stubFetch((c) => {
    const o = overrides(c)
    if (o) return o
    if (c.method === 'GET' && c.url === '/api/public/images') return { status: 200, body: published }
    if (c.method === 'GET' && c.url === '/api/staff') return { status: 200, body: { staff: [] } }
    if (c.method === 'GET' && c.url === '/api/profile/me') return { status: 200, body: { profile: { ...staffUser, position: 'Chef' } } }
    if (c.method === 'POST' && c.url === '/api/admin/images/uploads') return { status: 201, body: authorization() }
    if (c.method === 'POST' && c.url.endsWith('/complete')) return { status: 200, body: { image: LOGO, replaced: true } }
    if (c.method === 'DELETE') return { status: 204 }
    return undefined
  })
}

const ownerUser: User = { id: 'owner', username: 'owner', role: 'OWNER', staffId: null, displayName: 'Owner' }
const staffUser: User = { id: 'staff-001', username: 'staff-001', role: 'STAFF', staffId: 'staff-001', displayName: 'Staff A' }

const mutating = (calls: FetchCall[]) => calls.filter((c) => c.method !== 'GET')

describe('role-based UI', () => {
  it('visitors see published images and no management controls', async () => {
    backend()
    render(<PublicGallery showVisitorChecks />)
    expect(await screen.findByAltText('Restaurant logo')).toHaveProperty('src', LOGO.url)
    expect(screen.getByAltText('Dish 1')).toHaveProperty('src', DISH.url)
    expect(screen.queryByRole('button', { name: /delete|upload|replace/i })).toBeNull()
    expect(document.querySelector('input[type=file]')).toBeNull()
  })

  it('shows empty states when nothing is published', async () => {
    published = { logo: null, dishes: [] }
    backend()
    render(<PublicGallery showVisitorChecks={false} />)
    expect(await screen.findByText(/No logo has been published/)).toBeTruthy()
    expect(screen.getByText(/No dish images have been published/)).toBeTruthy()
  })

  it('staff dashboard has no image management', async () => {
    backend()
    render(<StaffDashboard user={staffUser} onUnauthorized={() => {}} />)
    await screen.findByText('Staff A')
    expect(screen.queryByText('Restaurant images')).toBeNull()
    expect(screen.queryByLabelText(/logo|dish/i)).toBeNull()
  })

  it('owner dashboard includes image management', async () => {
    backend()
    render(<OwnerDashboard user={ownerUser} onUnauthorized={() => {}} />)
    expect(await screen.findByLabelText('Replace logo')).toBeTruthy()
    expect(screen.getByLabelText('Add a dish image')).toBeTruthy()
  })
})

describe('OwnerImageManager', () => {
  it('uploads a new dish image: preview, staged progress, completion, refresh', async () => {
    const calls = backend()
    render(<OwnerImageManager onUnauthorized={() => {}} />)
    const input = await screen.findByLabelText('Add a dish image')
    fireEvent.change(input, { target: { files: [pngFile('soup.png')] } })
    expect(screen.getByAltText('Selected file preview')).toBeTruthy()

    const panel = input.closest('div')!
    fireEvent.click(within(panel).getByRole('button', { name: 'Upload' }))
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    // Duplicate clicks while uploading do nothing.
    fireEvent.click(within(panel).getByRole('button', { name: /Uploading/ }))
    expect(await within(panel).findByText(/Uploading to Amazon S3/)).toBeTruthy()
    FakeXHR.instances[0].progress(40, 100)
    expect(await within(panel).findByText(/40%/)).toBeTruthy()
    FakeXHR.instances[0].respond(204)

    expect(await screen.findByText('Image replaced and published.')).toBeTruthy()
    expect(mutating(calls).map((c) => c.url)).toEqual([
      '/api/admin/images/uploads',
      '/api/admin/images/uploads/11111111-1111-4111-8111-111111111111/complete',
    ])
    expect(mutating(calls)[0].body).toMatchObject({ kind: 'DISH', fileName: 'soup.png' })
    expect(calls.filter((c) => c.url === '/api/public/images').length).toBe(2) // reloaded after success
  })

  it('rejects an unsupported file locally without calling the backend', async () => {
    const calls = backend()
    render(<OwnerImageManager onUnauthorized={() => {}} />)
    const input = await screen.findByLabelText('Replace logo')
    fireEvent.change(input, { target: { files: [new File(['<svg/>'.repeat(10)], 'x.svg', { type: 'image/svg+xml' })] } })
    expect(await screen.findByText(/Only JPEG, PNG and WebP/)).toBeTruthy()
    expect(mutating(calls)).toHaveLength(0)
  })

  it('shows a clear message when the S3 upload fails (e.g. expired link) and does not complete', async () => {
    const calls = backend()
    FakeXHR.autoRespond = { status: 403, text: '<Error><Code>AccessDenied</Code><Message>Policy expired.</Message></Error>' }
    render(<OwnerImageManager onUnauthorized={() => {}} />)
    const input = await screen.findByLabelText('Replace logo')
    fireEvent.change(input, { target: { files: [pngFile()] } })
    fireEvent.click(within(input.closest('div')!).getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText(/upload link expired/i)).toBeTruthy()
    expect(mutating(calls).some((c) => c.url.endsWith('/complete'))).toBe(false)
  })

  it('shows the backend verification error when completion is rejected', async () => {
    backend((c) =>
      c.url.endsWith('/complete') ? { status: 422, body: { message: 'The uploaded file is not a valid JPEG, PNG or WebP image', reason: 'UNRECOGNISED_SIGNATURE' } } : undefined,
    )
    FakeXHR.autoRespond = { status: 204 }
    render(<OwnerImageManager onUnauthorized={() => {}} />)
    const input = await screen.findByLabelText('Replace logo')
    fireEvent.change(input, { target: { files: [pngFile()] } })
    fireEvent.click(within(input.closest('div')!).getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText(/not a valid JPEG, PNG or WebP image/)).toBeTruthy()
    // The published logo is still shown.
    expect(screen.getByAltText('Current restaurant logo')).toHaveProperty('src', LOGO.url)
  })

  it('deletes only after explicit confirmation', async () => {
    const calls = backend()
    render(<OwnerImageManager onUnauthorized={() => {}} />)
    await screen.findByAltText('Dish image 1')
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' })
    fireEvent.click(deleteButtons[1]) // dish
    expect(mutating(calls)).toHaveLength(0)
    expect(screen.getByText(/Delete dish image 1 permanently\?/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mutating(calls)).toHaveLength(0)

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1])
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }))
    expect(await screen.findByText('Dish image deleted.')).toBeTruthy()
    expect(mutating(calls)).toMatchObject([{ method: 'DELETE', url: `/api/admin/images/${DISH.assetId}` }])
  })

  it('replaces a specific dish by sending its id', async () => {
    const calls = backend()
    FakeXHR.autoRespond = { status: 204 }
    render(<OwnerImageManager onUnauthorized={() => {}} />)
    await screen.findByAltText('Dish image 1')
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    const input = screen.getByLabelText('Replace dish image 1')
    fireEvent.change(input, { target: { files: [pngFile()] } })
    fireEvent.click(within(input.closest('div')!).getByRole('button', { name: 'Upload' }))
    await screen.findByText('Image replaced and published.')
    expect(mutating(calls)[0].body).toMatchObject({ kind: 'DISH', targetAssetId: DISH.assetId })
  })

  it('a 401 from the backend signs the user out of the UI', async () => {
    backend((c) => (c.method === 'POST' ? { status: 401, body: { message: 'Session expired' } } : undefined))
    const onUnauthorized = vi.fn()
    render(<OwnerImageManager onUnauthorized={onUnauthorized} />)
    const input = await screen.findByLabelText('Replace logo')
    fireEvent.change(input, { target: { files: [pngFile()] } })
    fireEvent.click(within(input.closest('div')!).getByRole('button', { name: 'Upload' }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
  })

  it('a 403 from the backend shows a permission message', async () => {
    backend((c) => (c.method === 'POST' ? { status: 403, body: { message: 'Forbidden' } } : undefined))
    render(<OwnerImageManager onUnauthorized={() => {}} />)
    const input = await screen.findByLabelText('Replace logo')
    fireEvent.change(input, { target: { files: [pngFile()] } })
    fireEvent.click(within(input.closest('div')!).getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText(/do not have permission to manage restaurant images/)).toBeTruthy()
  })
})
