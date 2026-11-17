import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { mockClient } from 'aws-sdk-client-mock';
import { s3Error } from '../../test/fixtures/fake-s3.js';
import { buildS3ClientConfig } from './s3-client.provider.js';
import { mapS3Error, S3StorageService, StorageError } from './s3-storage.service.js';
import { StorageConfig } from './storage.config.js';
import { InvalidObjectKeyError } from './storage-locations.js';

const U = '0f8fad5b-d9cb-469f-a165-70867728950e';
const env = { AWS_REGION: 'us-east-1', S3_PUBLIC_BUCKET: 'pub-bucket', S3_PRIVATE_BUCKET: 'priv-bucket', AWS_EXPECTED_BUCKET_OWNER: undefined };

let client: S3Client;
let s3: ReturnType<typeof mockClient>;
let logs: string[];

function service(overrides: Partial<typeof env> = {}) {
  return new S3StorageService(client, StorageConfig.fromEnv({ ...env, ...overrides }));
}

beforeEach(() => {
  client = new S3Client(buildS3ClientConfig({ NODE_ENV: 'test', AWS_REGION: 'us-east-1' }));
  s3 = mockClient(client);
  logs = [];
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => void logs.push(String(m)));
  }
});

afterEach(() => {
  s3.restore();
  vi.restoreAllMocks();
});

describe('S3StorageService — guards (no SDK call for disallowed keys)', () => {
  it.each([
    ['headObject', (s: S3StorageService) => s.headObject('PUBLIC', `staff/staff-001/${U}.png`)],
    ['headObject traversal', (s: S3StorageService) => s.headObject('PRIVATE', `staff/staff-001/../../${U}.png`)],
    ['readHead', (s: S3StorageService) => s.readHead('PRIVATE', `dishes/${U}.jpg`, 16)],
    ['deleteObject', (s: S3StorageService) => s.deleteObject('PUBLIC', 'dishes/')],
    ['listKeys whole bucket', (s: S3StorageService) => s.listKeys('PRIVATE', '')],
    ['listKeys foreign prefix', (s: S3StorageService) => s.listKeys('PUBLIC', 'staff/')],
    ['copy final->final', (s: S3StorageService) =>
      s.copyObject({ bucket: 'PUBLIC', sourceKey: `dishes/${U}.jpg`, destinationKey: `logo/${U}.jpg`, sourceEtag: '"x"', contentType: 'image/jpeg' })],
    ['copy staging->staging', (s: S3StorageService) =>
      s.copyObject({ bucket: 'PUBLIC', sourceKey: `staging/${U}`, destinationKey: `staging/${U}`, sourceEtag: '"x"', contentType: 'image/jpeg' })],
    ['copy private staging -> public bucket key', (s: S3StorageService) =>
      s.copyObject({ bucket: 'PUBLIC', sourceKey: `staging/staff/${U}`, destinationKey: `dishes/${U}.jpg`, sourceEtag: '"x"', contentType: 'image/jpeg' })],
    ['copy public staging -> staff key in public bucket', (s: S3StorageService) =>
      s.copyObject({ bucket: 'PUBLIC', sourceKey: `staging/${U}`, destinationKey: `staff/staff-001/${U}.jpg`, sourceEtag: '"x"', contentType: 'image/jpeg' })],
  ])('%s', async (_, call) => {
    await expect(call(service())).rejects.toBeInstanceOf(InvalidObjectKeyError);
    expect(s3.calls()).toHaveLength(0);
  });
});

describe('S3StorageService — commands', () => {
  it('headObject resolves the bucket name from the alias and returns size/type/etag', async () => {
    s3.on(HeadObjectCommand).resolves({ ContentLength: 123, ContentType: 'image/png', ETag: '"abc"' });
    await expect(service().headObject('PRIVATE', `staging/staff/${U}`)).resolves.toEqual({ size: 123, contentType: 'image/png', etag: '"abc"' });
    expect(s3.commandCalls(HeadObjectCommand)[0].args[0].input).toEqual({ Bucket: 'priv-bucket', Key: `staging/staff/${U}` });
  });

  it('sends ExpectedBucketOwner when configured', async () => {
    s3.on(DeleteObjectCommand).resolves({});
    await service({ AWS_EXPECTED_BUCKET_OWNER: '123456789012' }).deleteObject('PUBLIC', `dishes/${U}.jpg`);
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input).toEqual({
      Bucket: 'pub-bucket',
      Key: `dishes/${U}.jpg`,
      ExpectedBucketOwner: '123456789012',
    });
  });

  it('reads head and tail byte ranges pinned to an ETag, and caps the returned length', async () => {
    const big = new Uint8Array(100).map((_, i) => i);
    s3.on(GetObjectCommand).resolves({ Body: { transformToByteArray: async () => big } as never });
    const head = await service().readHead('PUBLIC', `staging/${U}`, 16, '"e1"');
    const tail = await service().readTail('PUBLIC', `staging/${U}`, 32, '"e1"');
    expect(head).toHaveLength(16);
    expect(head[0]).toBe(0);
    expect(tail).toHaveLength(32);
    expect(tail[31]).toBe(99);
    const inputs = s3.commandCalls(GetObjectCommand).map((c) => c.args[0].input);
    expect(inputs[0]).toMatchObject({ Range: 'bytes=0-15', IfMatch: '"e1"' });
    expect(inputs[1]).toMatchObject({ Range: 'bytes=-32', IfMatch: '"e1"' });
  });

  it('refuses absurd range lengths', async () => {
    await expect(service().readHead('PUBLIC', `staging/${U}`, 5_000_000)).rejects.toBeInstanceOf(RangeError);
    expect(s3.calls()).toHaveLength(0);
  });

  it('copies staging -> final in the same bucket with If-Match, replaced metadata and no ACL', async () => {
    s3.on(CopyObjectCommand).resolves({});
    await service().copyObject({
      bucket: 'PUBLIC',
      sourceKey: `staging/${U}`,
      destinationKey: `dishes/${U}.webp`,
      sourceEtag: '"etag-1"',
      contentType: 'image/webp',
    });
    const input = s3.commandCalls(CopyObjectCommand)[0].args[0].input;
    expect(input).toEqual({
      Bucket: 'pub-bucket',
      Key: `dishes/${U}.webp`,
      CopySource: `pub-bucket/staging/${U}`,
      CopySourceIfMatch: '"etag-1"',
      MetadataDirective: 'REPLACE',
      ContentType: 'image/webp',
      ContentDisposition: 'inline',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    expect(input).not.toHaveProperty('ACL');
  });

  it('marks promoted staff pictures as non-cacheable', async () => {
    s3.on(CopyObjectCommand).resolves({});
    await service().copyObject({
      bucket: 'PRIVATE',
      sourceKey: `staging/staff/${U}`,
      destinationKey: `staff/staff-002/${U}.png`,
      sourceEtag: '"e"',
      contentType: 'image/png',
    });
    expect(s3.commandCalls(CopyObjectCommand)[0].args[0].input.CacheControl).toBe('private, no-store');
  });

  it('lists keys under an allowed prefix with a bounded MaxKeys', async () => {
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: `dishes/${U}.jpg` }, {}] });
    await expect(service().listKeys('PUBLIC', 'dishes/', 5000)).resolves.toEqual([`dishes/${U}.jpg`]);
    expect(s3.commandCalls(ListObjectsV2Command)[0].args[0].input).toEqual({ Bucket: 'pub-bucket', Prefix: 'dishes/', MaxKeys: 1000 });
  });
});

describe('S3StorageService — errors', () => {
  it.each([
    [s3Error('AccessDenied', 403), 'ACCESS_DENIED'],
    [s3Error('Forbidden', 403), 'ACCESS_DENIED'],
    [s3Error('NotFound', 404), 'NOT_FOUND'],
    [s3Error('NoSuchKey', 404), 'NOT_FOUND'],
    [s3Error('NoSuchBucket', 404), 'NOT_FOUND'],
    [s3Error('PreconditionFailed', 412), 'PRECONDITION_FAILED'],
    [s3Error('PermanentRedirect', 301), 'WRONG_REGION'],
    [s3Error('AuthorizationHeaderMalformed', 400), 'WRONG_REGION'],
    [s3Error('ExpiredToken', 400), 'NO_CREDENTIALS'],
    [s3Error('InvalidAccessKeyId', 403), 'NO_CREDENTIALS'],
    [Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' }), 'NO_CREDENTIALS'],
    [s3Error('SlowDown', 503), 'UNAVAILABLE'],
    [new Error('ECONNREFUSED'), 'UNAVAILABLE'],
    [undefined, 'UNAVAILABLE'],
  ])('maps %s -> %s', (err, code) => {
    expect(mapS3Error(err)).toBe(code);
  });

  it('throws StorageError and never logs the AWS message (ARNs / account IDs)', async () => {
    s3.on(HeadObjectCommand).rejects(s3Error('AccessDenied', 403));
    const err = await service().headObject('PUBLIC', `staging/${U}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe('ACCESS_DENIED');
    expect((err as Error).message).not.toMatch(/arn:|123456789012|pub-bucket/);
    const text = logs.join('\n');
    expect(text).toContain('HeadObject PUBLIC');
    expect(text).toContain('AccessDenied');
    expect(text).not.toMatch(/arn:|123456789012|secret-bucket-name|pub-bucket/);
  });

  it('checkAccess uses a prefix-scoped ListObjectsV2 (never HeadBucket) and maps outcomes', async () => {
    s3.on(ListObjectsV2Command).resolvesOnce({}).rejectsOnce(s3Error('AccessDenied', 403)).rejectsOnce(s3Error('NoSuchBucket', 404))
      .rejectsOnce(s3Error('PermanentRedirect', 301)).rejectsOnce(new Error('socket hang up'));
    const s = service();
    expect(await s.checkAccess('PUBLIC')).toBe('ok');
    expect(await s.checkAccess('PRIVATE')).toBe('denied');
    expect(await s.checkAccess('PUBLIC')).toBe('bucket_not_found');
    expect(await s.checkAccess('PUBLIC')).toBe('wrong_region');
    expect(await s.checkAccess('PUBLIC')).toBe('unavailable');
    const inputs = s3.commandCalls(ListObjectsV2Command).map((c) => c.args[0].input);
    expect(inputs[0]).toEqual({ Bucket: 'pub-bucket', Prefix: 'dishes/', MaxKeys: 1 });
    expect(inputs[1]).toEqual({ Bucket: 'priv-bucket', Prefix: 'staff/', MaxKeys: 1 });
    expect(s3.calls().every((c) => c.args[0] instanceof ListObjectsV2Command)).toBe(true);
  });
});
