import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { validationExceptionFactory } from './auth/auth.schemas.js';
import { validateEnv } from './config/env.validation.js';
import { HealthModule } from './health/health.module.js';
import { DEFAULT_ENV_FILE } from './paths.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { StaffModule } from './staff/staff.module.js';
import { StorageModule } from './storage/storage.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: DEFAULT_ENV_FILE,
      // Tests supply their own deterministic environment.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      validate: validateEnv,
    }),
    PersistenceModule,
    AuthModule,
    StaffModule,
    StorageModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new StandardSchemaValidationPipe({ exceptionFactory: validationExceptionFactory }),
    },
  ],
})
export class AppModule {}
