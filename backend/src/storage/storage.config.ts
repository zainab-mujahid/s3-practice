import type { AppEnv } from '../config/env.validation.js';
import { assertAllowedKey, type BucketAlias, PUBLICLY_READABLE_AREAS } from './storage-locations.js';

// Bucket names copied from .env.example / docs that were never replaced.
const PLACEHOLDER_BUCKET_RE = /replace-?me|your-|example|placeholder|change-?me/;

/**
 * Resolved storage settings. Bucket NAMES stay inside the backend: the rest of
 * the code (and every API response) refers to buckets only by alias.
 */
export class StorageConfig {
  private constructor(
    readonly region: string,
    private readonly buckets: Readonly<Record<BucketAlias, string>>,
    /** 12-digit account ID sent as ExpectedBucketOwner on every request, if configured. */
    readonly expectedBucketOwner: string | undefined,
  ) {}

  static fromEnv(
    env: Pick<AppEnv, 'AWS_REGION' | 'S3_PUBLIC_BUCKET' | 'S3_PRIVATE_BUCKET' | 'AWS_EXPECTED_BUCKET_OWNER'>,
  ): StorageConfig {
    return new StorageConfig(
      env.AWS_REGION,
      Object.freeze({ PUBLIC: env.S3_PUBLIC_BUCKET, PRIVATE: env.S3_PRIVATE_BUCKET }),
      env.AWS_EXPECTED_BUCKET_OWNER,
    );
  }

  bucketName(alias: BucketAlias): string {
    return this.buckets[alias];
  }

  /**
   * False while .env still contains placeholder bucket names. The storage health
   * check then makes no AWS call at all (a placeholder name could belong to a
   * stranger's bucket).
   */
  get configured(): boolean {
    return !PLACEHOLDER_BUCKET_RE.test(this.buckets.PUBLIC) && !PLACEHOLDER_BUCKET_RE.test(this.buckets.PRIVATE);
  }

  /**
   * Permanent anonymous URL of a PUBLIC dish/logo object (virtual-hosted style,
   * HTTPS). Refuses staging and private keys, so a private object can never be
   * handed out as a public URL by mistake.
   */
  publicObjectUrl(key: string): string {
    assertAllowedKey('PUBLIC', key, PUBLICLY_READABLE_AREAS);
    return `https://${this.buckets.PUBLIC}.s3.${this.region}.amazonaws.com/${key}`;
  }
}
