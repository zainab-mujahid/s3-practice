import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { AdminImagesController } from './admin-images.controller.js';
import { ImagesService } from './images.service.js';
import { PublicImagesController } from './public-images.controller.js';
import { UploadMaintenance } from './upload-maintenance.js';

/** Step 4: public restaurant images (logo + dishes). */
@Module({
  imports: [StorageModule],
  controllers: [PublicImagesController, AdminImagesController],
  providers: [ImagesService, UploadMaintenance],
  exports: [ImagesService, UploadMaintenance],
})
export class ImagesModule {}
