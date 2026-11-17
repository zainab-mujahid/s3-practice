import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { type AppEnv, staticAwsKeysPresent } from './config/env.validation.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);
  const logger = new Logger('Bootstrap');

  // All routes live under /api; the Vite dev server proxies /api to this backend,
  // so the browser only ever talks to one origin.
  app.setGlobalPrefix('api');
  app.disable('x-powered-by');
  app.enableShutdownHooks();

  if (staticAwsKeysPresent(process.env)) {
    logger.warn(
      'Static AWS access keys were found in the environment. They override AWS_PROFILE in the SDK ' +
        'credential chain. Prefer AWS_PROFILE for local development. (Values are not logged.)',
    );
  }

  const port = config.get('BACKEND_PORT', { infer: true });
  // Bind to loopback only: this is a local learning app.
  await app.listen(port, '127.0.0.1');
  logger.log(`Backend listening on http://127.0.0.1:${port}/api (NODE_ENV=${config.get('NODE_ENV', { infer: true })})`);
}

await bootstrap();
