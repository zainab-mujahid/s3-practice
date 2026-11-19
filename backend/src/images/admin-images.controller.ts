import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Account } from '../auth/accounts.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { type CreateUploadDto, createUploadSchema, idParamSchema } from './images.schemas.js';
import { ImagesService, type PublicImage, type UploadAuthorization } from './images.service.js';

/**
 * Owner-only management of public images. Session + CSRF (global guards) + OWNER role.
 *
 *   POST   /api/admin/images/uploads                     201 presigned POST for a new logo / dish / dish replacement
 *   POST   /api/admin/images/uploads/:uploadId/complete  200 verify + publish
 *   DELETE /api/admin/images/:assetId                    204
 *
 * Replacing = uploading with kind LOGO (there is one logo) or with kind DISH + targetAssetId.
 */
@Controller('admin/images')
@Roles('OWNER')
export class AdminImagesController {
  constructor(private readonly images: ImagesService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  createUpload(@CurrentUser() user: Account, @Body({ schema: createUploadSchema }) body: CreateUploadDto): Promise<UploadAuthorization> {
    return this.images.createUpload(user, body);
  }

  @Post('uploads/:uploadId/complete')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  complete(
    @CurrentUser() user: Account,
    @Param('uploadId', { schema: idParamSchema }) uploadId: string,
  ): Promise<{ image: PublicImage; replaced: boolean }> {
    return this.images.completeUpload(user, uploadId);
  }

  @Delete(':assetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  remove(@Param('assetId', { schema: idParamSchema }) assetId: string): Promise<void> {
    return this.images.removeImage(assetId);
  }
}
