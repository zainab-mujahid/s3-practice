/**
 * Thin, guarded wrapper around the S3 operations the backend needs.
 *
 * Rules enforced here for EVERY call, before the SDK is touched:
 *   - buckets are addressed by alias ('PUBLIC' | 'PRIVATE'), never by raw name;
 *   - keys/prefixes must match the allow-list in storage-locations.ts for that
 *     bucket (and for copy: staging -> final area in the SAME bucket);
 *   - ACLs are never set; ExpectedBucketOwner is sent when configured.
 *
 * Errors are reduced to a small set of codes. AWS error messages (which can
 * contain ARNs, account IDs or request IDs) are never logged or returned; only
 * the operation, bucket alias, key and AWS error *name* are logged.
 *
 * Step 3 scope: read/inspect/copy/delete/list helpers only. Presigned URL
 * generation is added in Steps 4 (POST) and 5 (POST + GET).
 */
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { S3_CLIENT } from './s3-client.provider.js';
import { StorageConfig } from './storage.config.js';
import {
  ACCESS_PROBE_PREFIX,
  assertAllowedKey,
  assertAllowedListPrefix,
  type BucketAlias,
  type ObjectArea,
} from './storage-locations.js';

export type StorageErrorCode =
  | 'NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'PRECONDITION_FAILED'
  | 'WRONG_REGION'
  | 'NO_CREDENTIALS'
  | 'UNAVAILABLE';

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    readonly operation: string,
  ) {
    super(`S3 ${operation} failed: ${code}`);
    this.name = 'StorageError';
  }
}

export interface ObjectInfo {
  size: number;
  contentType: string | undefined;
  etag: string;
}

export type BucketAccessStatus = 'ok' | 'denied' | 'bucket_not_found' | 'wrong_region' | 'no_credentials' | 'unavailable';

const STAGING_AREAS: readonly ObjectArea[] = ['PUBLIC_STAGING', 'STAFF_STAGING'];
const FINAL_AREAS: readonly ObjectArea[] = ['DISH', 'LOGO', 'STAFF'];

/** Cache headers set on promoted objects. Final keys are unique per upload, so public ones are immutable. */
const CACHE_CONTROL: Partial<Record<ObjectArea, string>> = {
  DISH: 'public, max-age=31536000, immutable',
  LOGO: 'public, max-age=31536000, immutable',
  STAFF: 'private, no-store',
};

export function mapS3Error(err: unknown): StorageErrorCode {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  const name = e?.name ?? '';
  const status = e?.$metadata?.httpStatusCode;
  if (name === 'CredentialsProviderError' || name === 'ExpiredToken' || name === 'InvalidAccessKeyId' || name === 'TokenRefreshRequired') {
    return 'NO_CREDENTIALS';
  }
  if (name === 'PermanentRedirect' || name === 'AuthorizationHeaderMalformed' || status === 301) return 'WRONG_REGION';
  if (name === 'NotFound' || name === 'NoSuchKey' || name === 'NoSuchBucket' || status === 404) return 'NOT_FOUND';
  if (name === 'PreconditionFailed' || status === 412) return 'PRECONDITION_FAILED';
  if (name === 'AccessDenied' || name === 'Forbidden' || status === 403) return 'ACCESS_DENIED';
  return 'UNAVAILABLE';
}

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

@Injectable()
export class S3StorageService {
  private readonly logger = new Logger('S3Storage');

  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client,
    private readonly config: StorageConfig,
  ) {}

  private owner() {
    return this.config.expectedBucketOwner ? { ExpectedBucketOwner: this.config.expectedBucketOwner } : {};
  }

  private async run<T>(operation: string, bucket: BucketAlias, target: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const code = mapS3Error(err);
      const name = (err as { name?: unknown })?.name;
      const level = code === 'NOT_FOUND' ? 'debug' : 'warn';
      this.logger[level](`${operation} ${bucket}:${target} failed: ${code} (${typeof name === 'string' ? name : 'Error'})`);
      throw new StorageError(code, operation);
    }
  }

  /** HeadObject. Note: without s3:ListBucket for the key, S3 reports a missing object as 403, not 404. */
  async headObject(bucket: BucketAlias, key: string): Promise<ObjectInfo> {
    assertAllowedKey(bucket, key);
    return this.run('HeadObject', bucket, key, async () => {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucketName(bucket), Key: key, ...this.owner() }));
      if (typeof res.ContentLength !== 'number' || !res.ETag) throw Object.assign(new Error('incomplete'), { name: 'Incomplete' });
      return { size: res.ContentLength, contentType: res.ContentType, etag: res.ETag };
    });
  }

  /** Range GET of the first `length` bytes. With `ifMatch`, fails if the object changed since HeadObject. */
  readHead(bucket: BucketAlias, key: string, length: number, ifMatch?: string): Promise<Uint8Array> {
    return this.readRange(bucket, key, `bytes=0-${length - 1}`, length, ifMatch);
  }

  /** Range GET of the last `length` bytes (whole object if smaller). */
  readTail(bucket: BucketAlias, key: string, length: number, ifMatch?: string): Promise<Uint8Array> {
    return this.readRange(bucket, key, `bytes=-${length}`, length, ifMatch);
  }

  private async readRange(bucket: BucketAlias, key: string, range: string, maxLength: number, ifMatch?: string): Promise<Uint8Array> {
    assertAllowedKey(bucket, key);
    if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 1024) throw new RangeError('range length out of bounds');
    return this.run('GetObject(range)', bucket, key, async () => {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucketName(bucket), Key: key, Range: range, IfMatch: ifMatch, ...this.owner() }),
      );
      if (!res.Body) throw Object.assign(new Error('no body'), { name: 'EmptyBody' });
      const bytes = await res.Body.transformToByteArray();
      // Never trust the server/mocks to honour the range: cap what we keep.
      return range.startsWith('bytes=-') ? bytes.subarray(Math.max(0, bytes.length - maxLength)) : bytes.subarray(0, maxLength);
    });
  }

  /**
   * Server-side copy of a verified staging object to its final key in the same
   * bucket. CopySourceIfMatch pins the exact bytes that were verified, so a
   * re-upload to the staging key between verification and copy makes the copy
   * fail (412) instead of publishing unverified content.
   */
  async copyObject(input: {
    bucket: BucketAlias;
    sourceKey: string;
    destinationKey: string;
    sourceEtag: string;
    contentType: string;
  }): Promise<void> {
    const { bucket, sourceKey, destinationKey } = input;
    assertAllowedKey(bucket, sourceKey, STAGING_AREAS);
    const destArea = assertAllowedKey(bucket, destinationKey, FINAL_AREAS);
    const name = this.config.bucketName(bucket);
    await this.run('CopyObject', bucket, destinationKey, async () => {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: name,
          Key: destinationKey,
          CopySource: `${name}/${encodeKey(sourceKey)}`,
          CopySourceIfMatch: input.sourceEtag,
          MetadataDirective: 'REPLACE',
          ContentType: input.contentType,
          ContentDisposition: 'inline',
          CacheControl: CACHE_CONTROL[destArea],
          ...this.owner(),
          ...(this.config.expectedBucketOwner ? { ExpectedSourceBucketOwner: this.config.expectedBucketOwner } : {}),
        }),
      );
    });
  }

  /** DeleteObject. Idempotent in S3: deleting a missing key succeeds. */
  async deleteObject(bucket: BucketAlias, key: string): Promise<void> {
    assertAllowedKey(bucket, key);
    await this.run('DeleteObject', bucket, key, async () => {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucketName(bucket), Key: key, ...this.owner() }));
    });
  }

  /** Lists up to maxKeys keys under an allow-listed prefix (matches the IAM s3:prefix condition). */
  async listKeys(bucket: BucketAlias, prefix: string, maxKeys = 100): Promise<string[]> {
    assertAllowedListPrefix(bucket, prefix);
    const limit = Math.min(Math.max(Math.trunc(maxKeys), 1), 1000);
    return this.run('ListObjectsV2', bucket, prefix, async () => {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.config.bucketName(bucket), Prefix: prefix, MaxKeys: limit, ...this.owner() }),
      );
      return (res.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string');
    });
  }

  /**
   * Read-only connectivity/permission probe: ListObjectsV2 with MaxKeys=1 on an
   * allow-listed prefix. HeadBucket is deliberately NOT used: it is authorised
   * by s3:ListBucket WITHOUT an s3:prefix, so the least-privilege policy (which
   * only allows listing specific prefixes) correctly denies it.
   */
  async checkAccess(bucket: BucketAlias): Promise<BucketAccessStatus> {
    try {
      await this.listKeys(bucket, ACCESS_PROBE_PREFIX[bucket], 1);
      return 'ok';
    } catch (err) {
      const code = err instanceof StorageError ? err.code : 'UNAVAILABLE';
      const map: Record<StorageErrorCode, BucketAccessStatus> = {
        ACCESS_DENIED: 'denied',
        NOT_FOUND: 'bucket_not_found',
        WRONG_REGION: 'wrong_region',
        NO_CREDENTIALS: 'no_credentials',
        PRECONDITION_FAILED: 'unavailable',
        UNAVAILABLE: 'unavailable',
      };
      return map[code];
    }
  }
}
