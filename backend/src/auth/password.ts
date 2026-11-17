/**
 * Password hashing with Node's built-in scrypt (memory-hard KDF).
 *
 * Stored format:  scrypt$<log2N>$<r>$<p>$<salt b64url>$<hash b64url>
 * The parameters travel with each hash, so they can be raised later without
 * breaking existing hashes. Parameters read from disk are bounds-checked so a
 * tampered file cannot make the server burn unbounded CPU/memory.
 */
import { randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export interface ScryptParams {
  log2N: number;
  r: number;
  p: number;
}

/** Default cost: N = 2^17, r = 8, p = 1 (~128 MiB, a few hundred ms per hash). */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { log2N: 17, r: 8, p: 1 };

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEMORY = 256 * 1024 * 1024;
const LIMITS = { log2N: [14, 20], r: [1, 16], p: [1, 4] } as const;

function scryptAsync(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function toOptions({ log2N, r, p }: ScryptParams): ScryptOptions {
  return { N: 2 ** log2N, r, p, maxmem: MAX_MEMORY };
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(password, salt, KEY_LENGTH, toOptions(params));
  return ['scrypt', params.log2N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

export function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [log2N, r, p] = parts.slice(1, 4).map((x) => (/^\d{1,2}$/.test(x) ? Number(x) : NaN));
  const inRange = (v: number, [min, max]: readonly [number, number]) => Number.isInteger(v) && v >= min && v <= max;
  if (!inRange(log2N, LIMITS.log2N) || !inRange(r, LIMITS.r) || !inRange(p, LIMITS.p)) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length < 16 || salt.length > 64 || key.length < 32 || key.length > 128) return null;
  return { params: { log2N, r, p }, salt, key };
}

/** Constant-time comparison. Returns false (never throws) for malformed hashes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const candidate = await scryptAsync(password, parsed.salt, parsed.key.length, toOptions(parsed.params));
  return timingSafeEqual(candidate, parsed.key);
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns roughly the same time as a real verification. Used for unknown
 * usernames so response timing does not reveal which accounts exist.
 */
export async function dummyVerify(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
  return false;
}

// No ambiguous characters (0/O, 1/l/I) so passwords are easy to type correctly.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** CSPRNG password. 20 chars over 57 symbols ≈ 116 bits of entropy. */
export function generatePassword(length = 20): string {
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return out;
}
