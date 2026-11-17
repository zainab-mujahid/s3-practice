import { Controller, Get, Param } from '@nestjs/common';
import { type Account, listStaffRecords, type StaffRecord, toStaffRecord } from '../auth/accounts.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { StaffAccessPolicy } from '../auth/staff-access.policy.js';

/**
 * Read-only staff records (no S3 yet).
 *   GET /api/staff           OWNER only
 *   GET /api/staff/:staffId  OWNER (any) or STAFF (own record only)
 */
@Controller('staff')
export class StaffController {
  constructor(private readonly policy: StaffAccessPolicy) {}

  @Get()
  @Roles('OWNER')
  list(): { staff: StaffRecord[] } {
    return { staff: listStaffRecords() };
  }

  @Get(':staffId')
  get(@CurrentUser() user: Account, @Param('staffId') staffId: string): { staff: StaffRecord } {
    const target = this.policy.assertCanAccessStaff(user, staffId);
    return { staff: toStaffRecord(target) };
  }
}
