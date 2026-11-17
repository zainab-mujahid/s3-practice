import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { findAccountById } from './accounts.js';
import { StaffAccessPolicy } from './staff-access.policy.js';

const policy = new StaffAccessPolicy();
const owner = findAccountById('owner')!;
const staffA = findAccountById('staff-001')!;
const staffB = findAccountById('staff-002')!;

describe('StaffAccessPolicy', () => {
  it('anonymous -> 401', () => {
    expect(() => policy.assertCanAccessStaff(undefined, 'staff-001')).toThrow(UnauthorizedException);
  });

  it('Owner can access every staff member', () => {
    expect(policy.assertCanAccessStaff(owner, 'staff-001').staffId).toBe('staff-001');
    expect(policy.assertCanAccessStaff(owner, 'staff-002').staffId).toBe('staff-002');
  });

  it('Owner gets 404 for a well-formed but unknown staff ID', () => {
    expect(() => policy.assertCanAccessStaff(owner, 'staff-999')).toThrow(NotFoundException);
  });

  it('Staff A can access only Staff A', () => {
    expect(policy.assertCanAccessStaff(staffA, 'staff-001').staffId).toBe('staff-001');
    expect(() => policy.assertCanAccessStaff(staffA, 'staff-002')).toThrow(ForbiddenException);
  });

  it('Staff B can access only Staff B', () => {
    expect(policy.assertCanAccessStaff(staffB, 'staff-002').staffId).toBe('staff-002');
    expect(() => policy.assertCanAccessStaff(staffB, 'staff-001')).toThrow(ForbiddenException);
  });

  it('Staff get 403 (not 404) for unknown IDs, so they cannot enumerate colleagues', () => {
    expect(() => policy.assertCanAccessStaff(staffA, 'staff-999')).toThrow(ForbiddenException);
  });

  it.each(['../staff-002', 'staff-001/../staff-002', 'staff-001%2F..', 'owner', 'STAFF-001', '', 'staff-1', 'staff-0011', 42, null])(
    'rejects malformed / traversal staff ID %s with 400 for every role',
    (bad) => {
      for (const user of [owner, staffA, staffB]) {
        expect(() => policy.assertCanAccessStaff(user, bad)).toThrow(BadRequestException);
      }
    },
  );

  it('canAccessStaff mirrors the assertion without throwing', () => {
    expect(policy.canAccessStaff(staffA, 'staff-001')).toBe(true);
    expect(policy.canAccessStaff(staffA, 'staff-002')).toBe(false);
    expect(policy.canAccessStaff(undefined, 'staff-001')).toBe(false);
  });
});
