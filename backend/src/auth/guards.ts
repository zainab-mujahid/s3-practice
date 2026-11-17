import { timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AppEnv } from '../config/env.validation.js';
import type { Role } from './accounts.js';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators.js';

/*
 * Global guard chain (registered in this order in AuthModule):
 *   1. ClientIpThrottlerGuard  -> 429 when a client sends too many requests
 *   2. CsrfGuard               -> 403 for state-changing requests without a valid Origin + CSRF token
 *   3. SessionAuthGuard        -> 401 when the route is not @Public() and there is no valid session
 *   4. RolesGuard              -> 403 when the user's role is not in @Roles(...)
 * Object-level checks (StaffAccessPolicy) run inside the handlers.
 */

/** Rate-limit key = req.ip, which honours the restricted `trust proxy` setting (see app.setup.ts). */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(String((req as Request).ip ?? 'unknown'));
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for every state-changing request (including login):
 *  - Origin (or, if absent, Referer) must equal FRONTEND_URL exactly.
 *  - X-CSRF-Token must equal the token stored in this server-side session
 *    (constant-time comparison). Tokens come from GET /api/auth/csrf and are
 *    rotated on login.
 * SameSite=Strict cookies already block most cross-site requests; this is
 * defence in depth (e.g. same-site subdomains, older browsers).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigin: string;

  constructor(config: ConfigService<AppEnv, true>) {
    this.allowedOrigin = config.get('FRONTEND_URL', { infer: true });
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    if (requestOrigin(req) !== this.allowedOrigin) {
      throw new ForbiddenException('Request origin not allowed');
    }

    const sent = req.get('x-csrf-token');
    const expected = req.session?.csrfToken;
    if (!sent || !expected || !constantTimeEqual(sent, expected)) {
      throw new ForbiddenException('Invalid or missing CSRF token');
    }
    return true;
  }
}

function requestOrigin(req: Request): string | null {
  const origin = req.get('origin');
  if (origin) return origin;
  const referer = req.get('referer');
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);

    const { user, expired } = await this.auth.resolveSessionUser(req);
    if (user) req.user = user;
    if (isPublic || user) return true;

    throw new UnauthorizedException(expired ? 'Session expired. Please log in again.' : 'Authentication required');
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!roles || roles.length === 0) return true;
    const user = ctx.switchToHttp().getRequest<Request>().user;
    if (!user) throw new UnauthorizedException('Authentication required');
    if (!roles.includes(user.role)) {
      throw new ForbiddenException('You do not have permission to perform this action');
    }
    return true;
  }
}
