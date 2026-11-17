/**
 * The single S3Client used by the backend.
 *
 * Credentials: NOT configured here. The AWS SDK v3 default provider chain
 * resolves them (AWS_PROFILE -> ~/.aws/credentials / ~/.aws/config). Nothing
 * credential-related is read from .env by this code, logged, or sent to the
 * browser.
 *
 * Test safety net: with NODE_ENV=test the client gets obviously fake static
 * credentials and an unroutable loopback endpoint, so even a test that forgot to
 * mock S3 can never reach AWS or use the developer's real profile.
 */
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { AppEnv } from '../config/env.validation.js';

export const S3_CLIENT = Symbol('S3_CLIENT');

/** Port 9 ("discard") on loopback: connections are refused immediately. */
export const TEST_S3_ENDPOINT = 'http://127.0.0.1:9';

export function buildS3ClientConfig(env: Pick<AppEnv, 'NODE_ENV' | 'AWS_REGION'>): S3ClientConfig {
  const common: S3ClientConfig = {
    region: env.AWS_REGION,
    // Only add checksums when an operation requires them. The SDK default
    // (WHEN_SUPPORTED) adds CRC headers that break browser uploads to
    // presigned URLs in later steps.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };

  if (env.NODE_ENV === 'test') {
    return {
      ...common,
      endpoint: TEST_S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: 'TEST-NOT-A-REAL-KEY', secretAccessKey: 'TEST-NOT-A-REAL-SECRET' },
      maxAttempts: 1,
    };
  }

  return {
    ...common,
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
  };
}

export function createS3Client(env: Pick<AppEnv, 'NODE_ENV' | 'AWS_REGION'>): S3Client {
  return new S3Client(buildS3ClientConfig(env));
}
