import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CredentialsService } from './credentials.service.js';
import { ClientIpThrottlerGuard, CsrfGuard, RolesGuard, SessionAuthGuard } from './guards.js';
import { StaffAccessPolicy } from './staff-access.policy.js';

@Module({
  imports: [
    // Generous global ceiling per client IP; /auth/login has a much stricter limit.
    // Throttler counters are in memory (reset on restart); the security-relevant
    // failed-login counters are persisted in SQLite (LoginAttemptStore).
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }] }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    CredentialsService,
    StaffAccessPolicy,
    // Global guards, deny-by-default. Order matters (see guards.ts).
    { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, StaffAccessPolicy],
})
export class AuthModule {}
