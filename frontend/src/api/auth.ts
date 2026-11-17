import { ApiError, getJson, send, setCsrfToken } from './client'

export type Role = 'OWNER' | 'STAFF'

export interface User {
  id: string
  username: string
  role: Role
  staffId: string | null
  displayName: string
}

export interface Profile extends User {
  position: string
}

export interface StaffRecord {
  staffId: string
  displayName: string
  position: string
}

/** Restores the session after a page refresh. Returns null for anonymous visitors. */
export async function fetchCurrentUser(): Promise<User | null> {
  try {
    return (await getJson<{ user: User }>('/auth/me')).user
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null
    throw err
  }
}

export async function login(username: string, password: string): Promise<User> {
  const res = await send<{ user: User; csrfToken: string }>('POST', '/auth/login', { username, password })
  setCsrfToken(res.csrfToken) // the server rotated the token on login
  return res.user
}

export async function logout(): Promise<void> {
  try {
    await send<void>('POST', '/auth/logout')
  } finally {
    setCsrfToken(null)
  }
}

export const fetchProfile = () => getJson<{ profile: Profile }>('/profile/me').then((r) => r.profile)
export const fetchStaffList = () => getJson<{ staff: StaffRecord[] }>('/staff').then((r) => r.staff)
