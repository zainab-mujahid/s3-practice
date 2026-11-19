/**
 * Periodic, idempotent cleanup (every 5 minutes, not in tests):
 *   1. PENDING intents past their deadline -> EXPIRED (conditional UPDATE), and
 *      their STAGING objects queued for deletion. An expired intent can never be
 *      completed, so its staging object can never become a published image.
 *   2. Retry queued deletions. ObjectPromoter.processDeletion re-checks that no
 *      active asset uses the key right before deleting, and final keys are
 *      unique UUIDs that are never reused, so an active image is never deleted.
 *   3. Prune finished intents older than the retention period.
 * Re-running any step is harmless: queue inserts are ON CONFLICT DO NOTHING and
 * S3 deletes of missing keys succeed. Makes no AWS call while storage is not configured.
 */
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env.validation.js';
import { ImageMetadataStore } from '../storage/image-metadata.store.js';
import { ObjectPromoter } from '../storage/object-promoter.js';
import { StorageConfig } from '../storage/storage.config.js';

export const MAINTENANCE_INTERVAL_MS = 5 * 60_000;

export interface MaintenanceReport {
  expired: number;
  deleted: number;
  pruned: number;
}

@Injectable()
export class UploadMaintenance implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('UploadMaintenance');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly metadata: ImageMetadataStore,
    private readonly promoter: ObjectPromoter,
    private readonly config: StorageConfig,
    private readonly env: ConfigService<AppEnv, true>,
  ) {}

  onModuleInit() {
    if (this.env.get('NODE_ENV', { infer: true }) === 'test') return;
    this.timer = setInterval(() => void this.runOnce(), MAINTENANCE_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  /** One pass. Returns null if skipped (already running / not configured) or failed. Never throws. */
  async runOnce(): Promise<MaintenanceReport | null> {
    if (this.running || !this.config.configured) return null;
    this.running = true;
    try {
      const expired = this.metadata.expireIntents();
      for (const intent of expired) this.metadata.enqueueDeletion(intent.bucket, intent.stagingKey, 'intent-expired');
      const deleted = await this.promoter.retryPendingDeletions(50);
      const pruned = this.metadata.pruneFinishedIntents();
      if (expired.length || deleted || pruned) {
        this.logger.log(`Expired ${expired.length} uploads, deleted ${deleted} queued objects, pruned ${pruned} intents`);
      }
      return { expired: expired.length, deleted, pruned };
    } catch (err) {
      this.logger.warn(`Upload maintenance failed: ${err instanceof Error ? err.name : 'Error'}`);
      return null;
    } finally {
      this.running = false;
    }
  }
}
