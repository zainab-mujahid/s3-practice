import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../persistence/sqlite.js';
import { DELETION_BACKOFF_BASE_MS, ImageMetadataStore, INTENT_RETENTION_MS, MetadataError } from './image-metadata.store.js';
import { InvalidObjectKeyError, objectKeys } from './storage-locations.js';

let dir: string;
let db: DatabaseSync;
let clock: number;
let store: ImageMetadataStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's3p-meta-'));
  db = openDatabase(join(dir, 'app.db'));
  clock = 1_000_000;
  store = new ImageMetadataStore(db, () => clock);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const TTL = 300_000;
const logoIntent = (userId = 'owner') =>
  store.createIntent({ kind: 'LOGO', stagingKey: objectKeys.publicStaging(), userId, declaredType: 'image/png', declaredSize: 100, ttlMs: TTL });
const staffIntent = (staffId: string, userId = staffId) =>
  store.createIntent({ kind: 'STAFF', staffId, stagingKey: objectKeys.staffStaging(), userId, declaredType: 'image/jpeg', declaredSize: 100, ttlMs: TTL });
const dishIntent = (targetAssetId?: string) =>
  store.createIntent({ kind: 'DISH', targetAssetId, stagingKey: objectKeys.publicStaging(), userId: 'owner', declaredType: 'image/webp', declaredSize: 100, ttlMs: TTL });

const activate = (uploadId: string, finalKey: string, userId = 'owner') =>
  store.activateUpload({ uploadId, userId, finalKey, contentType: 'image/png', sizeBytes: 100 });

describe('ImageMetadataStore — schema', () => {
  it('migrates to v2 and survives reopening (persistent)', () => {
    const intent = logoIntent();
    activate(intent.uploadId, objectKeys.logo('png'));
    db.close();
    db = openDatabase(join(dir, 'app.db'));
    store = new ImageMetadataStore(db, () => clock);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    expect(store.getLogo()?.kind).toBe('LOGO');
  });

  it('enforces one logo and one picture per staff member at the SQL level', () => {
    const ins = db.prepare(
      `INSERT INTO image_assets VALUES (?, ?, ?, ?, ?, 'image/png', 1, 'owner', 0, 0)`,
    );
    ins.run('a1', 'LOGO', null, 'PUBLIC', objectKeys.logo('png'));
    expect(() => ins.run('a2', 'LOGO', null, 'PUBLIC', objectKeys.logo('png'))).toThrow(/UNIQUE/);
    ins.run('s1', 'STAFF', 'staff-001', 'PRIVATE', objectKeys.staffPicture('staff-001', 'png'));
    expect(() => ins.run('s2', 'STAFF', 'staff-001', 'PRIVATE', objectKeys.staffPicture('staff-001', 'png'))).toThrow(/UNIQUE/);
    // Staff pictures can never be recorded in the public bucket, and vice versa.
    expect(() => ins.run('s3', 'STAFF', 'staff-002', 'PUBLIC', 'x')).toThrow(/CHECK/);
    expect(() => ins.run('d1', 'DISH', null, 'PRIVATE', 'y')).toThrow(/CHECK/);
  });
});

describe('ImageMetadataStore — intents', () => {
  it('validates intent shape and staging key', () => {
    expect(() =>
      store.createIntent({ kind: 'STAFF', staffId: 'staff-001', stagingKey: objectKeys.publicStaging(), userId: 'owner', declaredType: 'image/png', declaredSize: 1, ttlMs: TTL }),
    ).toThrow(InvalidObjectKeyError);
    expect(() =>
      store.createIntent({ kind: 'STAFF', stagingKey: objectKeys.staffStaging(), userId: 'owner', declaredType: 'image/png', declaredSize: 1, ttlMs: TTL }),
    ).toThrow(MetadataError);
    expect(() =>
      store.createIntent({ kind: 'LOGO', targetAssetId: 'x', stagingKey: objectKeys.publicStaging(), userId: 'owner', declaredType: 'image/png', declaredSize: 1, ttlMs: TTL }),
    ).toThrow(MetadataError);
  });

  it('can be completed only by its creator, once, before expiry', () => {
    const intent = staffIntent('staff-001');
    expect(() => store.requirePendingIntent(intent.uploadId, 'staff-002')).toThrow(expect.objectContaining({ code: 'INTENT_WRONG_USER' }));
    expect(() => store.requirePendingIntent('nope', 'staff-001')).toThrow(expect.objectContaining({ code: 'INTENT_NOT_FOUND' }));
    activate(intent.uploadId, objectKeys.staffPicture('staff-001', 'jpeg'), 'staff-001');
    expect(() => activate(intent.uploadId, objectKeys.staffPicture('staff-001', 'jpeg'), 'staff-001')).toThrow(
      expect.objectContaining({ code: 'INTENT_NOT_PENDING' }),
    );

    const late = staffIntent('staff-001');
    clock += TTL;
    expect(() => activate(late.uploadId, objectKeys.staffPicture('staff-001', 'jpeg'), 'staff-001')).toThrow(
      expect.objectContaining({ code: 'INTENT_EXPIRED' }),
    );
  });

  it('expires stale intents and returns them for staging cleanup; prunes old finished ones', () => {
    const a = logoIntent();
    clock += TTL + 1;
    const expired = store.expireIntents();
    expect(expired.map((i) => i.uploadId)).toEqual([a.uploadId]);
    expect(store.getIntent(a.uploadId)?.status).toBe('EXPIRED');
    expect(store.expireIntents()).toEqual([]);
    clock += INTENT_RETENTION_MS + 1;
    expect(store.pruneFinishedIntents()).toBe(1);
  });

  it('rejected intents cannot be activated (T23)', () => {
    const intent = logoIntent();
    expect(store.rejectIntent(intent.uploadId, 'UNRECOGNISED_SIGNATURE')).toBe(true);
    expect(store.rejectIntent(intent.uploadId, 'again')).toBe(false);
    expect(() => activate(intent.uploadId, objectKeys.logo('png'))).toThrow(expect.objectContaining({ code: 'INTENT_NOT_PENDING' }));
    expect(store.getLogo()).toBeUndefined();
  });
});

describe('ImageMetadataStore — activation and replacement', () => {
  it('replaces the logo atomically and queues the old object for deletion', () => {
    const k1 = objectKeys.logo('png');
    const first = activate(logoIntent().uploadId, k1);
    expect(first.replacedKey).toBeNull();

    clock += 10;
    const k2 = objectKeys.logo('webp');
    const second = activate(logoIntent().uploadId, k2);
    expect(second.replacedKey).toBe(k1);
    expect(second.asset.assetId).toBe(first.asset.assetId);
    expect(store.getLogo()?.objectKey).toBe(k2);
    expect(store.dueDeletions()).toEqual([{ bucket: 'PUBLIC', objectKey: k1, reason: 'replaced', attempts: 0 }]);
  });

  it('keeps a dish ID stable across image replacements', () => {
    const created = activate(dishIntent().uploadId, objectKeys.dish('webp')).asset;
    const replaced = activate(dishIntent(created.assetId).uploadId, objectKeys.dish('jpeg'));
    expect(replaced.asset.assetId).toBe(created.assetId);
    expect(store.listDishes()).toHaveLength(1);
  });

  it('rejects replacing a dish that does not exist, leaving nothing changed', () => {
    const intent = dishIntent('11111111-1111-4111-8111-111111111111');
    expect(() => activate(intent.uploadId, objectKeys.dish('webp'))).toThrow(expect.objectContaining({ code: 'TARGET_NOT_FOUND' }));
    expect(store.getIntent(intent.uploadId)?.status).toBe('PENDING');
    expect(store.listDishes()).toEqual([]);
  });

  it('refuses a final key of the wrong area or another staff member (rolls back)', () => {
    const intent = staffIntent('staff-001');
    expect(() => activate(intent.uploadId, objectKeys.staffPicture('staff-002', 'png'), 'staff-001')).toThrow(MetadataError);
    expect(() => activate(intent.uploadId, objectKeys.dish('png'), 'staff-001')).toThrow(InvalidObjectKeyError);
    expect(store.getStaffPicture('staff-001')).toBeUndefined();
    expect(store.getIntent(intent.uploadId)?.status).toBe('PENDING');
  });

  it('removes an asset and queues its object in one step', () => {
    const { asset } = activate(dishIntent().uploadId, objectKeys.dish('png'));
    expect(store.removeAsset(asset.assetId)?.objectKey).toBe(asset.objectKey);
    expect(store.getAsset(asset.assetId)).toBeUndefined();
    expect(store.dueDeletions().map((d) => d.objectKey)).toEqual([asset.objectKey]);
    expect(store.removeAsset(asset.assetId)).toBeUndefined();
  });
});

describe('ImageMetadataStore — pending deletions', () => {
  it('backs off exponentially after failures and forgets after success', () => {
    const key = objectKeys.publicStaging();
    store.enqueueDeletion('PUBLIC', key, 'rejected');
    store.enqueueDeletion('PUBLIC', key, 'duplicate'); // idempotent
    expect(store.dueDeletions()).toHaveLength(1);

    store.deletionFailed('PUBLIC', key);
    expect(store.dueDeletions()).toEqual([]);
    clock += DELETION_BACKOFF_BASE_MS;
    expect(store.dueDeletions()[0].attempts).toBe(1);

    store.deletionFailed('PUBLIC', key);
    clock += DELETION_BACKOFF_BASE_MS;
    expect(store.dueDeletions()).toEqual([]);
    clock += DELETION_BACKOFF_BASE_MS;
    expect(store.dueDeletions()).toHaveLength(1);

    store.deletionSucceeded('PUBLIC', key);
    expect(store.dueDeletions()).toEqual([]);
  });

  it('only accepts allow-listed keys', () => {
    expect(() => store.enqueueDeletion('PUBLIC', '../x', 'r')).toThrow(InvalidObjectKeyError);
    expect(() => store.enqueueDeletion('PRIVATE', objectKeys.dish('png'), 'r')).toThrow(InvalidObjectKeyError);
  });
});
