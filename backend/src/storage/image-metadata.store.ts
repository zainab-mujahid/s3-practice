/**
 * Persistent local metadata for images (SQLite, same app.db as sessions).
 *
 * Tracks:
 *   - image_assets      the ACTIVE logo (max 1), dishes, and staff pictures (max 1 per staff member);
 *   - upload_intents    every issued upload: who, for what target, staging key, expiry, outcome;
 *   - pending_deletions S3 objects still to be deleted (retried with backoff).
 *
 * Invariants (enforced in SQL and in activateUpload's single transaction):
 *   - an asset row only ever points at a verified, promoted, final object key;
 *   - an intent can be completed once, by the user who started it, before it expires;
 *   - the replaced object's key is queued for deletion in the SAME transaction
 *     that switches the asset to the new key, so the old image is only removed
 *     after the new one is verified and active, and is never forgotten.
 *
 * LOCAL DEVELOPMENT ONLY: single process; S3 and SQLite are not updated
 * atomically together (see docs/security-notes.md, known limitations).
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../persistence/sqlite.js';
import { assertAllowedKey, type BucketAlias, type ObjectArea } from './storage-locations.js';

export type AssetKind = 'DISH' | 'LOGO' | 'STAFF';
export type IntentStatus = 'PENDING' | 'COMPLETED' | 'REJECTED' | 'EXPIRED';

export interface ImageAsset {
  assetId: string;
  kind: AssetKind;
  staffId: string | null;
  bucket: BucketAlias;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface UploadIntent {
  uploadId: string;
  kind: AssetKind;
  bucket: BucketAlias;
  stagingKey: string;
  userId: string;
  staffId: string | null;
  targetAssetId: string | null;
  declaredType: string;
  declaredSize: number;
  status: IntentStatus;
  rejectReason: string | null;
  createdAt: number;
  expiresAt: number;
  finishedAt: number | null;
}

export interface PendingDeletion {
  bucket: BucketAlias;
  objectKey: string;
  reason: string;
  attempts: number;
}

export type MetadataErrorCode =
  | 'INTENT_NOT_FOUND'
  | 'INTENT_NOT_PENDING'
  | 'INTENT_EXPIRED'
  | 'INTENT_WRONG_USER'
  | 'TARGET_NOT_FOUND'
  | 'INVALID_INTENT';

export class MetadataError extends Error {
  constructor(readonly code: MetadataErrorCode) {
    super(`Image metadata error: ${code}`);
    this.name = 'MetadataError';
  }
}

const KIND_BUCKET: Record<AssetKind, BucketAlias> = { DISH: 'PUBLIC', LOGO: 'PUBLIC', STAFF: 'PRIVATE' };
const KIND_STAGING_AREA: Record<AssetKind, ObjectArea> = { DISH: 'PUBLIC_STAGING', LOGO: 'PUBLIC_STAGING', STAFF: 'STAFF_STAGING' };

export const DELETION_BACKOFF_BASE_MS = 60_000;
export const DELETION_BACKOFF_MAX_MS = 6 * 60 * 60_000;
/** Finished intents are kept this long (audit/debugging), then pruned. */
export const INTENT_RETENTION_MS = 7 * 24 * 60 * 60_000;

type Row = Record<string, string | number | null>;

const toAsset = (r: Row): ImageAsset => ({
  assetId: r.asset_id as string,
  kind: r.kind as AssetKind,
  staffId: r.staff_id as string | null,
  bucket: r.bucket_alias as BucketAlias,
  objectKey: r.object_key as string,
  contentType: r.content_type as string,
  sizeBytes: r.size_bytes as number,
  createdBy: r.created_by as string,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});

const toIntent = (r: Row): UploadIntent => ({
  uploadId: r.upload_id as string,
  kind: r.kind as AssetKind,
  bucket: r.bucket_alias as BucketAlias,
  stagingKey: r.staging_key as string,
  userId: r.user_id as string,
  staffId: r.staff_id as string | null,
  targetAssetId: r.target_asset_id as string | null,
  declaredType: r.declared_type as string,
  declaredSize: r.declared_size as number,
  status: r.status as IntentStatus,
  rejectReason: r.reject_reason as string | null,
  createdAt: r.created_at as number,
  expiresAt: r.expires_at as number,
  finishedAt: r.finished_at as number | null,
});

export class ImageMetadataStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------- intents

  createIntent(input: {
    kind: AssetKind;
    stagingKey: string;
    userId: string;
    staffId?: string | null;
    targetAssetId?: string | null;
    declaredType: string;
    declaredSize: number;
    ttlMs: number;
  }): UploadIntent {
    const bucket = KIND_BUCKET[input.kind];
    if (!bucket) throw new MetadataError('INVALID_INTENT');
    assertAllowedKey(bucket, input.stagingKey, [KIND_STAGING_AREA[input.kind]]);
    const staffId = input.staffId ?? null;
    if ((input.kind === 'STAFF') !== (staffId !== null)) throw new MetadataError('INVALID_INTENT');
    if (input.targetAssetId && input.kind !== 'DISH') throw new MetadataError('INVALID_INTENT');

    const now = this.now();
    const uploadId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO upload_intents (upload_id, kind, bucket_alias, staging_key, user_id, staff_id, target_asset_id,
           declared_type, declared_size, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(uploadId, input.kind, bucket, input.stagingKey, input.userId, staffId, input.targetAssetId ?? null,
        input.declaredType, input.declaredSize, now, now + input.ttlMs);
    return this.getIntent(uploadId)!;
  }

  getIntent(uploadId: string): UploadIntent | undefined {
    const row = this.db.prepare('SELECT * FROM upload_intents WHERE upload_id = ?').get(uploadId) as Row | undefined;
    return row ? toIntent(row) : undefined;
  }

  /** The intent, if `userId` may still complete it; otherwise throws MetadataError. */
  requirePendingIntent(uploadId: string, userId: string): UploadIntent {
    const intent = this.getIntent(uploadId);
    // Distinct codes for tests/logs only: HTTP handlers must answer both the same
    // way, so another user's upload looks exactly like a missing one.
    if (!intent || intent.userId !== userId) throw new MetadataError(intent ? 'INTENT_WRONG_USER' : 'INTENT_NOT_FOUND');
    if (intent.status !== 'PENDING') throw new MetadataError('INTENT_NOT_PENDING');
    if (intent.expiresAt <= this.now()) throw new MetadataError('INTENT_EXPIRED');
    return intent;
  }

  /** PENDING -> REJECTED. Returns false if the intent was not pending. */
  rejectIntent(uploadId: string, reason: string): boolean {
    const res = this.db
      .prepare(`UPDATE upload_intents SET status = 'REJECTED', reject_reason = ?, finished_at = ? WHERE upload_id = ? AND status = 'PENDING'`)
      .run(reason.slice(0, 64), this.now(), uploadId);
    return res.changes === 1;
  }

  /** Marks expired PENDING intents EXPIRED and returns them (their staging objects need cleanup). */
  expireIntents(): UploadIntent[] {
    return transaction(this.db, () => {
      const now = this.now();
      const rows = this.db
        .prepare(`SELECT * FROM upload_intents WHERE status = 'PENDING' AND expires_at <= ?`)
        .all(now) as Row[];
      this.db
        .prepare(`UPDATE upload_intents SET status = 'EXPIRED', finished_at = ? WHERE status = 'PENDING' AND expires_at <= ?`)
        .run(now, now);
      return rows.map((r) => ({ ...toIntent(r), status: 'EXPIRED' as const, finishedAt: now }));
    });
  }

  pruneFinishedIntents(): number {
    return Number(
      this.db
        .prepare(`DELETE FROM upload_intents WHERE status <> 'PENDING' AND finished_at < ?`)
        .run(this.now() - INTENT_RETENTION_MS).changes,
    );
  }

  // ----------------------------------------------------------------- assets

  getAsset(assetId: string): ImageAsset | undefined {
    const row = this.db.prepare('SELECT * FROM image_assets WHERE asset_id = ?').get(assetId) as Row | undefined;
    return row ? toAsset(row) : undefined;
  }

  getLogo(): ImageAsset | undefined {
    const row = this.db.prepare(`SELECT * FROM image_assets WHERE kind = 'LOGO'`).get() as Row | undefined;
    return row ? toAsset(row) : undefined;
  }

  getStaffPicture(staffId: string): ImageAsset | undefined {
    const row = this.db.prepare(`SELECT * FROM image_assets WHERE kind = 'STAFF' AND staff_id = ?`).get(staffId) as Row | undefined;
    return row ? toAsset(row) : undefined;
  }

  listDishes(): ImageAsset[] {
    return (this.db.prepare(`SELECT * FROM image_assets WHERE kind = 'DISH' ORDER BY created_at, asset_id`).all() as Row[]).map(toAsset);
  }

  /**
   * Atomically: re-checks the intent, points the target asset at `finalKey`
   * (creating it if new), queues the previously active object for deletion and
   * marks the intent COMPLETED. Call only after the object at `finalKey` exists
   * and was copied from a verified staging object.
   */
  activateUpload(input: { uploadId: string; userId: string; finalKey: string; contentType: string; sizeBytes: number }): {
    asset: ImageAsset;
    replacedKey: string | null;
  } {
    return transaction(this.db, () => {
      const intent = this.requirePendingIntent(input.uploadId, input.userId);
      const finalArea = assertAllowedKey(intent.bucket, input.finalKey, [intent.kind]);
      if (finalArea === 'STAFF' && !input.finalKey.startsWith(`staff/${intent.staffId}/`)) throw new MetadataError('INVALID_INTENT');

      const now = this.now();
      let existing: ImageAsset | undefined;
      if (intent.kind === 'LOGO') existing = this.getLogo();
      else if (intent.kind === 'STAFF') existing = this.getStaffPicture(intent.staffId!);
      else if (intent.targetAssetId) {
        existing = this.getAsset(intent.targetAssetId);
        if (!existing || existing.kind !== 'DISH') throw new MetadataError('TARGET_NOT_FOUND');
      }

      let assetId: string;
      if (existing) {
        assetId = existing.assetId;
        this.db
          .prepare(`UPDATE image_assets SET object_key = ?, content_type = ?, size_bytes = ?, updated_at = ? WHERE asset_id = ?`)
          .run(input.finalKey, input.contentType, input.sizeBytes, now, assetId);
        this.enqueueDeletionInternal(existing.bucket, existing.objectKey, 'replaced', now);
      } else {
        assetId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO image_assets (asset_id, kind, staff_id, bucket_alias, object_key, content_type, size_bytes, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(assetId, intent.kind, intent.staffId, intent.bucket, input.finalKey, input.contentType, input.sizeBytes, input.userId, now, now);
      }

      this.db
        .prepare(`UPDATE upload_intents SET status = 'COMPLETED', finished_at = ? WHERE upload_id = ?`)
        .run(now, intent.uploadId);
      return { asset: this.getAsset(assetId)!, replacedKey: existing ? existing.objectKey : null };
    });
  }

  /** Removes an asset and queues its object for deletion (same transaction). */
  removeAsset(assetId: string): ImageAsset | undefined {
    return transaction(this.db, () => {
      const asset = this.getAsset(assetId);
      if (!asset) return undefined;
      this.db.prepare('DELETE FROM image_assets WHERE asset_id = ?').run(assetId);
      this.enqueueDeletionInternal(asset.bucket, asset.objectKey, 'removed', this.now());
      return asset;
    });
  }

  // -------------------------------------------------------- pending deletions

  enqueueDeletion(bucket: BucketAlias, objectKey: string, reason: string): void {
    this.enqueueDeletionInternal(bucket, objectKey, reason, this.now());
  }

  private enqueueDeletionInternal(bucket: BucketAlias, objectKey: string, reason: string, now: number): void {
    assertAllowedKey(bucket, objectKey);
    this.db
      .prepare(
        `INSERT INTO pending_deletions (bucket_alias, object_key, reason, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT (bucket_alias, object_key) DO NOTHING`,
      )
      .run(bucket, objectKey, reason.slice(0, 64), now, now);
  }

  dueDeletions(limit = 20): PendingDeletion[] {
    const rows = this.db
      .prepare(`SELECT * FROM pending_deletions WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`)
      .all(this.now(), limit) as Row[];
    return rows.map((r) => ({
      bucket: r.bucket_alias as BucketAlias,
      objectKey: r.object_key as string,
      reason: r.reason as string,
      attempts: r.attempts as number,
    }));
  }

  /** Called after S3 confirmed the deletion (or the deletion was skipped as unsafe). */
  deletionSucceeded(bucket: BucketAlias, objectKey: string): void {
    this.db.prepare('DELETE FROM pending_deletions WHERE bucket_alias = ? AND object_key = ?').run(bucket, objectKey);
  }

  deletionFailed(bucket: BucketAlias, objectKey: string): void {
    const row = this.db
      .prepare('SELECT attempts FROM pending_deletions WHERE bucket_alias = ? AND object_key = ?')
      .get(bucket, objectKey) as { attempts: number } | undefined;
    const attempts = (row?.attempts ?? 0) + 1;
    const delay = Math.min(DELETION_BACKOFF_BASE_MS * 2 ** (attempts - 1), DELETION_BACKOFF_MAX_MS);
    this.db
      .prepare('UPDATE pending_deletions SET attempts = ?, next_attempt_at = ? WHERE bucket_alias = ? AND object_key = ?')
      .run(attempts, this.now() + delay, bucket, objectKey);
  }

  /** True if an active asset uses this key (such an object must never be deleted). */
  isActiveKey(bucket: BucketAlias, objectKey: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM image_assets WHERE bucket_alias = ? AND object_key = ?').get(bucket, objectKey));
  }
}
