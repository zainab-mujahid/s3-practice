import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Account, Role } from './accounts.js';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';

/** Route is reachable without logging in. Everything else requires a session (deny by default). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Route requires one of these roles. Enforced by RolesGuard on the server. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** The authenticated account, resolved from the server-side session (never from request input). */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Account | undefined => {
  return ctx.switchToHttp().getRequest<Request>().user;
});
