import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // backend/.env, resolved relative to this file so it works from src/ and dist/
      envFilePath: join(import.meta.dirname, '..', '.env'),
      validate: validateEnv,
    }),
    HealthModule,
  ],
})
export class AppModule {}
