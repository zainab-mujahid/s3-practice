/**
 * Verify + promote pipeline against an in-memory fake S3 (aws-sdk-client-mock)
 * and a temporary SQLite database. No AWS involved.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { FakeS3, s3Error } from '../../test/fixtures/fake-s3.js';
import { htmlFile, textFile, truncate, validJpeg, validPng, validWebp } from '../../test/fixtures/images.js';
import { openDatabase } from '../persistence/sqlite.js';
import { ImageMetadataStore, type UploadIntent } from './image-metadata.store.js';
import { MAX_IMAGE_BYTES } from './image-rules.js';
import { ObjectPromoter } from './object-promoter.js';
import { ObjectVerifier } from './object-verifier.js';
import { buildS3ClientConfig } from './s3-client.provider.js';
import { S3StorageService, StorageError } from './s3-storage.service.js';
import { StorageConfig } from './storage.config.js';
import { objectKeys } from './storage-locations.js';

const PUB = 'pub-bucket';
const PRIV = 'priv-bucket';

let dir: string;
let db: DatabaseSync;
let client: S3Client;
let fake: FakeS3;
let storage: S3StorageService;
let verifier: ObjectVerifier;
let metadata: ImageMetadataStore;
let promoter: ObjectPromoter;

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  dir = mkdtempSync(join(tmpdir(), 's3p-pipe-'));
  db = openDatabase(join(dir, 'app.db'));
  client = new S3Client(buildS3ClientConfig({ NODE_ENV: 'test', AWS_REGION: 'us-east-1' }));
  fake = new FakeS3(client);
  const config = StorageConfig.fromEnv({ AWS_REGION: 'us-east-1', S3_PUBLIC_BUCKET: PUB, S3_PRIVATE_BUCKET: PRIV, AWS_EXPECTED_BUCKET_OWNER: undefined });
  storage = new S3StorageService(client, config);
  verifier = new ObjectVerifier(storage);
  metadata = new ImageMetadataStore(db);
  promoter = new ObjectPromoter(storage, verifier, metadata);
});

afterEach(() => {
  fake.mock.restore();
  vi.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function stage(kind: 'LOGO' | 'DISH' | 'STAFF', bytes: Buffer, contentType: string, opts: { staffId?: string; userId?: string; targetAssetId?: string } = {}) {
  const isStaff = kind === 'STAFF';
  const stagingKey = isStaff ? objectKeys.staffStaging() : objectKeys.publicStaging();
  fake.put(isStaff ? PRIV : PUB, stagingKey, bytes, contentType);
  return metadata.createIntent({
    kind,
    stagingKey,
    staffId: opts.staffId,
    targetAssetId: opts.targetAssetId,
    userId: opts.userId ?? (isStaff ? opts.staffId! : 'owner'),
    declaredType: contentType,
    declaredSize: bytes.length,
    ttlMs: 300_000,
  });
}

describe('ObjectVerifier', () => {
  const verify = (i: UploadIntent, format: 'png' | 'jpeg' | 'webp') => verifier.verify(i.bucket, i.stagingKey, format);

  it.each([
    ['png', validPng(), 'image/png'],
    ['jpeg', validJpeg(), 'image/jpeg'],
    ['webp', validWebp(), 'image/webp'],
  ] as const)('accepts a valid %s', async (format, bytes, ct) => {
    const i = stage('LOGO', bytes, ct);
    await expect(verify(i, format)).resolves.toMatchObject({ ok: true, format, contentType: ct, size: bytes.length });
  });

  it.each([
    ['T16 larger than 5 MB', Buffer.concat([validPng(), Buffer.alloc(MAX_IMAGE_BYTES)]), 'image/png', 'png', 'TOO_LARGE'],
    ['empty object', Buffer.alloc(0), 'image/png', 'png', 'EMPTY'],
    ['tiny object', validPng().subarray(0, 20), 'image/png', 'png', 'TRUNCATED_OR_CORRUPT'],
    ['T18 text renamed to .png', textFile(), 'image/png', 'png', 'UNRECOGNISED_SIGNATURE'],
    ['T18 HTML uploaded as JPEG', htmlFile(), 'image/jpeg', 'jpeg', 'UNRECOGNISED_SIGNATURE'],
    ['T18 truncated PNG', truncate(validPng(), 50), 'image/png', 'png', 'TRUNCATED_OR_CORRUPT'],
    ['PNG declared as JPEG', validPng(), 'image/jpeg', 'jpeg', 'TYPE_MISMATCH'],
    ['stored Content-Type differs from format', validPng(), 'image/webp', 'png', 'TYPE_MISMATCH'],
  ] as const)('rejects %s', async (_, bytes, ct, format, reason) => {
    const i = stage('DISH', bytes, ct);
    await expect(verify(i, format)).resolves.toEqual({ ok: false, reason });
  });

  it('treats a missing object as MISSING whether S3 says 403 or 404', async () => {
    const i = stage('LOGO', validPng(), 'image/png');
    fake.buckets.get(PUB)!.delete(i.stagingKey);
    await expect(verify(i, 'png')).resolves.toEqual({ ok: false, reason: 'MISSING' });
    fake.missingKeysAre403 = false;
    await expect(verify(i, 'png')).resolves.toEqual({ ok: false, reason: 'MISSING' });
  });

  it('detects the object changing between HEAD and the byte reads', async () => {
    const i = stage('LOGO', validPng(), 'image/png');
    fake.mock.on((await import('@aws-sdk/client-s3')).HeadObjectCommand).resolvesOnce({ ContentLength: validPng().length, ContentType: 'image/png', ETag: '"stale"' });
    await expect(verify(i, 'png')).resolves.toEqual({ ok: false, reason: 'CHANGED_DURING_VERIFICATION' });
  });

  it('rethrows infrastructure errors instead of rejecting the upload', async () => {
    const i = stage('LOGO', validPng(), 'image/png');
    fake.failNext.HeadObject = s3Error('SlowDown', 503);
    await expect(verify(i, 'png')).rejects.toBeInstanceOf(StorageError);
  });

  it('refuses to verify a non-staging key', async () => {
    await expect(verifier.verify('PUBLIC', objectKeys.dish('png'), 'png')).rejects.toThrow(/rejected/);
  });
});

describe('ObjectPromoter.completeUpload', () => {
  it('promotes a valid logo: final object exists, staging removed, metadata active', async () => {
    const i = stage('LOGO', validPng(), 'image/png');
    const res = await promoter.completeUpload(i.uploadId, 'owner');
    expect(res.ok).toBe(true);
    const logo = metadata.getLogo()!;
    expect(logo.objectKey).toMatch(/^logo\/[0-9a-f-]{36}\.png$/);
    expect(fake.get(PUB, logo.objectKey)?.contentType).toBe('image/png');
    expect(fake.get(PUB, i.stagingKey)).toBeUndefined();
    expect(metadata.getIntent(i.uploadId)?.status).toBe('COMPLETED');
    expect(metadata.dueDeletions()).toEqual([]);
  });

  it('T23: an invalid upload is rejected, its staging object deleted, and the old image stays active', async () => {
    await promoter.completeUpload(stage('LOGO', validPng(), 'image/png').uploadId, 'owner');
    const before = metadata.getLogo()!;

    const bad = stage('LOGO', textFile(), 'image/png');
    await expect(promoter.completeUpload(bad.uploadId, 'owner')).resolves.toEqual({ ok: false, reason: 'UNRECOGNISED_SIGNATURE' });
    expect(metadata.getLogo()).toEqual(before);
    expect(fake.get(PUB, before.objectKey)).toBeDefined();
    expect(fake.get(PUB, bad.stagingKey)).toBeUndefined();
    expect(fake.keys(PUB).filter((k) => k.startsWith('logo/'))).toEqual([before.objectKey]);
    expect(metadata.getIntent(bad.uploadId)?.status).toBe('REJECTED');
    await expect(promoter.completeUpload(bad.uploadId, 'owner')).rejects.toMatchObject({ code: 'INTENT_NOT_PENDING' });
  });

  it('replaces a staff picture: new one verified and active BEFORE the old one is deleted', async () => {
    await promoter.completeUpload(stage('STAFF', validJpeg(), 'image/jpeg', { staffId: 'staff-001' }).uploadId, 'staff-001');
    const old = metadata.getStaffPicture('staff-001')!;

    const order: string[] = [];
    const del = storage.deleteObject.bind(storage);
    vi.spyOn(storage, 'deleteObject').mockImplementation(async (b, k) => {
      order.push(`delete ${k} (active=${metadata.getStaffPicture('staff-001')!.objectKey})`);
      return del(b, k);
    });

    const next = stage('STAFF', validWebp(), 'image/webp', { staffId: 'staff-001' });
    const res = await promoter.completeUpload(next.uploadId, 'staff-001');
    expect(res).toMatchObject({ ok: true, replacedKey: old.objectKey });
    const current = metadata.getStaffPicture('staff-001')!;
    expect(current.objectKey).toMatch(/^staff\/staff-001\/.+\.webp$/);
    expect(order.find((o) => o.startsWith(`delete ${old.objectKey}`))).toBe(`delete ${old.objectKey} (active=${current.objectKey})`);
    expect(fake.get(PRIV, old.objectKey)).toBeUndefined();
    expect(fake.keys(PUB)).toEqual([]); // nothing ever written to the public bucket
  });

  it('only the user who started the upload can complete it (T10 groundwork)', async () => {
    const i = stage('STAFF', validPng(), 'image/png', { staffId: 'staff-001' });
    await expect(promoter.completeUpload(i.uploadId, 'staff-002')).rejects.toMatchObject({ code: 'INTENT_WRONG_USER' });
    expect(fake.get(PRIV, i.stagingKey)).toBeDefined();
    expect(metadata.getStaffPicture('staff-001')).toBeUndefined();
  });

  it('does not publish a staging object that was overwritten after verification', async () => {
    const i = stage('DISH', validPng(), 'image/png');
    const verify = verifier.verify.bind(verifier);
    vi.spyOn(verifier, 'verify').mockImplementation(async (...args) => {
      const verdict = await verify(...args);
      fake.put(PUB, i.stagingKey, textFile(), 'image/png'); // attacker re-uploads with the same presigned POST
      return verdict;
    });
    await expect(promoter.completeUpload(i.uploadId, 'owner')).resolves.toEqual({ ok: false, reason: 'CHANGED_DURING_VERIFICATION' });
    expect(metadata.listDishes()).toEqual([]);
    expect(fake.keys(PUB).filter((k) => k.startsWith('dishes/'))).toEqual([]);
  });

  it('keeps the intent pending on S3 outages so the client can retry', async () => {
    const i = stage('LOGO', validPng(), 'image/png');
    fake.failNext.CopyObject = s3Error('ServiceUnavailable', 503);
    await expect(promoter.completeUpload(i.uploadId, 'owner')).rejects.toBeInstanceOf(StorageError);
    expect(metadata.getIntent(i.uploadId)?.status).toBe('PENDING');
    expect(metadata.getLogo()).toBeUndefined();
    await expect(promoter.completeUpload(i.uploadId, 'owner')).resolves.toMatchObject({ ok: true });
  });

  it('removes the orphaned copy if activation fails (e.g. dish to replace was deleted meanwhile)', async () => {
    const created = await promoter.completeUpload(stage('DISH', validPng(), 'image/png').uploadId, 'owner');
    if (!created.ok) throw new Error('setup failed');
    const replace = stage('DISH', validJpeg(), 'image/jpeg', { targetAssetId: created.asset.assetId });
    await promoter.removeAsset(created.asset.assetId);

    await expect(promoter.completeUpload(replace.uploadId, 'owner')).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    expect(fake.keys(PUB).filter((k) => k.startsWith('dishes/'))).toEqual([]);
  });

  it('queues failed deletions and retries them later', async () => {
    const first = await promoter.completeUpload(stage('LOGO', validPng(), 'image/png').uploadId, 'owner');
    if (!first.ok) throw new Error('setup failed');
    fake.failNext.DeleteObject = s3Error('InternalError', 500); // staging cleanup fails
    const i = stage('LOGO', validJpeg(), 'image/jpeg');
    await expect(promoter.completeUpload(i.uploadId, 'owner')).resolves.toMatchObject({ ok: true });
    expect(fake.get(PUB, i.stagingKey)).toBeDefined();

    expect(await promoter.retryPendingDeletions()).toBe(0); // still backing off
    db.prepare('UPDATE pending_deletions SET next_attempt_at = 0').run();
    expect(await promoter.retryPendingDeletions()).toBe(1);
    expect(fake.get(PUB, i.stagingKey)).toBeUndefined();
    expect(fake.get(PUB, first.asset.objectKey)).toBeUndefined();
  });

  it('never deletes an object that an active asset points at', async () => {
    const res = await promoter.completeUpload(stage('LOGO', validPng(), 'image/png').uploadId, 'owner');
    if (!res.ok) throw new Error('setup failed');
    metadata.enqueueDeletion('PUBLIC', res.asset.objectKey, 'bogus');
    db.prepare('UPDATE pending_deletions SET next_attempt_at = 0').run();
    await promoter.retryPendingDeletions();
    expect(fake.get(PUB, res.asset.objectKey)).toBeDefined();
    expect(metadata.dueDeletions()).toEqual([]);
  });
});
