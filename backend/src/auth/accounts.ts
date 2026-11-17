/**
 * Application identities (NOT AWS identities).
 *
 * Who exists, their role and their staff ID are defined here in code, so they
 * are immutable at runtime: nothing in a request, the session or a data file
 * can change an account's role or staffId. Passwords are NOT here — only
 * scrypt hashes, stored in the git-ignored backend/data/accounts.json.
 */

export type Role = 'OWNER' | 'STAFF';

export interface Account {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  /** Set for STAFF only; the identity used for staff ownership checks. */
  readonly staffId: string | null;
  readonly displayName: string;
  readonly position: string;
}

/** Fields safe to return to the browser. */
export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  staffId: string | null;
  displayName: string;
}

export interface StaffRecord {
  staffId: string;
  displayName: string;
  position: string;
}

export const STAFF_ID_PATTERN = /^staff-\d{3}$/;

export const ACCOUNTS: readonly Account[] = Object.freeze(
  [
    {
      id: 'owner',
      username: 'owner',
      role: 'OWNER',
      staffId: null,
      displayName: 'Restaurant Owner',
      position: 'Owner',
    },
    {
      id: 'staff-001',
      username: 'staff-001',
      role: 'STAFF',
      staffId: 'staff-001',
      displayName: 'Staff Member A',
      position: 'Head Chef',
    },
    {
      id: 'staff-002',
      username: 'staff-002',
      role: 'STAFF',
      staffId: 'staff-002',
      displayName: 'Staff Member B',
      position: 'Server',
    },
  ].map((a) => Object.freeze(a as Account)),
);

export function findAccountByUsername(username: string): Account | undefined {
  return ACCOUNTS.find((a) => a.username === username);
}

export function findAccountById(id: string): Account | undefined {
  return ACCOUNTS.find((a) => a.id === id);
}

export function findStaffAccount(staffId: string): Account | undefined {
  return ACCOUNTS.find((a) => a.role === 'STAFF' && a.staffId === staffId);
}

export function listStaffRecords(): StaffRecord[] {
  return ACCOUNTS.filter((a) => a.role === 'STAFF').map(toStaffRecord);
}

export function toStaffRecord(a: Account): StaffRecord {
  return { staffId: a.staffId!, displayName: a.displayName, position: a.position };
}

export function toPublicUser(a: Account): PublicUser {
  return { id: a.id, username: a.username, role: a.role, staffId: a.staffId, displayName: a.displayName };
}
