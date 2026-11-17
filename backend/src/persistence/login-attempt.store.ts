/**
 * Failed-login tracking persisted in SQLite (survives backend restarts).
 *
 * Keyed by (username, client IP), NOT by username alone. Rationale:
 *  - Brute force from one client: after MAX_FAILURES wrong passwords within
 *    WINDOW, that client is locked out of that account for LOCK_DURATION.
 *  - Lockout denial-of-service: an attacker hammering "owner" from their
 *    machine does NOT lock the real owner out from a different client.
 *  - Unknown usernames are tracked exactly like real ones, so lockout
 *    behaviour does not reveal which accounts exist.
 *
 * Limitation (documented): a distributed attacker using many IPs gets
 * MAX_FAILURES guesses per IP per window. The per-IP request throttle
 * (ThrottlerGuard) and the long random passwords bound this; production
 * systems add MFA, CAPTCHA, anomaly detection, etc.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { transaction } from './sqlite.js';

export interface LoginAttemptPolicy {
  maxFailures: number;
  windowMs: number;
  lockDurationMs: number;
}

export const DEFAULT_LOGIN_ATTEMPT_POLICY: LoginAttemptPolicy = {
  maxFailures: 5,
  windowMs: 15 * 60_000,
  lockDurationMs: 15 * 60_000,
};

export interface LockStatus {
  locked: boolean;
  retryAfterSeconds: number;
}

interface Row {
  failures: number;
  window_started_at: number;
  locked_until: number | null;
}

/** Bound the key size so junk input cannot bloat the table. */
const normaliseKey = (username: string, ip: string): [string, string] => [username.slice(0, 64), ip.slice(0, 64)];

export class LoginAttemptStore {
  private readonly stmt: Record<'get' | 'upsert' | 'delete' | 'deleteUser' | 'prune', StatementSync>;

  constructor(
    private readonly db: DatabaseSync,
    private readonly policy: LoginAttemptPolicy = DEFAULT_LOGIN_ATTEMPT_POLICY,
    private readonly now: () => number = Date.now,
  ) {
    this.stmt = {
      get: db.prepare('SELECT failures, window_started_at, locked_until FROM login_failures WHERE username = ? AND ip = ?'),
      upsert: db.prepare(
        `INSERT INTO login_failures (username, ip, failures, window_started_at, locked_until) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(username, ip) DO UPDATE SET failures = excluded.failures,
           window_started_at = excluded.window_started_at, locked_until = excluded.locked_until`,
      ),
      delete: db.prepare('DELETE FROM login_failures WHERE username = ? AND ip = ?'),
      deleteUser: db.prepare('DELETE FROM login_failures WHERE username = ?'),
      prune: db.prepare(
        'DELETE FROM login_failures WHERE (locked_until IS NULL OR locked_until <= ?) AND window_started_at <= ?',
      ),
    };
  }

  getLockStatus(username: string, ip: string): LockStatus {
    const row = this.stmt.get.get(...normaliseKey(username, ip)) as Row | undefined;
    return this.lockStatusOf(row);
  }

  /** Atomically records a failure; returns whether the pair is now locked. */
  recordFailure(username: string, ip: string): LockStatus {
    const key = normaliseKey(username, ip);
    return transaction(this.db, () => {
      const now = this.now();
      const row = this.stmt.get.get(...key) as Row | undefined;
      const lockExpired = row?.locked_until != null && row.locked_until <= now;
      const windowExpired = !row || now - row.window_started_at > this.policy.windowMs;

      let failures: number;
      let windowStartedAt: number;
      if (!row || lockExpired || windowExpired) {
        failures = 1;
        windowStartedAt = now;
      } else {
        failures = row.failures + 1;
        windowStartedAt = row.window_started_at;
      }
      const lockedUntil = failures >= this.policy.maxFailures ? now + this.policy.lockDurationMs : null;
      this.stmt.upsert.run(...key, failures, windowStartedAt, lockedUntil);
      return this.lockStatusOf({ failures, window_started_at: windowStartedAt, locked_until: lockedUntil });
    });
  }

  recordSuccess(username: string, ip: string): void {
    this.stmt.delete.run(...normaliseKey(username, ip));
  }

  /** Used by password reset: clears that user's counters for every IP. */
  clearUser(username: string): void {
    this.stmt.deleteUser.run(username);
  }

  prune(): number {
    const now = this.now();
    return Number(this.stmt.prune.run(now, now - this.policy.windowMs).changes);
  }

  private lockStatusOf(row: Row | undefined): LockStatus {
    const now = this.now();
    if (!row?.locked_until || row.locked_until <= now) return { locked: false, retryAfterSeconds: 0 };
    return { locked: true, retryAfterSeconds: Math.ceil((row.locked_until - now) / 1000) };
  }
}
