import { buildS3ClientConfig, createS3Client, TEST_S3_ENDPOINT } from './s3-client.provider.js';

describe('S3 client configuration', () => {
  it('in tests: fake static credentials and an unroutable loopback endpoint (can never reach AWS)', async () => {
    const cfg = buildS3ClientConfig({ NODE_ENV: 'test', AWS_REGION: 'us-east-1' });
    expect(cfg.endpoint).toBe(TEST_S3_ENDPOINT);
    expect(cfg.credentials).toEqual({ accessKeyId: 'TEST-NOT-A-REAL-KEY', secretAccessKey: 'TEST-NOT-A-REAL-SECRET' });
    expect(cfg.maxAttempts).toBe(1);

    // An unmocked call fails locally and fast instead of going anywhere.
    const client = createS3Client({ NODE_ENV: 'test', AWS_REGION: 'us-east-1' });
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    await expect(client.send(new ListObjectsV2Command({ Bucket: 'any-bucket', MaxKeys: 1 }))).rejects.toThrow();
    client.destroy();
  });

  it('outside tests: no credentials or endpoint in code (default provider chain / AWS_PROFILE)', () => {
    for (const NODE_ENV of ['development', 'production'] as const) {
      const cfg = buildS3ClientConfig({ NODE_ENV, AWS_REGION: 'eu-central-1' });
      expect(cfg.credentials).toBeUndefined();
      expect(cfg.endpoint).toBeUndefined();
      expect(cfg.region).toBe('eu-central-1');
      expect(cfg.forcePathStyle).toBeUndefined();
    }
  });

  it('only computes checksums when required (keeps browser presigned uploads working)', () => {
    const cfg = buildS3ClientConfig({ NODE_ENV: 'development', AWS_REGION: 'us-east-1' });
    expect(cfg.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(cfg.responseChecksumValidation).toBe('WHEN_REQUIRED');
  });
});
