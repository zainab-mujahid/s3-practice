import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { idParamSchema } from './images.schemas.js';
import { ImagesService, type PublicImage } from './images.service.js';

/**
 * Published restaurant images. Anyone may read (anonymous visitors included).
 * Returns metadata + the permanent public S3 URL only; reads SQLite, makes no
 * AWS call. Private (staff) pictures are never returned here.
 *
 *   GET /api/public/images            { logo, dishes }
 *   GET /api/public/images/:assetId   { image }   404 for unknown / non-public ids
 */
@Controller('public/images')
@Public()
export class PublicImagesController {
  constructor(private readonly images: ImagesService) {}

  @Get()
  list(): { logo: PublicImage | null; dishes: PublicImage[] } {
    return this.images.listPublic();
  }

  @Get(':assetId')
  get(@Param('assetId', { schema: idParamSchema }) assetId: string): { image: PublicImage } {
    return { image: this.images.getPublic(assetId) };
  }
}
