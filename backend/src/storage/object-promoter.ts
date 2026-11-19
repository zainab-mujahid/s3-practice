/**
 * Staging -> verify -> promote pipeline (used by the upload endpoints of
 * Steps 4 and 5; Step 3 only provides and tests it against a mocked S3).
 *
 *   completeUpload(uploadId, userId)
 *     1. intent must be PENDING, unexpired and owned by userId
 *     2. ObjectVerifier checks the staging object (size, signature, structure, type)
 *        - invalid -> intent REJECTED, staging object deleted, nothing becomes active
 *     3. CopyObject staging -> new final key (If-Match the verified ETag)
 *     4. one SQLite transaction: asset -> new key, old key queued for deletion,
 *        intent COMPLETED
 *     5. best-effort deletes (staging object, replaced object); failures stay
 *        queued in pending_deletions and are retried later
 *
 * The previously active image is deleted only after step 4 committed.
 */
import { Injectable, Logger } from '@nestjs/common';
import { formatFromContentType } from './image-rules.js';
import { type ImageAsset, ImageMetadataStore } from './image-metadata.store.js';
import { ObjectVerifier, type VerificationFailure } from './object-verifier.js';
import { S3StorageService, StorageError } from './s3-storage.service.js';
import { type BucketAlias, finalKeyFor } from './storage-locations.js';

export type CompletionResult =
  | { ok: true; asset: ImageAsset; replacedKey: string | null }
  | { ok: false; reason: VerificationFailure | 'PROMOTION_FAILED' };

@Injectable()
export class ObjectPromoter {
  private readonly logger = new Logger('ObjectPromoter');

  constructor(
    private readonly storage: S3StorageService,
    private readonly verifier: ObjectVerifier,
    private readonly metadata: ImageMetadataStore,
  ) {}

  /** Throws MetadataError for intent problems and StorageError for S3 outages; returns a verdict otherwise. */
  async completeUpload(uploadId: string, userId: string, opts: { maxDishes?: number } = {}): Promise<CompletionResult> {
    const intent = this.metadata.requirePendingIntent(uploadId, userId);
    const expectedFormat = formatFromContentType(intent.declaredType);
    if (!expectedFormat) {
      await this.reject(uploadId, intent.bucket, intent.stagingKey, 'TYPE_MISMATCH');
      return { ok: false, reason: 'TYPE_MISMATCH' };
    }

    const verdict = await this.verifier.verify(intent.bucket, intent.stagingKey, expectedFormat);
    if (!verdict.ok) {
      await this.reject(uploadId, intent.bucket, intent.stagingKey, verdict.reason);
      return { ok: false, reason: verdict.reason };
    }

    const finalKey = finalKeyFor(intent.kind, verdict.format, intent.staffId ?? undefined);
    try {
      await this.storage.copyObject({
        bucket: intent.bucket,
        sourceKey: intent.stagingKey,
        destinationKey: finalKey,
        sourceEtag: verdict.etag,
        contentType: verdict.contentType,
      });
    } catch (err) {
      if (err instanceof StorageError && err.code === 'PRECONDITION_FAILED') {
        // Staging object was overwritten after verification: never publish it.
        await this.reject(uploadId, intent.bucket, intent.stagingKey, 'CHANGED_DURING_VERIFICATION');
        return { ok: false, reason: 'CHANGED_DURING_VERIFICATION' };
      }
      throw err; // intent stays PENDING; client may retry until it expires
    }

    let result: { asset: ImageAsset; replacedKey: string | null };
    try {
      result = this.metadata.activateUpload({
        uploadId,
        userId,
        finalKey,
        contentType: verdict.contentType,
        sizeBytes: verdict.size,
        maxDishes: opts.maxDishes,
      });
    } catch (err) {
      // The copy is not referenced by anything: remove it, keep the old image active.
      await this.deleteOrQueue(intent.bucket, finalKey, 'activation-failed');
      throw err;
    }

    await this.deleteOrQueue(intent.bucket, intent.stagingKey, 'staging-promoted');
    if (result.replacedKey) await this.processDeletion(intent.bucket, result.replacedKey);
    return { ok: true, ...result };
  }

  /** Marks the intent rejected and removes its staging object. */
  async reject(uploadId: string, bucket: BucketAlias, stagingKey: string, reason: string): Promise<void> {
    this.metadata.rejectIntent(uploadId, reason);
    this.logger.log(`Upload ${uploadId} rejected: ${reason}`);
    await this.deleteOrQueue(bucket, stagingKey, `rejected:${reason}`);
  }

  /** Removes an active asset: metadata first (atomically queued), then the object. */
  async removeAsset(assetId: string): Promise<ImageAsset | undefined> {
    const asset = this.metadata.removeAsset(assetId);
    if (asset) await this.processDeletion(asset.bucket, asset.objectKey);
    return asset;
  }

  /** Retries queued deletions whose backoff has elapsed. Returns how many succeeded. */
  async retryPendingDeletions(limit = 20): Promise<number> {
    let done = 0;
    for (const item of this.metadata.dueDeletions(limit)) {
      if (await this.processDeletion(item.bucket, item.objectKey)) done++;
    }
    return done;
  }

  private async deleteOrQueue(bucket: BucketAlias, key: string, reason: string): Promise<void> {
    this.metadata.enqueueDeletion(bucket, key, reason);
    await this.processDeletion(bucket, key);
  }

  /** Deletes a queued object unless an active asset uses it. Never throws. */
  private async processDeletion(bucket: BucketAlias, key: string): Promise<boolean> {
    if (this.metadata.isActiveKey(bucket, key)) {
      this.metadata.deletionSucceeded(bucket, key); // drop from queue; never delete an active image
      return false;
    }
    try {
      await this.storage.deleteObject(bucket, key);
      this.metadata.deletionSucceeded(bucket, key);
      return true;
    } catch {
      this.metadata.deletionFailed(bucket, key);
      return false;
    }
  }
}
