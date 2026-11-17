/**
 * Logic behind `npm run setup:accounts` and `npm run reset-password -- <username>`.
 *
 * Security properties:
 *  - Passwords come from a CSPRNG and are hashed with scrypt before storage.
 *  - Only hashes are written (backend/data/accounts.json, git-ignored).
 *  - Plaintext passwords are written ONLY to an interactive terminal. If stdout
 *    is not a TTY (piped, redirected, captured by a tool/CI/AI assistant), the
 *    command refuses to run and writes nothing.
 *  - Nothing existing is overwritten silently: setup only fills in what is
 *    missing (accounts and/or SESSION_SECRET); resets are explicit, per user.
 *  - A reset signs that user out everywhere (their sessions only) and clears
 *    their failed-login counters.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ACCOUNTS, findAccountByUsername } from '../auth/accounts.js';
import { readCredentials, writeCredentialsAtomic, type CredentialsFile } from '../auth/credentials-file.js';
import { DEFAULT_SCRYPT_PARAMS, generatePassword, hashPassword, type ScryptParams } from '../auth/password.js';
import { credentialsFile, databaseFile } from '../paths.js';
import { LoginAttemptStore } from '../persistence/login-attempt.store.js';
import { openDatabase } from '../persistence/sqlite.js';
import { SqliteSessionStore } from '../persistence/sqlite-session.store.js';

export interface CliIO {
  /** Must be true for any command that shows a password. */
  isTTY: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliPaths {
  envFile: string;
  dataDir: string;
}

export interface CliOptions {
  scryptParams?: ScryptParams;
}

const NOT_A_TTY_MESSAGE =
  'Refusing to run: standard output is not an interactive terminal.\n' +
  'This command prints newly generated passwords, so it must be run by you in a\n' +
  'terminal window (PowerShell, Windows Terminal or the VS Code terminal), not\n' +
  'piped, redirected or run by an automated tool. Nothing was changed.\n' +
  '(Git Bash/mintty users: prefix the command with `winpty`.)';

const SESSION_SECRET_LINE = /^[ \t]*SESSION_SECRET[ \t]*=[ \t]*(.*?)[ \t]*$/m;

function readSessionSecret(envText: string): string | null {
  const match = SESSION_SECRET_LINE.exec(envText);
  return match && match[1] !== '' ? match[1] : null;
}

function printPasswords(io: CliIO, rows: { username: string; role: string; staffId: string | null; password: string }[]) {
  const width = Math.max(...rows.map((r) => r.username.length), 8);
  io.out('');
  io.out('  Username'.padEnd(width + 4) + 'Role    Staff ID    Password');
  io.out('  ' + '-'.repeat(width + 2 + 8 + 12 + 20));
  for (const r of rows) {
    io.out(`  ${r.username.padEnd(width + 2)}${r.role.padEnd(8)}${(r.staffId ?? '-').padEnd(12)}${r.password}`);
  }
  io.out('');
  io.out('  These passwords are shown ONCE and are not stored anywhere in plaintext.');
  io.out('  Save them in a password manager now. If you lose one, run:');
  io.out('    npm run reset-password -- <username>');
  io.out('');
}

export async function runSetupAccounts(paths: CliPaths, io: CliIO, opts: CliOptions = {}): Promise<number> {
  if (!io.isTTY) {
    io.err(NOT_A_TTY_MESSAGE);
    return 2;
  }
  if (!existsSync(paths.envFile)) {
    io.err('backend/.env not found. Copy backend/.env.example to backend/.env first. Nothing was changed.');
    return 1;
  }

  const credsPath = credentialsFile(paths.dataDir);
  let existing: CredentialsFile | null;
  try {
    existing = readCredentials(credsPath);
  } catch (err) {
    io.err(`${(err as Error).message}. Fix or remove it manually. Nothing was changed.`);
    return 1;
  }

  const envText = readFileSync(paths.envFile, 'utf8');
  const hasSecret = readSessionSecret(envText) !== null;
  const missingAccounts = ACCOUNTS.filter((a) => !existing?.accounts[a.username]);

  if (hasSecret && missingAccounts.length === 0) {
    io.err('Already set up: all accounts and SESSION_SECRET exist. Nothing was changed.');
    io.err('To replace a password, run: npm run reset-password -- <username>');
    return 1;
  }

  // 1. Accounts (only the missing ones; existing hashes are kept untouched).
  const created: { username: string; role: string; staffId: string | null; password: string }[] = [];
  if (missingAccounts.length > 0) {
    const next: CredentialsFile = { version: 1, accounts: { ...existing?.accounts } };
    for (const account of missingAccounts) {
      const password = generatePassword();
      next.accounts[account.username] = {
        passwordHash: await hashPassword(password, opts.scryptParams ?? DEFAULT_SCRYPT_PARAMS),
        updatedAt: new Date().toISOString(),
      };
      created.push({ username: account.username, role: account.role, staffId: account.staffId, password });
    }
    writeCredentialsAtomic(credsPath, next);
  }

  // 2. SESSION_SECRET (only if absent/empty; an existing secret is never replaced).
  if (!hasSecret) {
    const secret = randomBytes(48).toString('base64url');
    const line = `SESSION_SECRET=${secret}`;
    if (SESSION_SECRET_LINE.test(envText)) {
      // An empty "SESSION_SECRET=" line exists: fill it in place.
      writeFileSync(paths.envFile, envText.replace(SESSION_SECRET_LINE, line));
    } else {
      const sep = envText.length === 0 || envText.endsWith('\n') ? '' : '\n';
      appendFileSync(paths.envFile, `${sep}\n# Generated by npm run setup:accounts. Keep private; never commit.\n${line}\n`);
    }
    io.out('SESSION_SECRET generated and saved to backend/.env (value not shown).');
  } else {
    io.out('Existing SESSION_SECRET kept unchanged.');
  }

  const kept = ACCOUNTS.length - missingAccounts.length;
  if (kept > 0) io.out(`${kept} existing account(s) kept unchanged.`);
  if (created.length > 0) {
    io.out(`Created ${created.length} account(s). Password hashes saved to backend/data/accounts.json.`);
    printPasswords(io, created);
  }
  return 0;
}

export async function runResetPassword(
  usernameArg: string | undefined,
  paths: CliPaths,
  io: CliIO,
  opts: CliOptions = {},
): Promise<number> {
  if (!io.isTTY) {
    io.err(NOT_A_TTY_MESSAGE);
    return 2;
  }
  const valid = ACCOUNTS.map((a) => a.username).join(', ');
  const username = (usernameArg ?? '').trim().toLowerCase();
  const account = findAccountByUsername(username);
  if (!account) {
    io.err(`Usage: npm run reset-password -- <username>   (one of: ${valid}). Nothing was changed.`);
    return 1;
  }

  const credsPath = credentialsFile(paths.dataDir);
  let existing: CredentialsFile | null;
  try {
    existing = readCredentials(credsPath);
  } catch (err) {
    io.err(`${(err as Error).message}. Fix or remove it manually. Nothing was changed.`);
    return 1;
  }
  if (!existing?.accounts[username]) {
    io.err(`Account "${username}" has not been set up yet. Run: npm run setup:accounts. Nothing was changed.`);
    return 1;
  }

  const password = generatePassword();
  const passwordHash = await hashPassword(password, opts.scryptParams ?? DEFAULT_SCRYPT_PARAMS);

  // 1. Publish the new hash first: from now on the old password no longer works.
  writeCredentialsAtomic(credsPath, {
    version: 1,
    accounts: { ...existing.accounts, [username]: { passwordHash, updatedAt: new Date().toISOString() } },
  });

  // 2. Then sign that user out everywhere. (Doing this first would leave a gap in
  //    which a login with the old password could create a session that survives.)
  const db = openDatabase(databaseFile(paths.dataDir));
  let revoked: number;
  try {
    revoked = new SqliteSessionStore(db, { defaultTtlMs: 0, tombstoneTtlMs: 0 }).destroyUserSessions(account.id);
    new LoginAttemptStore(db).clearUser(username);
  } finally {
    db.close();
  }

  io.out(`Password for "${username}" was reset. ${revoked} active session(s) for this user were signed out.`);
  io.out('Other users were not affected.');
  printPasswords(io, [{ username, role: account.role, staffId: account.staffId, password }]);
  return 0;
}

/** Real terminal IO for the CLI entry points. */
export function processIO(): CliIO {
  return {
    isTTY: Boolean(process.stdout.isTTY),
    out: (line) => process.stdout.write(line + '\n'),
    err: (line) => process.stderr.write(line + '\n'),
  };
}
