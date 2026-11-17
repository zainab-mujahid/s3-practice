/**
 * backend/data/accounts.json — password HASHES only (git-ignored, backend-only).
 * Roles and staff IDs are NOT stored here; they come from accounts.ts.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const credentialsSchema = z.object({
  version: z.literal(1),
  accounts: z.record(
    z.string().regex(/^[a-z0-9-]{1,64}$/),
    z.object({
      passwordHash: z.string().startsWith('scrypt$').max(512),
      updatedAt: z.string().max(64),
    }),
  ),
});

export type CredentialsFile = z.infer<typeof credentialsSchema>;

export class CredentialsFileError extends Error {}

/** Returns null if the file does not exist. Throws CredentialsFileError if it is malformed. */
export function readCredentials(file: string): CredentialsFile | null {
  if (!existsSync(file)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new CredentialsFileError('accounts.json is not valid JSON');
  }
  const parsed = credentialsSchema.safeParse(json);
  if (!parsed.success) throw new CredentialsFileError('accounts.json has an unexpected structure');
  return parsed.data;
}

/** Write-to-temp then rename, so readers never see a half-written file. */
export function writeCredentialsAtomic(file: string, data: CredentialsFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(credentialsSchema.parse(data), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
