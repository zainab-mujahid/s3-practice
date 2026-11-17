import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoginAttemptStore } from './login-attempt.store.js';
import { openDatabase } from './sqlite.js';

let dir: string;
let clock: number;
const policy = { maxFailures: 5, windowMs: 15 * 60_000, lockDurationMs: 15 * 60_000 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's3p-attempts-'));
  clock = 5_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function open() {
  const db = openDatabase(join(dir, 'app.db'));
  return { db, store: new LoginAttemptStore(db, policy, () => clock) };
}

describe('LoginAttemptStore', () => {
  it('locks a (username, IP) pair after 5 failures, with Retry-After', () => {
    const { db, store } = open();
    for (let i = 1; i <= 4; i++) expect(store.recordFailure('owner', '10.0.0.1').locked).toBe(false);
    const fifth = store.recordFailure('owner', '10.0.0.1');
    expect(fifth).toEqual({ locked: true, retryAfterSeconds: 900 });
    expect(store.getLockStatus('owner', '10.0.0.1').locked).toBe(true);
    db.close();
  });

  it('does not lock the same account for a different client (lockout DoS mitigation)', () => {
    const { db, store } = open();
    for (let i = 0; i < 5; i++) store.recordFailure('owner', '10.0.0.66');
    expect(store.getLockStatus('owner', '10.0.0.66').locked).toBe(true);
    expect(store.getLockStatus('owner', '10.0.0.1').locked).toBe(false);
    db.close();
  });

  it('persists counters and locks across restarts (SQLite, not memory)', () => {
    const first = open();
    for (let i = 0; i < 5; i++) first.store.recordFailure('staff-001', '10.0.0.2');
    first.db.close();

    const second = open();
    expect(second.store.getLockStatus('staff-001', '10.0.0.2').locked).toBe(true);
    second.db.close();
  });

  it('unlocks after the lock duration and starts a fresh window', () => {
    const { db, store } = open();
    for (let i = 0; i < 5; i++) store.recordFailure('owner', 'ip');
    clock += policy.lockDurationMs + 1;
    expect(store.getLockStatus('owner', 'ip').locked).toBe(false);
    expect(store.recordFailure('owner', 'ip').locked).toBe(false); // counter restarted at 1
    db.close();
  });

  it('failures outside the window do not accumulate', () => {
    const { db, store } = open();
    for (let i = 0; i < 4; i++) store.recordFailure('owner', 'ip');
    clock += policy.windowMs + 1;
    expect(store.recordFailure('owner', 'ip').locked).toBe(false);
    db.close();
  });

  it('success clears the pair; clearUser clears every IP for that user only', () => {
    const { db, store } = open();
    for (let i = 0; i < 4; i++) store.recordFailure('owner', 'ip1');
    store.recordSuccess('owner', 'ip1');
    for (let i = 0; i < 4; i++) expect(store.recordFailure('owner', 'ip1').locked).toBe(false);

    for (let i = 0; i < 5; i++) {
      store.recordFailure('staff-001', 'ipA');
      store.recordFailure('staff-001', 'ipB');
      store.recordFailure('staff-002', 'ipA');
    }
    store.clearUser('staff-001');
    expect(store.getLockStatus('staff-001', 'ipA').locked).toBe(false);
    expect(store.getLockStatus('staff-001', 'ipB').locked).toBe(false);
    expect(store.getLockStatus('staff-002', 'ipA').locked).toBe(true);
    db.close();
  });

  it('truncates oversized keys so junk input cannot bloat the table', () => {
    const { db, store } = open();
    store.recordFailure('x'.repeat(10_000), 'y'.repeat(10_000));
    const row = db.prepare('SELECT length(username) AS u, length(ip) AS i FROM login_failures').get() as { u: number; i: number };
    expect(row).toEqual({ u: 64, i: 64 });
    db.close();
  });
});
