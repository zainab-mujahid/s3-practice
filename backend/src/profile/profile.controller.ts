import { Controller, Get } from '@nestjs/common';
import { type Account, type PublicUser, toPublicUser } from '../auth/accounts.js';
import { CurrentUser } from '../auth/decorators.js';

export interface ProfileResponse {
  profile: PublicUser & { position: string };
}

/** The caller's own profile. Any authenticated role; identity comes from the session only. */
@Controller('profile')
export class ProfileController {
  @Get('me')
  me(@CurrentUser() user: Account): ProfileResponse {
    return { profile: { ...toPublicUser(user), position: user.position } };
  }
}
