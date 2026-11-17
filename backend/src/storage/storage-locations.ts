/**
 * Where objects may live. Single source of truth for bucket aliases, prefixes
 * and object-key formats.
 *
 * - Keys are ALWAYS generated here on the server (random UUIDs). Client file
 *   names never become part of a key.
 * - Every S3 call goes through assertAllowedKey(), which accepts only the exact
 *   key shapes below for the given bucket. A staff key can never be used against
 *   the public bucket, "../" or other prefixes never reach the SDK, etc.
 * - Prefixes are NOT a security boundary by themselves: what makes dishes/ and
 *   logo/ public is the bucket policy. These checks are the application-side
 *   half of a defence-in-depth pair with the IAM policy (docs/policies).
 */
import { randomUUID } from 'node:crypto';
import { STAFF_ID_PATTERN } from '../auth/accounts.js';
import { IMAGE_FORMATS, type ImageFormat } from './image-rules.js';

export type BucketAlias = 'PUBLIC' | 'PRIVATE';

export type ObjectArea =
  | 'PUBLIC_STAGING' // public bucket, staging/{uuid}         — never publicly readable
  | 'DISH' //           public bucket, dishes/{uuid}.{ext}    — publicly readable
  | 'LOGO' //           public bucket, logo/{uuid}.{ext}      — publicly readable
  | 'STAFF_STAGING' //  private bucket, staging/staff/{uuid}
  | 'STAFF'; //         private bucket, staff/{staffId}/{uuid}.{ext}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const EXT = '(?:jpg|png|webp)';

interface KeyRule {
  area: ObjectArea;
  pattern: RegExp;
}

const KEY_RULES: Readonly<Record<BucketAlias, readonly KeyRule[]>> = Object.freeze({
  PUBLIC: [
    { area: 'PUBLIC_STAGING', pattern: new RegExp(`^staging/${UUID}$`) },
    { area: 'DISH', pattern: new RegExp(`^dishes/${UUID}\\.${EXT}$`) },
    { area: 'LOGO', pattern: new RegExp(`^logo/${UUID}\\.${EXT}$`) },
  ],
  PRIVATE: [
    { area: 'STAFF_STAGING', pattern: new RegExp(`^staging/staff/${UUID}$`) },
    { area: 'STAFF', pattern: new RegExp(`^staff/staff-\\d{3}/${UUID}\\.${EXT}$`) },
  ],
});

/** Areas whose objects the public bucket policy makes anonymously readable. */
export const PUBLICLY_READABLE_AREAS: readonly ObjectArea[] = ['DISH', 'LOGO'];

/**
 * Prefixes the backend may list (ListObjectsV2). They mirror the s3:prefix
 * condition on s3:ListBucket in docs/policies/backend-iam-policy.sample.json.
 */
const LIST_PREFIX_RULES: Readonly<Record<BucketAlias, readonly RegExp[]>> = Object.freeze({
  PUBLIC: [/^dishes\/$/, /^logo\/$/, /^staging\/$/],
  PRIVATE: [/^staff\/$/, /^staff\/staff-\d{3}\/$/, /^staging\/staff\/$/],
});

/** Read-only probe prefix per bucket, used by the storage health check. */
export const ACCESS_PROBE_PREFIX: Readonly<Record<BucketAlias, string>> = Object.freeze({
  PUBLIC: 'dishes/',
  PRIVATE: 'staff/',
});

export class InvalidObjectKeyError extends Error {
  constructor(readonly bucket: BucketAlias) {
    // The key itself is deliberately not included (it may be attacker-controlled).
    super(`Object key rejected for ${bucket} bucket`);
    this.name = 'InvalidObjectKeyError';
  }
}

export function isBucketAlias(value: unknown): value is BucketAlias {
  return value === 'PUBLIC' || value === 'PRIVATE';
}

/** Returns the area of a key in the given bucket, or null if the key is not allowed there. */
export function classifyKey(bucket: BucketAlias, key: string): ObjectArea | null {
  if (typeof key !== 'string' || key.length > 200) return null;
  const rule = KEY_RULES[bucket]?.find((r) => r.pattern.test(key));
  return rule?.area ?? null;
}

/** Throws InvalidObjectKeyError unless key is valid for bucket (and, if given, in one of `areas`). */
export function assertAllowedKey(bucket: BucketAlias, key: string, areas?: readonly ObjectArea[]): ObjectArea {
  const area = classifyKey(bucket, key);
  if (!area || (areas && !areas.includes(area))) throw new InvalidObjectKeyError(bucket);
  return area;
}

export function assertAllowedListPrefix(bucket: BucketAlias, prefix: string): void {
  if (!LIST_PREFIX_RULES[bucket]?.some((re) => re.test(prefix))) throw new InvalidObjectKeyError(bucket);
}

/** Bucket in which an area lives. */
export function bucketOfArea(area: ObjectArea): BucketAlias {
  return area === 'STAFF' || area === 'STAFF_STAGING' ? 'PRIVATE' : 'PUBLIC';
}

const ext = (format: ImageFormat) => IMAGE_FORMATS[format].extension;

function assertStaffId(staffId: string): void {
  if (!STAFF_ID_PATTERN.test(staffId)) throw new InvalidObjectKeyError('PRIVATE');
}

/** Server-side key generators. The only way new object keys are created. */
export const objectKeys = Object.freeze({
  publicStaging: (): string => `staging/${randomUUID()}`,
  dish: (format: ImageFormat): string => `dishes/${randomUUID()}.${ext(format)}`,
  logo: (format: ImageFormat): string => `logo/${randomUUID()}.${ext(format)}`,
  staffStaging: (): string => `staging/staff/${randomUUID()}`,
  staffPicture: (staffId: string, format: ImageFormat): string => {
    assertStaffId(staffId);
    return `staff/${staffId}/${randomUUID()}.${ext(format)}`;
  },
});

/** Final (non-staging) key for an area, chosen after the uploaded bytes were verified. */
export function finalKeyFor(area: 'DISH' | 'LOGO' | 'STAFF', format: ImageFormat, staffId?: string): string {
  if (area === 'DISH') return objectKeys.dish(format);
  if (area === 'LOGO') return objectKeys.logo(format);
  if (!staffId) throw new InvalidObjectKeyError('PRIVATE');
  return objectKeys.staffPicture(staffId, format);
}
