/**
 * Public restaurant images (logo + dishes): upload authorization, completion,
 * deletion and public listing.
 *
 *   React ──► POST /admin/images/uploads            (OWNER) intent + presigned POST for staging/{uuid}
 *   React ──► S3 (multipart POST, direct)
 *   React ──► POST /admin/images/uploads/:id/complete (OWNER) verify → copy → SQLite switch → cleanup
 *
 * Safety model:
 *   - Correctness under concurrency comes from SQLite, not from this process:
 *     intent creation + limits, activation and rejection are conditional
 *     transitions inside BEGIN IMMEDIATE transactions (image-metadata.store.ts).
 *     The in-process `completing` set only avoids duplicate S3 work.
 *   - A published image is only replaced inside the activation transaction, and
 *     only deleted after it; failures before that leave it untouched.
 *   - Responses never contain object keys, bucket aliases, staging keys or AWS
 *     error text. Logs never contain presigned fields or URLs.
 */
import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Account } from '../auth/accounts.js';
import { type ImageAsset, ImageMetadataStore, MetadataError } from '../storage/image-metadata.store.js';
import { checkDeclaredUpload, type DeclaredUploadRejection, IMAGE_FORMATS, PRESIGNED_POST_TTL_SECONDS } from '../storage/image-rules.js';
import { ObjectPromoter } from '../storage/object-promoter.js';
import type { VerificationFailure } from '../storage/object-verifier.js';
import { type PresignedUpload, S3StorageService, StorageError } from '../storage/s3-storage.service.js';
import { StorageConfig } from '../storage/storage.config.js';
import { InvalidObjectKeyError, objectKeys } from '../storage/storage-locations.js';
import type { CreateUploadDto } from './images.schemas.js';

/** Approved Step 4 abuse limits. */
export const UPLOAD_LIMITS = Object.freeze({ maxPendingPerUser: 10, maxDishes: 50 });

/**
 * How long an intent can be completed. The presigned POST itself expires after
 * PRESIGNED_POST_TTL_SECONDS (300 s); the extra time lets an upload that started
 * just before that finish and be completed. Expired intents are cleaned up by
 * UploadMaintenance.
 */
export const UPLOAD_INTENT_TTL_MS = 10 * 60_000;

export interface PublicImage {
  assetId: string;
  kind: 'LOGO' | 'DISH';
  url: string;
  contentType: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface UploadAuthorization {
  uploadId: string;
  /** When the presigned POST stops working (S3 rejects it after this). */
  expiresAt: string;
  /** Last moment the upload can be completed. */
  completeBy: string;
  upload: PresignedUpload;
}

const DECLARED_MESSAGES: Record<DeclaredUploadRejection, string> = {
  UNSUPPORTED_TYPE: 'Only JPEG, PNG and WebP images are allowed',
  TYPE_MISMATCH: 'The file extension does not match the file type',
  EMPTY: 'The file is empty',
  TOO_LARGE: 'File is too large (maximum 5 MB)',
  INVALID_SIZE: 'Invalid file size',
};

const VERIFICATION_MESSAGES: Record<VerificationFailure | 'PROMOTION_FAILED', string> = {
  MISSING: 'The uploaded file was not found. The upload may have failed or expired; please try again.',
  EMPTY: 'The uploaded file is empty',
  TOO_LARGE: 'The uploaded file is too large (maximum 5 MB)',
  UNRECOGNISED_SIGNATURE: 'The uploaded file is not a valid JPEG, PNG or WebP image',
  TRUNCATED_OR_CORRUPT: 'The uploaded file is incomplete or corrupt',
  TYPE_MISMATCH: 'The uploaded file content does not match its declared type',
  CHANGED_DURING_VERIFICATION: 'The uploaded file changed during verification; please upload it again',
  PROMOTION_FAILED: 'The image could not be published; please try again',
};

@Injectable()
export class ImagesService {
  private readonly logger = new Logger('Images');
  /** Upload IDs being completed by THIS process (efficiency only; SQLite guarantees correctness). */
  private readonly completing = new Set<string>();

  constructor(
    private readonly storage: S3StorageService,
    private readonly promoter: ObjectPromoter,
    private readonly metadata: ImageMetadataStore,
    private readonly config: StorageConfig,
  ) {}

  // ------------------------------------------------------------------ public

  listPublic(): { logo: PublicImage | null; dishes: PublicImage[] } {
    const logo = this.metadata.getLogo();
    return { logo: logo ? this.toPublic(logo) : null, dishes: this.metadata.listDishes().map((a) => this.toPublic(a)) };
  }

  getPublic(assetId: string): PublicImage {
    const asset = this.metadata.getPublicAsset(assetId);
    if (!asset) throw new NotFoundException('Image not found');
    return this.toPublic(asset);
  }

  // ------------------------------------------------------------------- owner

  async createUpload(user: Account, dto: CreateUploadDto): Promise<UploadAuthorization> {
    this.requireConfigured();
    const declared = checkDeclaredUpload({ fileName: dto.fileName, contentType: dto.contentType, size: dto.size });
    if (!declared.ok) {
      throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: DECLARED_MESSAGES[declared.reason], reason: declared.reason });
    }
    const contentType = IMAGE_FORMATS[declared.format].contentType; // canonical, lower-case

    let uploadId: string | undefined;
    try {
      const intent = this.metadata.createIntentWithinLimits(
        {
          kind: dto.kind,
          stagingKey: objectKeys.publicStaging(),
          userId: user.id,
          targetAssetId: dto.targetAssetId ?? null,
          declaredType: contentType,
          declaredSize: dto.size,
          ttlMs: UPLOAD_INTENT_TTL_MS,
        },
        UPLOAD_LIMITS,
      );
      uploadId = intent.uploadId;

      const upload = await this.storage.createPresignedPost({
        bucket: intent.bucket,
        key: intent.stagingKey,
        contentType,
        expiresInSeconds: PRESIGNED_POST_TTL_SECONDS,
      });
      this.logger.log(`Upload ${uploadId} authorised (${dto.kind}${dto.targetAssetId ? ' replace' : ''})`);
      return {
        uploadId,
        expiresAt: new Date(Date.now() + PRESIGNED_POST_TTL_SECONDS * 1000).toISOString(),
        completeBy: new Date(intent.expiresAt).toISOString(),
        upload,
      };
    } catch (err) {
      // An intent whose POST could not be signed must not count against the limit.
      if (uploadId && !(err instanceof MetadataError)) this.metadata.rejectIntent(uploadId, 'PRESIGN_FAILED');
      throw this.toHttp(err);
    }
  }

  async completeUpload(user: Account, uploadId: string): Promise<{ image: PublicImage; replaced: boolean }> {
    this.requireConfigured();
    const intent = this.metadata.getIntent(uploadId);
    // Unknown, another user's, or a non-public (staff) intent all look the same.
    if (!intent || intent.userId !== user.id || (intent.kind !== 'DISH' && intent.kind !== 'LOGO')) {
      throw new NotFoundException('Upload not found');
    }
    if (this.completing.has(uploadId)) throw new ConflictException('This upload is already being completed');
    this.completing.add(uploadId);
    try {
      let result;
      try {
        result = await this.promoter.completeUpload(uploadId, user.id, { maxDishes: UPLOAD_LIMITS.maxDishes });
      } catch (err) {
        // The target dish was deleted meanwhile, or the dish limit filled up: the
        // promoter already removed the unreferenced copy; reject the intent so its
        // staging object is removed too. Nothing published was touched.
        if (err instanceof MetadataError && (err.code === 'TARGET_NOT_FOUND' || err.code === 'DISH_LIMIT_REACHED')) {
          await this.promoter.reject(uploadId, intent.bucket, intent.stagingKey, err.code);
        }
        throw this.toHttp(err);
      }

      if (!result.ok) {
        // A concurrent request may have completed it first: report that, not a bogus verification error.
        if (this.metadata.getIntent(uploadId)?.status === 'COMPLETED') throw new ConflictException('Upload already completed');
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: VERIFICATION_MESSAGES[result.reason],
          reason: result.reason,
        });
      }
      this.logger.log(`Upload ${uploadId} published as ${result.asset.kind} ${result.asset.assetId}${result.replacedKey ? ' (replaced)' : ''}`);
      return { image: this.toPublic(result.asset), replaced: result.replacedKey !== null };
    } finally {
      this.completing.delete(uploadId);
    }
  }

  /**
   * Metadata first (one transaction removes the row and queues the object), then
   * the S3 delete. If S3 fails the object stays queued and is retried by
   * UploadMaintenance; the image is already gone from every listing.
   */
  async removeImage(assetId: string): Promise<void> {
    this.requireConfigured();
    if (!this.metadata.getPublicAsset(assetId)) throw new NotFoundException('Image not found');
    const removed = await this.promoter.removeAsset(assetId);
    if (!removed) throw new NotFoundException('Image not found'); // removed concurrently
    this.logger.log(`Image ${assetId} (${removed.kind}) removed`);
  }

  // ----------------------------------------------------------------- helpers

  private toPublic(asset: ImageAsset): PublicImage {
    return {
      assetId: asset.assetId,
      kind: asset.kind as 'LOGO' | 'DISH',
      url: this.config.publicObjectUrl(asset.objectKey),
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      updatedAt: new Date(asset.updatedAt).toISOString(),
    };
  }

  private requireConfigured(): void {
    if (!this.config.configured) throw new ServiceUnavailableException('Image storage is not configured');
  }

  private toHttp(err: unknown): Error {
    if (err instanceof HttpException) return err;
    if (err instanceof MetadataError) {
      switch (err.code) {
        case 'INTENT_NOT_FOUND':
        case 'INTENT_WRONG_USER':
          return new NotFoundException('Upload not found');
        case 'INTENT_NOT_PENDING':
          return new ConflictException('This upload was already completed or rejected');
        case 'INTENT_EXPIRED':
          return new GoneException('This upload has expired; please upload the file again');
        case 'TARGET_NOT_FOUND':
          return new NotFoundException('The dish image to replace no longer exists');
        case 'TOO_MANY_PENDING':
          return new ConflictException(`Too many unfinished uploads (maximum ${UPLOAD_LIMITS.maxPendingPerUser}); finish or wait for them to expire`);
        case 'DISH_LIMIT_REACHED':
          return new ConflictException(`Dish image limit reached (maximum ${UPLOAD_LIMITS.maxDishes})`);
        case 'INVALID_INTENT':
          return new BadRequestException('Invalid upload request');
      }
    }
    if (err instanceof StorageError) {
      return new ServiceUnavailableException('Image storage is temporarily unavailable; please try again');
    }
    const name = err instanceof InvalidObjectKeyError || err instanceof RangeError ? err.name : 'UnexpectedError';
    this.logger.error(`Image operation failed: ${name}`);
    return new InternalServerErrorException('Image operation failed');
  }
}
