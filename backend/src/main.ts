import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { type AppEnv, staticAwsKeysPresent } from './config/env.validation.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);
  const logger = new Logger('Bootstrap');

  // /api prefix, sessions, trust proxy, no-store headers.
  configureApp(app);
  app.enableShutdownHooks();

  if (staticAwsKeysPresent(process.env)) {
    logger.warn(
      'Static AWS access keys were found in the environment. They override AWS_PROFILE in the SDK ' +
        'credential chain. Prefer AWS_PROFILE for local development. (Values are not logged.)',
    );
  }
  if (config.get('NODE_ENV', { infer: true }) === 'production' && !config.get('COOKIE_SECURE', { infer: true })) {
    logger.warn('COOKIE_SECURE=false in production: session cookies would be sent over plain HTTP.');
  }

  const port = config.get('BACKEND_PORT', { infer: true });
  // Bind to loopback only: this is a local learning app.
  await app.listen(port, '127.0.0.1');
  logger.log(`Backend listening on http://127.0.0.1:${port}/api (NODE_ENV=${config.get('NODE_ENV', { infer: true })})`);
}

await bootstrap();
