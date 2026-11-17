/**
 * Local SQLite database (Node.js built-in `node:sqlite`).
 *
 * LOCAL DEVELOPMENT ONLY. One file on disk (backend/data/app.db), used by one
 * backend process. It is not a shared, replicated or encrypted store and is not
 * suitable for production / multi-instance deployments.
 *
 * Holds: sessions, destroyed-session tombstones, failed-login counters.
 * (Later steps add the image metadata store.)
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: readonly string[] = [
  // v1 — authentication
  `
  CREATE TABLE sessions (
    sid_hash   TEXT PRIMARY KEY,     -- SHA-256 of the session ID (raw IDs are never stored)
    user_id    TEXT,                 -- NULL for anonymous (CSRF-only) sessions
    data       TEXT NOT NULL,        -- JSON, whitelisted fields only
    expires_at INTEGER NOT NULL      -- epoch ms
  ) STRICT;
  CREATE INDEX idx_sessions_expires ON sessions(expires_at);
  CREATE INDEX idx_sessions_user    ON sessions(user_id);

  -- Session IDs that were destroyed (logout, regeneration, password reset).
  -- A late write from a concurrent request must never resurrect them.
  CREATE TABLE destroyed_sessions (
    sid_hash     TEXT PRIMARY KEY,
    destroyed_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_destroyed_at ON destroyed_sessions(destroyed_at);

  -- Failed logins per (username, client IP). See LoginAttemptStore.
  CREATE TABLE login_failures (
    username          TEXT NOT NULL,
    ip                TEXT NOT NULL,
    failures          INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL,
    locked_until      INTEGER,
    PRIMARY KEY (username, ip)
  ) STRICT;
  `,
];

export function openDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    // WAL: readers don't block the writer; busy_timeout: a second process
    // (e.g. the reset-password CLI) waits for locks instead of failing.
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);
    migrate(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      // PRAGMA cannot be parameterised; v is an internal integer, not user input.
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/**
 * Runs fn inside BEGIN IMMEDIATE … COMMIT (takes the write lock up front, so
 * read-then-write sequences are atomic even across processes). Rolls back on error.
 * node:sqlite is synchronous, so fn must not await.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore: the original error is more useful
    }
    throw err;
  }
}
