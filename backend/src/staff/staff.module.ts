import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProfileController } from '../profile/profile.controller.js';
import { StaffController } from './staff.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [ProfileController, StaffController],
})
export class StaffModule {}
