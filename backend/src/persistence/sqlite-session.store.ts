/**
 * express-session Store backed by node:sqlite.
 *
 * LOCAL DEVELOPMENT ONLY — single process, single file, unencrypted at rest.
 * Production would use a shared store (e.g. Redis / a managed DB) with
 * encryption, replication and monitoring.
 *
 * Robustness properties (each covered by tests):
 *  - Session IDs are stored as SHA-256 hashes; reading the DB file does not
 *    give you usable session cookies.
 *  - Expired rows are never returned (checked on read) and are pruned periodically.
 *  - Destroyed IDs (logout, regenerate-on-login, password reset) are recorded as
 *    tombstones inside the same transaction. A concurrent request that loaded the
 *    session earlier and saves afterwards cannot resurrect it.
 *  - touch() only extends existing, unexpired rows; it never creates one.
 *  - Only whitelisted fields (cookie, userId, authenticatedAt, csrfToken) are
 *    persisted. Anything else placed on the session (e.g. by mistake, a password)
 *    is dropped before it reaches disk.
 *  - Corrupted rows are discarded instead of crashing the request.
 *  - DB errors are passed to the callback (express-session turns them into a
 *    request error, which the app maps to a generic 503 — see app.setup.ts).
 *  - All SQL is parameterised.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import session, { type SessionData } from 'express-session';
import '../auth/session.types.js';
import { transaction } from './sqlite.js';

type Callback = (err?: unknown) => void;

export interface SqliteSessionStoreOptions {
  /** Used when a session has no cookie expiry. */
  defaultTtlMs: number;
  /** How long tombstones are kept. Must exceed the longest possible in-flight request; we use the absolute session timeout. */
  tombstoneTtlMs: number;
  now?: () => number;
}

const PERSISTED_FIELDS = ['cookie', 'userId', 'authenticatedAt', 'csrfToken'] as const;

export function hashSid(sid: string): string {
  return createHash('sha256').update(sid).digest('hex');
}

interface SessionRow {
  data: string;
  expires_at: number;
}

export class SqliteSessionStore extends session.Store {
  private readonly now: () => number;
  private readonly stmt: Record<
    'get' | 'upsert' | 'isDestroyed' | 'delete' | 'tombstone' | 'touch' | 'userSids' | 'pruneSessions' | 'pruneTombstones' | 'count' | 'clear',
    StatementSync
  >;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: SqliteSessionStoreOptions,
  ) {
    super();
    this.now = options.now ?? Date.now;
    this.stmt = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid_hash = ?'),
      upsert: db.prepare(
        `INSERT INTO sessions (sid_hash, user_id, data, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(sid_hash) DO UPDATE SET user_id = excluded.user_id, data = excluded.data, expires_at = excluded.expires_at`,
      ),
      isDestroyed: db.prepare('SELECT 1 AS hit FROM destroyed_sessions WHERE sid_hash = ?'),
      delete: db.prepare('DELETE FROM sessions WHERE sid_hash = ?'),
      tombstone: db.prepare('INSERT OR REPLACE INTO destroyed_sessions (sid_hash, destroyed_at) VALUES (?, ?)'),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid_hash = ? AND expires_at > ?'),
      userSids: db.prepare('SELECT sid_hash FROM sessions WHERE user_id = ?'),
      pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
      pruneTombstones: db.prepare('DELETE FROM destroyed_sessions WHERE destroyed_at <= ?'),
      count: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?'),
      clear: db.prepare('DELETE FROM sessions'),
    };
  }

  override get(sid: string, cb: (err: unknown, session?: SessionData | null) => void): void {
    try {
      const key = hashSid(sid);
      const row = this.stmt.get.get(key) as SessionRow | undefined;
      if (!row) return cb(null, null);
      if (row.expires_at <= this.now()) {
        this.stmt.delete.run(key);
        return cb(null, null);
      }
      let data: SessionData;
      try {
        data = JSON.parse(row.data) as SessionData;
      } catch {
        this.stmt.delete.run(key); // corrupted row: treat as no session
        return cb(null, null);
      }
      cb(null, data);
    } catch (err) {
      cb(err);
    }
  }

  override set(sid: string, sess: SessionData, cb?: Callback): void {
    try {
      const key = hashSid(sid);
      const data = JSON.stringify(pickPersisted(sess));
      const userId = typeof sess.userId === 'string' ? sess.userId : null;
      const expiresAt = this.expiryOf(sess);
      transaction(this.db, () => {
        if (this.stmt.isDestroyed.get(key)) return; // never resurrect a destroyed session
        this.stmt.upsert.run(key, userId, data, expiresAt);
      });
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  override destroy(sid: string, cb?: Callback): void {
    try {
      const key = hashSid(sid);
      transaction(this.db, () => {
        this.stmt.delete.run(key);
        this.stmt.tombstone.run(key, this.now());
      });
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  override touch(sid: string, sess: SessionData, cb?: Callback): void {
    try {
      const now = this.now();
      this.stmt.touch.run(this.expiryOf(sess), hashSid(sid), now);
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  override length(cb: (err: unknown, length?: number) => void): void {
    try {
      cb(null, (this.stmt.count.get(this.now()) as { n: number }).n);
    } catch (err) {
      cb(err);
    }
  }

  override clear(cb?: Callback): void {
    try {
      this.stmt.clear.run();
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  /** Signs a user out everywhere (used by password reset). Other users are unaffected. Returns the number of sessions removed. */
  destroyUserSessions(userId: string): number {
    return transaction(this.db, () => {
      const rows = this.stmt.userSids.all(userId) as { sid_hash: string }[];
      const now = this.now();
      for (const { sid_hash } of rows) {
        this.stmt.delete.run(sid_hash);
        this.stmt.tombstone.run(sid_hash, now);
      }
      return rows.length;
    });
  }

  /** Removes expired sessions and old tombstones. Returns counts for logging. */
  prune(): { sessions: number; tombstones: number } {
    const now = this.now();
    return transaction(this.db, () => ({
      sessions: Number(this.stmt.pruneSessions.run(now).changes),
      tombstones: Number(this.stmt.pruneTombstones.run(now - this.options.tombstoneTtlMs).changes),
    }));
  }

  private expiryOf(sess: SessionData): number {
    const expires = sess.cookie?.expires;
    const ms = expires ? new Date(expires).getTime() : NaN;
    return Number.isFinite(ms) ? ms : this.now() + this.options.defaultTtlMs;
  }
}

function pickPersisted(sess: SessionData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PERSISTED_FIELDS) {
    if (sess[field] !== undefined) out[field] = sess[field];
  }
  return out;
}
