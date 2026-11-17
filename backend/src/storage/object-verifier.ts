/**
 * Post-upload verification of a STAGING object, done on the bytes actually in
 * S3 (the client's declared name/type/size are never trusted):
 *
 *   1. HeadObject             -> exists, size within 32 B .. 5 MB, ETag
 *   2. Range GET first 16 B   -> file signature (magic bytes)     } pinned to that ETag
 *   3. Range GET last 32 B    -> not truncated (EOI / IEND / RIFF) } with If-Match
 *   4. detected format == expected format == stored Content-Type
 *
 * Basic file-type verification only — see the caveats in magic-bytes.ts.
 *
 * "Missing" covers both 404 and 403: with s3:ListBucket restricted by an
 * s3:prefix condition, S3 answers HEAD/GET on a missing key with 403
 * AccessDenied instead of 404 (it will not reveal whether the key exists).
 */
import { Injectable } from '@nestjs/common';
import { IMAGE_FORMATS, type ImageFormat, MAX_IMAGE_BYTES, MIN_IMAGE_BYTES } from './image-rules.js';
import { HEAD_BYTES, inspectImageBytes, TAIL_BYTES } from './magic-bytes.js';
import { S3StorageService, StorageError } from './s3-storage.service.js';
import { assertAllowedKey, type BucketAlias } from './storage-locations.js';

export type VerificationFailure =
  | 'MISSING'
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'UNRECOGNISED_SIGNATURE'
  | 'TRUNCATED_OR_CORRUPT'
  | 'TYPE_MISMATCH'
  | 'CHANGED_DURING_VERIFICATION';

export interface VerifiedObject {
  format: ImageFormat;
  contentType: string;
  size: number;
  etag: string;
}

export type Verification = ({ ok: true } & VerifiedObject) | { ok: false; reason: VerificationFailure };

@Injectable()
export class ObjectVerifier {
  constructor(private readonly storage: S3StorageService) {}

  /**
   * Verifies a staging object. Returns a verdict for content problems; rethrows
   * StorageError for infrastructure problems (unavailable, credentials, region).
   */
  async verify(bucket: BucketAlias, stagingKey: string, expectedFormat: ImageFormat, maxBytes = MAX_IMAGE_BYTES): Promise<Verification> {
    assertAllowedKey(bucket, stagingKey, ['PUBLIC_STAGING', 'STAFF_STAGING']);

    const info = await this.guard(() => this.storage.headObject(bucket, stagingKey));
    if ('reason' in info) return info;
    if (info.size === 0) return { ok: false, reason: 'EMPTY' };
    if (info.size > maxBytes) return { ok: false, reason: 'TOO_LARGE' };
    if (info.size < MIN_IMAGE_BYTES) return { ok: false, reason: 'TRUNCATED_OR_CORRUPT' };

    const head = await this.guard(() => this.storage.readHead(bucket, stagingKey, HEAD_BYTES, info.etag));
    if ('reason' in head) return head;
    const tail = await this.guard(() => this.storage.readTail(bucket, stagingKey, TAIL_BYTES, info.etag));
    if ('reason' in tail) return tail;

    const inspection = inspectImageBytes({ head, tail, size: info.size });
    if (!inspection.ok) return inspection;

    const expectedType = IMAGE_FORMATS[expectedFormat].contentType;
    if (inspection.format !== expectedFormat || info.contentType?.toLowerCase() !== expectedType) {
      return { ok: false, reason: 'TYPE_MISMATCH' };
    }
    return { ok: true, format: inspection.format, contentType: expectedType, size: info.size, etag: info.etag };
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T | { ok: false; reason: VerificationFailure }> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StorageError) {
        if (err.code === 'NOT_FOUND' || err.code === 'ACCESS_DENIED') return { ok: false, reason: 'MISSING' };
        if (err.code === 'PRECONDITION_FAILED') return { ok: false, reason: 'CHANGED_DURING_VERIFICATION' };
      }
      throw err;
    }
  }
}
