import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { type Account, findStaffAccount, STAFF_ID_PATTERN } from './accounts.js';

/**
 * Object-level authorization for staff resources (profile now; profile
 * pictures in Step 5). The caller's identity always comes from the
 * server-side session; staffId is only the *requested* target.
 *
 *   anonymous                       -> 401
 *   malformed staffId (e.g. "../x") -> 400  (rejected before any lookup)
 *   OWNER, existing staffId         -> allowed
 *   OWNER, unknown staffId          -> 404
 *   STAFF, own staffId              -> allowed
 *   STAFF, any other staffId        -> 403  (same answer whether it exists or not,
 *                                            so staff cannot enumerate colleagues)
 */
@Injectable()
export class StaffAccessPolicy {
  assertCanAccessStaff(user: Account | undefined, staffId: unknown): Account {
    if (!user) throw new UnauthorizedException('Authentication required');
    if (typeof staffId !== 'string' || !STAFF_ID_PATTERN.test(staffId)) {
      throw new BadRequestException('Invalid staff ID');
    }

    switch (user.role) {
      case 'OWNER': {
        const target = findStaffAccount(staffId);
        if (!target) throw new NotFoundException('Staff member not found');
        return target;
      }
      case 'STAFF': {
        if (user.staffId === null || user.staffId !== staffId) {
          throw new ForbiddenException('You can only access your own staff profile');
        }
        const self = findStaffAccount(staffId);
        if (!self) throw new ForbiddenException('You can only access your own staff profile');
        return self;
      }
      default:
        throw new ForbiddenException('You do not have permission to perform this action');
    }
  }

  /** Non-throwing variant for UI hints; never use it instead of assertCanAccessStaff for enforcement. */
  canAccessStaff(user: Account | undefined, staffId: unknown): boolean {
    try {
      this.assertCanAccessStaff(user, staffId);
      return true;
    } catch {
      return false;
    }
  }
}
