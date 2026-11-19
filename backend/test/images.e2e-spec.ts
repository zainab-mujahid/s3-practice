/**
 * Step 4 — public restaurant images through the real app (guards, sessions,
 * CSRF, SQLite). S3 is an in-memory fake on the app's own S3Client: the
 * "browser upload to S3" is simulated by writing the object into the fake at
 * the presigned key. No AWS calls are possible.
 */
import type { S3Client } from '@aws-sdk/client-s3';
import type { FakeS3 as FakeS3Type } from './fixtures/fake-s3.js';
import { s3Error } from './fixtures/fake-s3.js';
import { textFile, validJpeg, validPng, validWebp } from './fixtures/images.js';
import { Client, createTestApp, loggedIn, type TestApp } from './support.js';

const PUB = 'acme-public-images';
const PRIV = 'acme-private-images';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Body = Record<string, any>;

let t: TestApp;
let fake: FakeS3Type;
let owner: Client;
// Loaded after createTestApp so the classes match the app's module instances.
let mods: {
  ImageMetadataStore: typeof import('../src/storage/image-metadata.store.js').ImageMetadataStore;
  ObjectPromoter: typeof import('../src/storage/object-promoter.js').ObjectPromoter;
  UploadMaintenance: typeof import('../src/images/upload-maintenance.js').UploadMaintenance;
};

beforeAll(async () => {
  t = await createTestApp({ S3_PUBLIC_BUCKET: PUB, S3_PRIVATE_BUCKET: PRIV });
  const { S3_CLIENT } = await import('../src/storage/s3-client.provider.js');
  const { FakeS3 } = await import('./fixtures/fake-s3.js');
  fake = new FakeS3(t.app.get<S3Client>(S3_CLIENT));
  mods = {
    ImageMetadataStore: (await import('../src/storage/image-metadata.store.js')).ImageMetadataStore,
    ObjectPromoter: (await import('../src/storage/object-promoter.js')).ObjectPromoter,
    UploadMaintenance: (await import('../src/images/upload-maintenance.js')).UploadMaintenance,
  };
});

beforeEach(async () => {
  // Fresh client (= fresh client IP) per test, so the per-IP upload throttle does not bleed between tests.
  owner = await loggedIn(t, 'owner');
  t.db.exec('DELETE FROM upload_intents; DELETE FROM image_assets; DELETE FROM pending_deletions;');
  fake.buckets.clear();
  fake.failNext = {};
  fake.mock.resetHistory();
});

afterAll(async () => {
  const logText = t.logs.join('\n');
  // Never log presigned fields, credentials, AWS error text or account IDs.
  expect(logText).not.toMatch(/Policy|X-Amz-Signature|X-Amz-Credential|TEST-NOT-A-REAL|arn:aws|123456789012/);
  fake.mock.restore();
  await t.close();
});

const metadata = () => t.app.get(mods.ImageMetadataStore);
const decodePolicy = (fields: Record<string, string>) =>
  JSON.parse(Buffer.from(fields.Policy, 'base64').toString('utf8')) as { expiration: string; conditions: unknown[] };

function authorize(c: Client, body: Body) {
  return c.post('/admin/images/uploads', body);
}

/** Authorize + "browser upload" + complete. Returns the completion response. */
async function publish(kind: 'LOGO' | 'DISH', bytes: Buffer, opts: { type?: string; name?: string; targetAssetId?: string; uploadAs?: string } = {}) {
  const type = opts.type ?? 'image/png';
  const auth = await authorize(owner, {
    kind,
    fileName: opts.name ?? 'photo.png',
    contentType: type,
    size: bytes.length,
    ...(opts.targetAssetId ? { targetAssetId: opts.targetAssetId } : {}),
  }).expect(201);
  fake.put(PUB, auth.body.upload.fields.key, bytes, opts.uploadAs ?? auth.body.upload.fields['Content-Type']);
  return { auth: auth.body, res: await owner.post(`/admin/images/uploads/${auth.body.uploadId}/complete`) };
}

const finalKeys = () => fake.keys(PUB).filter((k) => !k.startsWith('staging/'));

describe('RBAC and CSRF', () => {
  const body = { kind: 'LOGO', fileName: 'logo.png', contentType: 'image/png', size: 100 };
  const someId = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('anonymous visitors can list published images without logging in', async () => {
    const res = await new Client(t.http).get('/public/images').expect(200);
    expect(res.body).toEqual({ logo: null, dishes: [] });
  });

  it('anonymous visitors get 401 on every management endpoint', async () => {
    const c = new Client(t.http);
    await c.fetchCsrf();
    await authorize(c, body).expect(401);
    await c.post(`/admin/images/uploads/${someId}/complete`).expect(401);
    await c.delete(`/admin/images/${someId}`).expect(401);
    expect(fake.mock.calls()).toHaveLength(0);
  });

  it.each(['staff-001', 'staff-002'] as const)('%s gets 403 on every management endpoint, before validation', async (u) => {
    const c = await loggedIn(t, u);
    await authorize(c, body).expect(403);
    await authorize(c, { evil: true }).expect(403);
    await c.post(`/admin/images/uploads/${someId}/complete`).expect(403);
    await c.delete(`/admin/images/${someId}`).expect(403);
    expect(fake.mock.calls()).toHaveLength(0);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM upload_intents').get()).toEqual({ n: 0 });
  });

  it('owner without a CSRF token gets 403', async () => {
    const c = await loggedIn(t, 'owner');
    c.csrfToken = 'wrong';
    await authorize(c, body).expect(403);
    await c.delete(`/admin/images/${someId}`).expect(403);
  });
});

describe('upload authorization (presigned POST)', () => {
  it('returns a POST bound to one server-generated staging key, exact type, 32 B..5 MiB, <= 300 s', async () => {
    const before = Date.now();
    const res = await authorize(owner, { kind: 'DISH', fileName: 'Pasta Night.JPG', contentType: 'image/jpeg', size: 2048 }).expect(201);
    expect(Object.keys(res.body).sort()).toEqual(['completeBy', 'expiresAt', 'upload', 'uploadId']);
    expect(res.body.uploadId).toMatch(UUID_RE);
    const { url, fields } = res.body.upload;
    expect(url).toContain(PUB);
    expect(fields.key).toMatch(/^staging\/[0-9a-f-]{36}$/);
    expect(fields.key).not.toContain('Pasta');
    expect(fields['Content-Type']).toBe('image/jpeg');

    const policy = decodePolicy(fields);
    expect(policy.conditions).toEqual(
      expect.arrayContaining([{ bucket: PUB }, { key: fields.key }, { 'Content-Type': 'image/jpeg' }, ['content-length-range', 32, 5 * 1024 * 1024]]),
    );
    expect(Date.parse(policy.expiration) - before).toBeLessThanOrEqual(301_000);
    expect(Date.parse(res.body.expiresAt) - before).toBeLessThanOrEqual(301_000);
    // Signing is local: no S3 request was made.
    expect(fake.mock.calls()).toHaveLength(0);

    const intent = metadata().getIntent(res.body.uploadId)!;
    expect(intent).toMatchObject({ kind: 'DISH', userId: 'owner', status: 'PENDING', stagingKey: fields.key, declaredType: 'image/jpeg' });
  });

  it.each([
    ['client-chosen key', { key: 'dishes/evil.png' }],
    ['client-chosen bucket', { bucket: 'PRIVATE' }],
    ['staff kind', { kind: 'STAFF' }],
    ['31 bytes', { size: 31 }],
    ['over 5 MiB', { size: 5 * 1024 * 1024 + 1 }],
    ['fractional size', { size: 100.5 }],
    ['SVG', { contentType: 'image/svg+xml', fileName: 'x.svg' }],
    ['GIF', { contentType: 'image/gif', fileName: 'x.gif' }],
    ['type/extension mismatch', { contentType: 'image/png', fileName: 'x.jpg' }],
    ['double extension', { fileName: 'x.png.exe' }],
    ['targetAssetId on LOGO', { kind: 'LOGO', targetAssetId: '0f8fad5b-d9cb-469f-a165-70867728950e' }],
    ['malformed targetAssetId', { targetAssetId: '../../logo' }],
  ])('rejects %s with 400 and creates no intent', async (_, override) => {
    await authorize(owner, { kind: 'DISH', fileName: 'x.png', contentType: 'image/png', size: 100, ...override }).expect(400);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM upload_intents').get()).toEqual({ n: 0 });
  });

  it('rejects replacing a dish that does not exist (404)', async () => {
    await authorize(owner, { kind: 'DISH', targetAssetId: '0f8fad5b-d9cb-469f-a165-70867728950e', fileName: 'x.png', contentType: 'image/png', size: 100 }).expect(404);
  });

  it('throttles upload authorization to 20 requests per minute per client', async () => {
    const b = { kind: 'DISH', fileName: 'x.png', contentType: 'image/png', size: 100 };
    for (let i = 0; i < 20; i++) await authorize(owner, { ...b, size: 1 }).expect(400); // counted, but cheap
    await authorize(owner, b).expect(429);
  });

  it('limits unfinished uploads to 10 per owner', async () => {
    const b = { kind: 'DISH', fileName: 'x.png', contentType: 'image/png', size: 100 };
    for (let i = 0; i < 10; i++) await authorize(owner, b).expect(201);
    const res = await authorize(owner, b).expect(409);
    expect(res.body.message).toMatch(/Too many unfinished uploads/);
  });

  it('limits new dishes to 50 (replacing an existing dish still works)', async () => {
    const insert = t.db.prepare(
      `INSERT INTO image_assets (asset_id, kind, staff_id, bucket_alias, object_key, content_type, size_bytes, created_by, created_at, updated_at)
       VALUES (?, 'DISH', NULL, 'PUBLIC', ?, 'image/png', 100, 'owner', 1, 1)`,
    );
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      insert.run(id, `dishes/${crypto.randomUUID()}.png`);
    }
    const b = { kind: 'DISH', fileName: 'x.png', contentType: 'image/png', size: 100 };
    await authorize(owner, b).expect(409);
    await authorize(owner, { ...b, targetAssetId: ids[0] }).expect(201);
  });
});

describe('upload completion', () => {
  it('publishes a verified logo: public URL, no internal keys, staging removed', async () => {
    const { res } = await publish('LOGO', validPng(), { name: 'logo.png' });
    expect(res.status).toBe(200);
    expect(res.body.replaced).toBe(false);
    expect(Object.keys(res.body.image).sort()).toEqual(['assetId', 'contentType', 'kind', 'sizeBytes', 'updatedAt', 'url']);
    expect(res.body.image.url).toMatch(new RegExp(`^https://${PUB}\\.s3\\.us-east-1\\.amazonaws\\.com/logo/[0-9a-f-]{36}\\.png$`));
    expect(JSON.stringify(res.body)).not.toContain('staging');

    expect(fake.keys(PUB).filter((k) => k.startsWith('staging/'))).toEqual([]);
    expect(finalKeys()).toHaveLength(1);
    const pub = await new Client(t.http).get('/public/images').expect(200);
    expect(pub.body.logo).toEqual(res.body.image);
    await new Client(t.http).get(`/public/images/${res.body.image.assetId}`).expect(200);
  });

  it.each([
    ['jpeg', validJpeg(), 'image/jpeg', 'a.jpeg', /\.jpg$/],
    ['webp', validWebp(), 'image/webp', 'a.webp', /\.webp$/],
  ] as const)('publishes a %s dish', async (_, bytes, type, name, ext) => {
    const { res } = await publish('DISH', bytes, { type, name });
    expect(res.status).toBe(200);
    expect(res.body.image.url).toMatch(ext);
    expect(res.body.image.kind).toBe('DISH');
  });

  it('rejects a file whose bytes are not an image (422) and never publishes it', async () => {
    const { auth, res } = await publish('DISH', textFile());
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('UNRECOGNISED_SIGNATURE');
    expect(fake.keys(PUB)).toEqual([]); // staging deleted, nothing promoted
    expect(metadata().getIntent(auth.uploadId)?.status).toBe('REJECTED');
    expect((await new Client(t.http).get('/public/images')).body.dishes).toEqual([]);
  });

  it('rejects a real JPEG uploaded under a PNG intent (signature/type mismatch)', async () => {
    const { res } = await publish('DISH', validJpeg(), { type: 'image/png', name: 'x.png' });
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('TYPE_MISMATCH');
  });

  it('rejects a stored Content-Type that differs from the intent', async () => {
    const { res } = await publish('DISH', validPng(), { uploadAs: 'text/html' });
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('TYPE_MISMATCH');
  });

  it('handles a missing staging object (upload never happened) with 422 MISSING', async () => {
    const auth = await authorize(owner, { kind: 'DISH', fileName: 'x.png', contentType: 'image/png', size: 100 }).expect(201);
    const res = await owner.post(`/admin/images/uploads/${auth.body.uploadId}/complete`).expect(422);
    expect(res.body.reason).toBe('MISSING');
    await owner.post(`/admin/images/uploads/${auth.body.uploadId}/complete`).expect(409);
  });

  it('a duplicate completion is a 409 and creates nothing new', async () => {
    const { auth, res } = await publish('DISH', validPng());
    expect(res.status).toBe(200);
    await owner.post(`/admin/images/uploads/${auth.uploadId}/complete`).expect(409);
    expect(metadata().listDishes()).toHaveLength(1);
    expect(finalKeys()).toHaveLength(1);
  });

  it('two simultaneous completions: exactly one publishes, the other gets 409', async () => {
    const auth = await authorize(owner, { kind: 'DISH', fileName: 'x.png', contentType: 'image/png', size: 100 }).expect(201);
    fake.put(PUB, auth.body.upload.fields.key, validPng(), 'image/png');
    const path = `/admin/images/uploads/${auth.body.uploadId}/complete`;
    const [a, b] = await Promise.all([owner.post(path), owner.post(path)]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    expect(metadata().listDishes()).toHaveLength(1);
    expect(finalKeys()).toHaveLength(1);
  });

  it('SQLite alone prevents double publication (no in-process lock): the loser\'s copy is removed', async () => {
    const auth = await authorize(owner, { kind: 'DISH', fileName: 'x.png', contentType: 'image/png', size: 100 }).expect(201);
    fake.put(PUB, auth.body.upload.fields.key, validPng(), 'image/png');
    const promoter = t.app.get(mods.ObjectPromoter);
    const results = await Promise.allSettled([promoter.completeUpload(auth.body.uploadId, 'owner'), promoter.completeUpload(auth.body.uploadId, 'owner')]);
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value.ok);
    expect(ok).toHaveLength(1);
    expect(metadata().listDishes()).toHaveLength(1);
    expect(finalKeys()).toEqual([metadata().listDishes()[0].objectKey]);
  });

  it("another user's upload looks exactly like a missing one (404)", async () => {
    const intent = metadata().createIntent({
      kind: 'DISH', stagingKey: `staging/${crypto.randomUUID()}`, userId: 'someone-else', declaredType: 'image/png', declaredSize: 100, ttlMs: 60_000,
    });
    const a = await owner.post(`/admin/images/uploads/${intent.uploadId}/complete`).expect(404);
    const b = await owner.post(`/admin/images/uploads/${crypto.randomUUID()}/complete`).expect(404);
    expect(a.body.message).toBe(b.body.message);
    expect(metadata().getIntent(intent.uploadId)?.status).toBe('PENDING');
  });

  it('a staff-picture intent cannot be completed through the public-image endpoint', async () => {
    const intent = metadata().createIntent({
      kind: 'STAFF', staffId: 'staff-001', stagingKey: `staging/staff/${crypto.randomUUID()}`, userId: 'owner', declaredType: 'image/png', declaredSize: 100, ttlMs: 60_000,
    });
    await owner.post(`/admin/images/uploads/${intent.uploadId}/complete`).expect(404);
  });

  it('an expired intent is refused with 410', async () => {
    const auth = await authorize(owner, { kind: 'DISH', fileName: 'x.png', contentType: 'image/png', size: 100 }).expect(201);
    fake.put(PUB, auth.body.upload.fields.key, validPng(), 'image/png');
    t.db.prepare('UPDATE upload_intents SET expires_at = ? WHERE upload_id = ?').run(Date.now() - 1, auth.body.uploadId);
    await owner.post(`/admin/images/uploads/${auth.body.uploadId}/complete`).expect(410);
    expect(finalKeys()).toEqual([]);
  });

  it.each(['abc', '..%2F..%2Fx', '0f8fad5b-d9cb-469f-a165-70867728950'])('rejects malformed upload id %s with 400', async (id) => {
    await owner.post(`/admin/images/uploads/${id}/complete`).expect(400);
  });

  it('S3 outage during copy: 503, nothing published, intent still completable on retry', async () => {
    const auth = await authorize(owner, { kind: 'DISH', fileName: 'x.png', contentType: 'image/png', size: 100 }).expect(201);
    fake.put(PUB, auth.body.upload.fields.key, validPng(), 'image/png');
    fake.failNext.CopyObject = s3Error('InternalError', 500);
    const path = `/admin/images/uploads/${auth.body.uploadId}/complete`;
    const res = await owner.post(path).expect(503);
    expect(JSON.stringify(res.body)).not.toMatch(/arn:|InternalError|acme/);
    expect(metadata().listDishes()).toEqual([]);
    await owner.post(path).expect(200);
  });
});

describe('replacement and deletion', () => {
  it('replacing the logo publishes the new one, then deletes the old object', async () => {
    const first = (await publish('LOGO', validPng())).res.body.image;
    const oldKey = metadata().getLogo()!.objectKey;
    const { res } = await publish('LOGO', validWebp(), { type: 'image/webp', name: 'new.webp' });
    expect(res.status).toBe(200);
    expect(res.body.replaced).toBe(true);
    expect(res.body.image.assetId).toBe(first.assetId);
    expect(res.body.image.url).not.toBe(first.url);
    expect(fake.get(PUB, oldKey)).toBeUndefined();
    expect(finalKeys()).toEqual([metadata().getLogo()!.objectKey]);
  });

  it('a failed replacement (invalid file) keeps the published logo untouched', async () => {
    const first = (await publish('LOGO', validPng())).res.body.image;
    const key = metadata().getLogo()!.objectKey;
    const { res } = await publish('LOGO', textFile());
    expect(res.status).toBe(422);
    expect((await new Client(t.http).get('/public/images')).body.logo).toEqual(first);
    expect(fake.get(PUB, key)).toBeDefined();
  });

  it('a failed replacement (S3 copy error) keeps the published dish untouched', async () => {
    const dish = (await publish('DISH', validPng())).res.body.image;
    const key = metadata().getAsset(dish.assetId)!.objectKey;
    const auth = await authorize(owner, { kind: 'DISH', targetAssetId: dish.assetId, fileName: 'x.png', contentType: 'image/png', size: 100 }).expect(201);
    fake.put(PUB, auth.body.upload.fields.key, validPng(), 'image/png');
    fake.failNext.CopyObject = s3Error('SlowDown', 503);
    await owner.post(`/admin/images/uploads/${auth.body.uploadId}/complete`).expect(503);
    expect(metadata().getAsset(dish.assetId)?.objectKey).toBe(key);
    expect(fake.get(PUB, key)).toBeDefined();
  });

  it('replacing a dish keeps its id; other dishes are unaffected', async () => {
    const a = (await publish('DISH', validPng())).res.body.image;
    const b = (await publish('DISH', validPng())).res.body.image;
    const { res } = await publish('DISH', validJpeg(), { type: 'image/jpeg', name: 'x.jpg', targetAssetId: a.assetId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replaced: true, image: { assetId: a.assetId, contentType: 'image/jpeg' } });
    const dishes = (await new Client(t.http).get('/public/images')).body.dishes;
    expect(dishes.map((d: Body) => d.assetId).sort((x: string, y: string) => x.localeCompare(y))).toEqual([a.assetId, b.assetId].sort((x: string, y: string) => x.localeCompare(y)));
    expect(finalKeys()).toHaveLength(2);
  });

  it('dish deleted while its replacement was in flight: 404, nothing orphaned, intent rejected', async () => {
    const dish = (await publish('DISH', validPng())).res.body.image;
    const auth = await authorize(owner, { kind: 'DISH', targetAssetId: dish.assetId, fileName: 'x.png', contentType: 'image/png', size: 100 }).expect(201);
    fake.put(PUB, auth.body.upload.fields.key, validPng(), 'image/png');
    await owner.delete(`/admin/images/${dish.assetId}`).expect(204);
    const res = await owner.post(`/admin/images/uploads/${auth.body.uploadId}/complete`).expect(404);
    expect(res.body.message).toMatch(/no longer exists/);
    expect(fake.keys(PUB)).toEqual([]);
    expect(metadata().getIntent(auth.body.uploadId)?.status).toBe('REJECTED');
    expect(metadata().listDishes()).toEqual([]);
  });

  it('owner deletes a dish and the logo; objects are removed', async () => {
    const dish = (await publish('DISH', validPng())).res.body.image;
    const logo = (await publish('LOGO', validPng())).res.body.image;
    await owner.delete(`/admin/images/${dish.assetId}`).expect(204);
    await owner.delete(`/admin/images/${logo.assetId}`).expect(204);
    await owner.delete(`/admin/images/${logo.assetId}`).expect(404);
    expect(fake.keys(PUB)).toEqual([]);
    expect((await new Client(t.http).get('/public/images')).body).toEqual({ logo: null, dishes: [] });
    await new Client(t.http).get(`/public/images/${dish.assetId}`).expect(404);
  });

  it('a staff picture cannot be read or deleted through the public-image endpoints', async () => {
    const id = crypto.randomUUID();
    t.db
      .prepare(
        `INSERT INTO image_assets (asset_id, kind, staff_id, bucket_alias, object_key, content_type, size_bytes, created_by, created_at, updated_at)
         VALUES (?, 'STAFF', 'staff-001', 'PRIVATE', ?, 'image/png', 100, 'staff-001', 1, 1)`,
      )
      .run(id, `staff/staff-001/${crypto.randomUUID()}.png`);
    await new Client(t.http).get(`/public/images/${id}`).expect(404);
    await owner.delete(`/admin/images/${id}`).expect(404);
    expect(metadata().getAsset(id)).toBeDefined();
    expect(fake.mock.calls()).toHaveLength(0);
  });

  it('S3 delete failure: the image is unpublished, the object is queued and retried by maintenance', async () => {
    const dish = (await publish('DISH', validPng())).res.body.image;
    const key = metadata().getAsset(dish.assetId)!.objectKey;
    fake.failNext.DeleteObject = s3Error('InternalError', 500);
    await owner.delete(`/admin/images/${dish.assetId}`).expect(204);
    expect(metadata().listDishes()).toEqual([]);
    expect(fake.get(PUB, key)).toBeDefined();
    expect(t.db.prepare('SELECT object_key FROM pending_deletions').all()).toEqual([{ object_key: key }]);

    t.db.prepare('UPDATE pending_deletions SET next_attempt_at = 0').run();
    const report = await t.app.get(mods.UploadMaintenance).runOnce();
    expect(report).toMatchObject({ deleted: 1 });
    expect(fake.get(PUB, key)).toBeUndefined();
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM pending_deletions').get()).toEqual({ n: 0 });
  });
});

describe('upload maintenance', () => {
  it('expires abandoned uploads and deletes only their staging objects; published images survive; idempotent', async () => {
    const logo = (await publish('LOGO', validPng())).res.body.image;
    const logoKey = metadata().getLogo()!.objectKey;
    const auth = await authorize(owner, { kind: 'DISH', fileName: 'x.png', contentType: 'image/png', size: 100 }).expect(201);
    const stagingKey = auth.body.upload.fields.key;
    fake.put(PUB, stagingKey, validPng(), 'image/png');
    t.db.prepare('UPDATE upload_intents SET expires_at = ? WHERE upload_id = ?').run(Date.now() - 1, auth.body.uploadId);

    const m = t.app.get(mods.UploadMaintenance);
    expect(await m.runOnce()).toMatchObject({ expired: 1, deleted: 1 });
    expect(await m.runOnce()).toMatchObject({ expired: 0, deleted: 0 });
    expect(fake.get(PUB, stagingKey)).toBeUndefined();
    expect(fake.get(PUB, logoKey)).toBeDefined();
    expect((await new Client(t.http).get('/public/images')).body.logo).toEqual(logo);
    expect(metadata().getIntent(auth.body.uploadId)?.status).toBe('EXPIRED');
  });

  it('never deletes an object that an active asset uses, even if it was queued', async () => {
    await publish('LOGO', validPng());
    const key = metadata().getLogo()!.objectKey;
    metadata().enqueueDeletion('PUBLIC', key, 'bogus');
    await t.app.get(mods.UploadMaintenance).runOnce();
    expect(fake.get(PUB, key)).toBeDefined();
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM pending_deletions').get()).toEqual({ n: 0 });
  });
});

describe('storage not configured', () => {
  let t2: TestApp;
  beforeAll(async () => {
    t2 = await createTestApp({ S3_PUBLIC_BUCKET: 'replace-me-public', S3_PRIVATE_BUCKET: 'replace-me-private' });
  });
  afterAll(async () => {
    await t2.close();
  });

  it('management endpoints answer 503 without any AWS call; public listing still works', async () => {
    const c = await loggedIn(t2, 'owner');
    const res = await c.post('/admin/images/uploads', { kind: 'LOGO', fileName: 'x.png', contentType: 'image/png', size: 100 }).expect(503);
    expect(res.body.message).toBe('Image storage is not configured');
    await new Client(t2.http).get('/public/images').expect(200);
  });
});
