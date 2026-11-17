import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCredentials } from '../auth/credentials-file.js';
import { verifyPassword } from '../auth/password.js';
import { credentialsFile, databaseFile } from '../paths.js';
import { openDatabase } from '../persistence/sqlite.js';
import { SqliteSessionStore } from '../persistence/sqlite-session.store.js';
import { LoginAttemptStore } from '../persistence/login-attempt.store.js';
import { type CliIO, runResetPassword, runSetupAccounts } from './accounts-cli.js';

const FAST = { scryptParams: { log2N: 14, r: 8, p: 1 } };

let dir: string;
let paths: { envFile: string; dataDir: string };

function fakeIO(isTTY = true): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { isTTY, out: (l) => stdout.push(l), err: (l) => stderr.push(l), stdout, stderr };
}

/** Extracts "username -> password" from the printed table. */
function printedPasswords(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const m = /^\s{2}(owner|staff-\d{3})\s+(OWNER|STAFF)\s+\S+\s+(\S{20})$/.exec(line);
    if (m) out[m[1]] = m[3];
  }
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's3p-cli-'));
  paths = { envFile: join(dir, '.env'), dataDir: join(dir, 'data') };
  writeFileSync(paths.envFile, 'NODE_ENV=development\nBACKEND_PORT=3000\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('setup:accounts', () => {
  it('refuses to run when stdout is not a terminal, and changes nothing', async () => {
    const io = fakeIO(false);
    expect(await runSetupAccounts(paths, io, FAST)).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toMatch(/not an interactive terminal/);
    expect(existsSync(credentialsFile(paths.dataDir))).toBe(false);
    expect(readFileSync(paths.envFile, 'utf8')).not.toContain('SESSION_SECRET');
  });

  it('creates exactly owner, staff-001, staff-002 with hashed passwords and a session secret', async () => {
    const io = fakeIO();
    expect(await runSetupAccounts(paths, io, FAST)).toBe(0);

    const passwords = printedPasswords(io.stdout);
    expect(Object.keys(passwords).sort()).toEqual(['owner', 'staff-001', 'staff-002']);

    const creds = readCredentials(credentialsFile(paths.dataDir))!;
    expect(Object.keys(creds.accounts).sort()).toEqual(['owner', 'staff-001', 'staff-002']);
    const fileText = readFileSync(credentialsFile(paths.dataDir), 'utf8');
    for (const [user, pw] of Object.entries(passwords)) {
      expect(fileText).not.toContain(pw); // only hashes on disk
      expect(await verifyPassword(pw, creds.accounts[user].passwordHash)).toBe(true);
    }

    const env = readFileSync(paths.envFile, 'utf8');
    const secret = /^SESSION_SECRET=(.+)$/m.exec(env)?.[1];
    expect(secret && secret.length).toBeGreaterThanOrEqual(60);
    expect(env.startsWith('NODE_ENV=development\nBACKEND_PORT=3000\n')).toBe(true); // existing content preserved
    expect(io.stdout.join('\n')).not.toContain(secret!); // secret value never printed
  });

  it('never silently overwrites: a second run changes nothing', async () => {
    await runSetupAccounts(paths, fakeIO(), FAST);
    const credsBefore = readFileSync(credentialsFile(paths.dataDir), 'utf8');
    const envBefore = readFileSync(paths.envFile, 'utf8');

    const io = fakeIO();
    expect(await runSetupAccounts(paths, io, FAST)).toBe(1);
    expect(io.stderr.join('\n')).toMatch(/Already set up/);
    expect(readFileSync(credentialsFile(paths.dataDir), 'utf8')).toBe(credsBefore);
    expect(readFileSync(paths.envFile, 'utf8')).toBe(envBefore);
  });

  it('keeps an existing SESSION_SECRET and only creates missing accounts', async () => {
    writeFileSync(paths.envFile, 'SESSION_SECRET=existing-secret-value-that-must-not-change-123456\n');
    const io = fakeIO();
    expect(await runSetupAccounts(paths, io, FAST)).toBe(0);
    expect(readFileSync(paths.envFile, 'utf8')).toBe('SESSION_SECRET=existing-secret-value-that-must-not-change-123456\n');
    expect(io.stdout.join('\n')).toMatch(/Existing SESSION_SECRET kept unchanged/);
  });

  it('fills an empty SESSION_SECRET= line in place', async () => {
    writeFileSync(paths.envFile, 'A=1\nSESSION_SECRET=\nB=2\n');
    await runSetupAccounts(paths, fakeIO(), FAST);
    const env = readFileSync(paths.envFile, 'utf8');
    expect(env).toMatch(/^A=1\nSESSION_SECRET=[\w-]{64}\nB=2\n$/);
  });

  it('refuses when .env is missing', async () => {
    rmSync(paths.envFile);
    const io = fakeIO();
    expect(await runSetupAccounts(paths, io, FAST)).toBe(1);
    expect(existsSync(credentialsFile(paths.dataDir))).toBe(false);
  });
});

describe('reset-password', () => {
  it('refuses without a terminal', async () => {
    await runSetupAccounts(paths, fakeIO(), FAST);
    const before = readFileSync(credentialsFile(paths.dataDir), 'utf8');
    const io = fakeIO(false);
    expect(await runResetPassword('staff-001', paths, io, FAST)).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(readFileSync(credentialsFile(paths.dataDir), 'utf8')).toBe(before);
  });

  it('rejects unknown usernames', async () => {
    await runSetupAccounts(paths, fakeIO(), FAST);
    const io = fakeIO();
    expect(await runResetPassword('manager', paths, io, FAST)).toBe(1);
    expect(await runResetPassword(undefined, paths, io, FAST)).toBe(1);
    expect(io.stderr.join('\n')).toMatch(/one of: owner, staff-001, staff-002/);
  });

  it('replaces only that user’s hash, revokes only that user’s sessions and clears their lockouts', async () => {
    const setupIO = fakeIO();
    await runSetupAccounts(paths, setupIO, FAST);
    const original = printedPasswords(setupIO.stdout);

    // Pre-existing sessions and lockouts in the shared SQLite file
    const db = openDatabase(databaseFile(paths.dataDir));
    const store = new SqliteSessionStore(db, { defaultTtlMs: 3_600_000, tombstoneTtlMs: 3_600_000 });
    const cookie = { originalMaxAge: 3_600_000, expires: new Date(Date.now() + 3_600_000) };
    const set = (sid: string, userId: string) =>
      new Promise<void>((r) => store.set(sid, { cookie, userId } as never, () => r()));
    await set('a1', 'staff-001');
    await set('a2', 'staff-001');
    await set('b1', 'staff-002');
    await set('o1', 'owner');
    const attempts = new LoginAttemptStore(db);
    for (let i = 0; i < 5; i++) attempts.recordFailure('staff-001', '10.0.0.1');
    db.close();

    const io = fakeIO();
    expect(await runResetPassword('staff-001', paths, io, FAST)).toBe(0);
    expect(io.stdout.join('\n')).toMatch(/2 active session\(s\) for this user were signed out/);
    const newPassword = printedPasswords(io.stdout)['staff-001'];

    const creds = readCredentials(credentialsFile(paths.dataDir))!;
    expect(await verifyPassword(newPassword, creds.accounts['staff-001'].passwordHash)).toBe(true);
    expect(await verifyPassword(original['staff-001'], creds.accounts['staff-001'].passwordHash)).toBe(false);
    expect(await verifyPassword(original['staff-002'], creds.accounts['staff-002'].passwordHash)).toBe(true);
    expect(await verifyPassword(original.owner, creds.accounts.owner.passwordHash)).toBe(true);

    const db2 = openDatabase(databaseFile(paths.dataDir));
    const users = (db2.prepare('SELECT user_id FROM sessions ORDER BY user_id').all() as { user_id: string }[]).map((r) => r.user_id);
    expect(users).toEqual(['owner', 'staff-002']);
    expect(new LoginAttemptStore(db2).getLockStatus('staff-001', '10.0.0.1').locked).toBe(false);
    db2.close();
  });
});
