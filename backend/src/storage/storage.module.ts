import { Inject, Injectable, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { S3Client } from '@aws-sdk/client-s3';
import type { DatabaseSync } from 'node:sqlite';
import type { AppEnv } from '../config/env.validation.js';
import { DATABASE } from '../persistence/persistence.module.js';
import { ImageMetadataStore } from './image-metadata.store.js';
import { ObjectPromoter } from './object-promoter.js';
import { ObjectVerifier } from './object-verifier.js';
import { createS3Client, S3_CLIENT } from './s3-client.provider.js';
import { S3StorageService } from './s3-storage.service.js';
import { StorageConfig } from './storage.config.js';
import { StorageHealthController } from './storage-health.controller.js';

@Injectable()
class StorageLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Storage');

  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client,
    private readonly config: StorageConfig,
  ) {}

  onModuleInit() {
    // No AWS call at startup: the app must boot without AWS being set up.
    if (!this.config.configured) {
      this.logger.warn('S3 bucket names in backend/.env are still placeholders; storage features stay disabled until they are set.');
    }
  }

  onApplicationShutdown() {
    this.client.destroy();
  }
}

@Module({
  controllers: [StorageHealthController],
  providers: [
    {
      provide: StorageConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) =>
        StorageConfig.fromEnv({
          AWS_REGION: config.get('AWS_REGION', { infer: true }),
          S3_PUBLIC_BUCKET: config.get('S3_PUBLIC_BUCKET', { infer: true }),
          S3_PRIVATE_BUCKET: config.get('S3_PRIVATE_BUCKET', { infer: true }),
          AWS_EXPECTED_BUCKET_OWNER: config.get('AWS_EXPECTED_BUCKET_OWNER', { infer: true }),
        }),
    },
    {
      provide: S3_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) =>
        createS3Client({ NODE_ENV: config.get('NODE_ENV', { infer: true }), AWS_REGION: config.get('AWS_REGION', { infer: true }) }),
    },
    {
      provide: ImageMetadataStore,
      inject: [DATABASE],
      useFactory: (db: DatabaseSync) => new ImageMetadataStore(db),
    },
    S3StorageService,
    ObjectVerifier,
    ObjectPromoter,
    StorageLifecycle,
  ],
  exports: [StorageConfig, S3StorageService, ObjectVerifier, ObjectPromoter, ImageMetadataStore],
})
export class StorageModule {}
