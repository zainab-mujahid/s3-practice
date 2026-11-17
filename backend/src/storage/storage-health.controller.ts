import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../auth/decorators.js';
import { type BucketAccessStatus, S3StorageService } from './s3-storage.service.js';
import { StorageConfig } from './storage.config.js';

export type StorageCheck = BucketAccessStatus | 'not_configured';

export interface StorageHealthResponse {
  ok: boolean;
  publicBucket: StorageCheck;
  privateBucket: StorageCheck;
  checkedAt: string;
}

/**
 * GET /api/admin/storage/health — OWNER only, read-only.
 *
 * Makes exactly one ListObjectsV2 (MaxKeys=1) call per bucket on an
 * allow-listed prefix and returns only a status word per bucket. No bucket
 * names, region, account ID, ARNs, keys or AWS error messages are returned.
 * Makes no AWS call at all while .env still has placeholder bucket names.
 */
@Controller('admin/storage')
export class StorageHealthController {
  constructor(
    private readonly storage: S3StorageService,
    private readonly config: StorageConfig,
  ) {}

  @Get('health')
  @Roles('OWNER')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async health(): Promise<StorageHealthResponse> {
    let publicBucket: StorageCheck = 'not_configured';
    let privateBucket: StorageCheck = 'not_configured';
    if (this.config.configured) {
      [publicBucket, privateBucket] = await Promise.all([this.storage.checkAccess('PUBLIC'), this.storage.checkAccess('PRIVATE')]);
    }
    return {
      ok: publicBucket === 'ok' && privateBucket === 'ok',
      publicBucket,
      privateBucket,
      checkedAt: new Date().toISOString(),
    };
  }
}
