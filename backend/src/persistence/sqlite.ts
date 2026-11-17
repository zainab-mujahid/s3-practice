/**
 * Local SQLite database (Node.js built-in `node:sqlite`).
 *
 * LOCAL DEVELOPMENT ONLY. One file on disk (backend/data/app.db), used by one
 * backend process. It is not a shared, replicated or encrypted store and is not
 * suitable for production / multi-instance deployments.
 *
 * Holds: sessions, destroyed-session tombstones, failed-login counters (v1) and
 * image metadata: active images, upload intents, pending S3 deletions (v2).
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
  // v2 — image metadata (see storage/image-metadata.store.ts)
  `
  -- Active images only. A row exists only after its object was verified and
  -- promoted, so a failed/invalid upload can never become active.
  CREATE TABLE image_assets (
    asset_id     TEXT PRIMARY KEY,   -- stable ID (a dish keeps it across image replacements)
    kind         TEXT NOT NULL CHECK (kind IN ('DISH', 'LOGO', 'STAFF')),
    staff_id     TEXT,
    bucket_alias TEXT NOT NULL CHECK (bucket_alias IN ('PUBLIC', 'PRIVATE')),
    object_key   TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    CHECK ((kind = 'STAFF') = (bucket_alias = 'PRIVATE')),
    CHECK ((kind = 'STAFF') = (staff_id IS NOT NULL))
  ) STRICT;
  CREATE UNIQUE INDEX ux_assets_one_logo  ON image_assets(kind)     WHERE kind = 'LOGO';
  CREATE UNIQUE INDEX ux_assets_one_staff ON image_assets(staff_id) WHERE kind = 'STAFF';

  -- One row per issued upload URL: who may complete it, for what target, until when.
  CREATE TABLE upload_intents (
    upload_id       TEXT PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('DISH', 'LOGO', 'STAFF')),
    bucket_alias    TEXT NOT NULL CHECK (bucket_alias IN ('PUBLIC', 'PRIVATE')),
    staging_key     TEXT NOT NULL UNIQUE,
    user_id         TEXT NOT NULL,
    staff_id        TEXT,
    target_asset_id TEXT,            -- dish being replaced; NULL = new dish / logo / staff picture
    declared_type   TEXT NOT NULL,
    declared_size   INTEGER NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'REJECTED', 'EXPIRED')),
    reject_reason   TEXT,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    finished_at     INTEGER,
    CHECK ((kind = 'STAFF') = (bucket_alias = 'PRIVATE')),
    CHECK ((kind = 'STAFF') = (staff_id IS NOT NULL))
  ) STRICT;
  CREATE INDEX idx_intents_status_expires ON upload_intents(status, expires_at);

  -- S3 objects that must be deleted (replaced images, rejected/promoted staging
  -- objects) but whose deletion failed or has not happened yet. Retried later.
  CREATE TABLE pending_deletions (
    bucket_alias    TEXT NOT NULL CHECK (bucket_alias IN ('PUBLIC', 'PRIVATE')),
    object_key      TEXT NOT NULL,
    reason          TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (bucket_alias, object_key)
  ) STRICT;
  CREATE INDEX idx_pending_deletions_next ON pending_deletions(next_attempt_at);
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
