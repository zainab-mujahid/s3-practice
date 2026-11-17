import { HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AppEnv } from '../config/env.validation.js';
import { LoginAttemptStore } from '../persistence/login-attempt.store.js';
import { type Account, findAccountById, findAccountByUsername, type PublicUser, toPublicUser } from './accounts.js';
import { CredentialsService } from './credentials.service.js';
import { dummyVerify, verifyPassword } from './password.js';
import { destroySession, newCsrfToken, regenerateSession, saveSession } from './session.utils.js';

export const INVALID_CREDENTIALS_MESSAGE = 'Invalid username or password';

export class LoginLockedException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: 'Too many failed login attempts. Please try again later.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Only digits, hex, '.', ':' — keeps attacker-influenced values out of logs in any other form. */
export const sanitizeIp = (ip: string | undefined) => (ip ?? 'unknown').replace(/[^0-9a-fA-F:.]/g, '').slice(0, 45) || 'unknown';

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  private readonly absoluteTimeoutMs: number;

  constructor(
    private readonly credentials: CredentialsService,
    private readonly attempts: LoginAttemptStore,
    config: ConfigService<AppEnv, true>,
  ) {
    this.absoluteTimeoutMs = config.get('SESSION_ABSOLUTE_TIMEOUT_SECONDS', { infer: true }) * 1000;
  }

  async login(username: string, password: string, req: Request): Promise<{ user: PublicUser; csrfToken: string }> {
    const ip = sanitizeIp(req.ip);

    // 1. Lockout check first: a locked (username, IP) pair gets no password oracle.
    const lock = this.attempts.getLockStatus(username, ip);
    if (lock.locked) throw new LoginLockedException(lock.retryAfterSeconds);

    // 2. Verify. Unknown users still pay the scrypt cost (no timing-based enumeration).
    const account = findAccountByUsername(username);
    const hash = account ? this.credentials.getPasswordHash(account.username) : null;
    const ok = hash ? await verifyPassword(password, hash) : await dummyVerify(password);

    if (!ok || !account) {
      const status = this.attempts.recordFailure(username, ip);
      // Never log the password. Only log the username if it is a real account
      // (a mistyped password pasted into the username field must not hit the logs).
      this.logger.warn(`Failed login for ${account ? `account "${account.username}"` : 'an unknown username'} from ${ip}`);
      if (status.locked) this.logger.warn(`Login temporarily locked for that username from ${ip}`);
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    this.attempts.recordSuccess(username, ip);

    // 3. New session ID on privilege change (prevents session fixation). The old
    //    ID is destroyed + tombstoned by the store. A fresh CSRF token is issued.
    await regenerateSession(req.session);
    req.session.userId = account.id;
    req.session.authenticatedAt = Date.now();
    req.session.csrfToken = newCsrfToken();
    await saveSession(req.session);

    this.logger.log(`User "${account.username}" (${account.role}) logged in from ${ip}`);
    return { user: toPublicUser(account), csrfToken: req.session.csrfToken };
  }

  async logout(req: Request): Promise<void> {
    const username = req.user?.username;
    await destroySession(req.session);
    if (username) this.logger.log(`User "${username}" logged out`);
  }

  /**
   * Resolves the account for the current session, enforcing the absolute
   * timeout. The role/staffId come from the code-defined account registry,
   * never from the session contents or the request.
   */
  async resolveSessionUser(req: Request): Promise<{ user: Account | null; expired: boolean }> {
    const { userId, authenticatedAt } = req.session ?? {};
    if (!userId) return { user: null, expired: false };

    const account = findAccountById(userId);
    const tooOld = typeof authenticatedAt !== 'number' || Date.now() - authenticatedAt > this.absoluteTimeoutMs;
    if (!account || tooOld) {
      await destroySession(req.session).catch(() => undefined);
      return { user: null, expired: true };
    }
    return { user: account, expired: false };
  }
}
