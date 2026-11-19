import { z } from 'zod';
import { MAX_IMAGE_BYTES, MIN_IMAGE_BYTES } from '../storage/image-rules.js';

/** Server-generated IDs (randomUUID) only; anything else is rejected before any lookup. */
export const idParamSchema = z.uuid('Invalid id');

/**
 * POST /api/admin/images/uploads
 * Strict: unknown fields (bucket, key, objectKey, userId, …) are rejected, so a
 * client can never choose where an object is stored or who owns the upload.
 * fileName is used only to cross-check the declared type; it never becomes a key.
 */
export const createUploadSchema = z
  .strictObject({
    kind: z.enum(['LOGO', 'DISH']),
    /** Replace this existing dish image (DISH only). Omit to add a new dish / set the logo. */
    targetAssetId: z.uuid('Invalid targetAssetId').optional(),
    fileName: z.string().trim().min(1, 'fileName is required').max(255, 'fileName is too long'),
    contentType: z.string().trim().min(1, 'contentType is required').max(100, 'contentType is too long'),
    size: z
      .number()
      .int('size must be an integer')
      .min(MIN_IMAGE_BYTES, `File is too small (minimum ${MIN_IMAGE_BYTES} bytes)`)
      .max(MAX_IMAGE_BYTES, 'File is too large (maximum 5 MB)'),
  })
  .refine((v) => v.kind === 'DISH' || v.targetAssetId === undefined, {
    message: 'targetAssetId is only allowed for DISH uploads',
    path: ['targetAssetId'],
  });

export type CreateUploadDto = z.infer<typeof createUploadSchema>;
