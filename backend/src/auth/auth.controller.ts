import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AppEnv } from '../config/env.validation.js';
import { type Account, type PublicUser, toPublicUser } from './accounts.js';
import { type LoginDto, loginSchema } from './auth.schemas.js';
import { AuthService, LoginLockedException } from './auth.service.js';
import { CurrentUser, Public } from './decorators.js';
import { newCsrfToken, SESSION_COOKIE_NAME, sessionCookieOptions } from './session.utils.js';

/** Max login requests per client IP per minute (on top of the per-account lockout). */
export const LOGIN_RATE_LIMIT = { limit: 10, ttl: 60_000 };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  /** Issues (or returns) this session's CSRF token. Needed before login. */
  @Public()
  @Get('csrf')
  csrf(@Req() req: Request): { csrfToken: string } {
    req.session.csrfToken ??= newCsrfToken();
    return { csrfToken: req.session.csrfToken };
  }

  @Public()
  @Throttle({ default: LOGIN_RATE_LIMIT })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body({ schema: loginSchema }) body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: PublicUser; csrfToken: string }> {
    try {
      return await this.auth.login(body.username, body.password, req);
    } catch (err) {
      if (err instanceof LoginLockedException) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req);
    const { maxAge: _maxAge, ...cookieOptions } = sessionCookieOptions({
      COOKIE_SECURE: this.config.get('COOKIE_SECURE', { infer: true }),
      SESSION_IDLE_TIMEOUT_SECONDS: this.config.get('SESSION_IDLE_TIMEOUT_SECONDS', { infer: true }),
    });
    res.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
  }

  @Get('me')
  me(@CurrentUser() user: Account): { user: PublicUser } {
    return { user: toPublicUser(user) };
  }
}
