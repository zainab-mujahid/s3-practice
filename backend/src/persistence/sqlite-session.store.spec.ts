import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionData } from 'express-session';
import { openDatabase } from './sqlite.js';
import { hashSid, SqliteSessionStore } from './sqlite-session.store.js';

let dir: string;
let db: DatabaseSync;
let clock: number;
let store: SqliteSessionStore;

const call = <T>(fn: (cb: (err: unknown, v?: T) => void) => void) =>
  new Promise<T | undefined>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

const sess = (extra: Partial<SessionData> & Record<string, unknown> = {}, expiresInMs = 60_000) =>
  ({ cookie: { originalMaxAge: expiresInMs, expires: new Date(clock + expiresInMs) }, ...extra }) as unknown as SessionData;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's3p-store-'));
  db = openDatabase(join(dir, 'app.db'));
  clock = 1_000_000;
  store = new SqliteSessionStore(db, { defaultTtlMs: 60_000, tombstoneTtlMs: 3_600_000, now: () => clock });
});

afterEach(() => {
  if (db.isOpen) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SqliteSessionStore', () => {
  it('round-trips a session', async () => {
    await call((cb) => store.set('sid-1', sess({ userId: 'staff-001', csrfToken: 't' }), cb));
    const got = await call<SessionData>((cb) => store.get('sid-1', cb));
    expect(got?.userId).toBe('staff-001');
    expect(got?.csrfToken).toBe('t');
  });

  it('stores only a SHA-256 hash of the session ID, never the raw ID', async () => {
    await call((cb) => store.set('raw-session-id-123', sess({ userId: 'owner' }), cb));
    const rows = db.prepare('SELECT sid_hash FROM sessions').all() as { sid_hash: string }[];
    expect(rows).toEqual([{ sid_hash: hashSid('raw-session-id-123') }]);
    expect(JSON.stringify(rows)).not.toContain('raw-session-id-123');
  });

  it('persists only whitelisted fields (a password put on the session never reaches disk)', async () => {
    await call((cb) =>
      store.set('sid-x', sess({ userId: 'owner', password: 'PlainTextOops', awsSecretAccessKey: 'AKIA-ish' }), cb),
    );
    const { data } = db.prepare('SELECT data FROM sessions').get() as { data: string };
    expect(data).not.toContain('PlainTextOops');
    expect(data).not.toContain('AKIA-ish');
    expect(Object.keys(JSON.parse(data)).sort()).toEqual(['cookie', 'userId']);
  });

  it('never returns an expired session and deletes it on read', async () => {
    await call((cb) => store.set('sid-exp', sess({ userId: 'owner' }, 1000), cb));
    clock += 1001;
    expect(await call((cb) => store.get('sid-exp', cb))).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(0);
  });

  it('destroy() prevents a late concurrent save from resurrecting the session', async () => {
    await call((cb) => store.set('sid-r', sess({ userId: 'owner' }), cb));
    // Request 1 logs out…
    await call((cb) => store.destroy('sid-r', cb));
    // …while request 2, which loaded the session earlier, finishes and saves it.
    await call((cb) => store.set('sid-r', sess({ userId: 'owner' }), cb));
    expect(await call((cb) => store.get('sid-r', cb))).toBeNull();
  });

  it('touch() extends an existing session but never creates or revives one', async () => {
    await call((cb) => store.set('sid-t', sess({}, 1000), cb));
    clock += 900;
    await call((cb) => store.touch('sid-t', sess({}, 1000), cb)); // now expires at clock+1000
    clock += 900;
    expect(await call((cb) => store.get('sid-t', cb))).not.toBeNull();

    await call((cb) => store.touch('never-existed', sess(), cb));
    expect(await call((cb) => store.get('never-existed', cb))).toBeNull();
  });

  it('destroyUserSessions() removes only that user’s sessions (all devices)', async () => {
    await call((cb) => store.set('a-laptop', sess({ userId: 'staff-001' }), cb));
    await call((cb) => store.set('a-phone', sess({ userId: 'staff-001' }), cb));
    await call((cb) => store.set('b-laptop', sess({ userId: 'staff-002' }), cb));
    await call((cb) => store.set('anon', sess({ csrfToken: 'x' }), cb));

    expect(store.destroyUserSessions('staff-001')).toBe(2);
    expect(await call((cb) => store.get('a-laptop', cb))).toBeNull();
    expect(await call((cb) => store.get('a-phone', cb))).toBeNull();
    expect(await call((cb) => store.get('b-laptop', cb))).not.toBeNull();
    expect(await call((cb) => store.get('anon', cb))).not.toBeNull();

    // and they cannot be resurrected by an in-flight request
    await call((cb) => store.set('a-laptop', sess({ userId: 'staff-001' }), cb));
    expect(await call((cb) => store.get('a-laptop', cb))).toBeNull();
  });

  it('discards corrupted rows instead of failing the request', async () => {
    db.prepare('INSERT INTO sessions (sid_hash, user_id, data, expires_at) VALUES (?, NULL, ?, ?)').run(
      hashSid('bad'),
      '{not json',
      clock + 10_000,
    );
    expect(await call((cb) => store.get('bad', cb))).toBeNull();
  });

  it('prune() removes expired sessions and old tombstones only', async () => {
    await call((cb) => store.set('old', sess({}, 1000), cb));
    await call((cb) => store.set('fresh', sess({}, 10_000_000), cb));
    await call((cb) => store.destroy('gone', cb));
    clock += 3_600_001;
    expect(store.prune()).toEqual({ sessions: 1, tombstones: 1 });
    expect(await call((cb) => store.get('fresh', cb))).not.toBeNull();
  });

  it('reports database failures through the callback (fail closed)', async () => {
    db.close();
    await expect(call((cb) => store.get('sid', cb))).rejects.toThrow();
    await expect(call((cb) => store.set('sid', sess(), cb))).rejects.toThrow();
    await expect(call((cb) => store.destroy('sid', cb))).rejects.toThrow();
  });

  it('length() counts unexpired sessions', async () => {
    await call((cb) => store.set('1', sess({}, 1000), cb));
    await call((cb) => store.set('2', sess({}, 5000), cb));
    clock += 2000;
    expect(await call<number>((cb) => store.length(cb))).toBe(1);
  });
});
