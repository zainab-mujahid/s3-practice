/**
 * Storage foundation (Step 3) through the real app: guards, sessions, config.
 * S3 is mocked on the app's own S3Client instance — no AWS calls are possible
 * (the test client also points at an unroutable endpoint with fake keys).
 */
import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { s3Error } from './fixtures/fake-s3.js';
import { Client, createTestApp, loggedIn, type TestApp } from './support.js';

const PATH = '/admin/storage/health';

async function s3MockFor(t: TestApp) {
  // Imported after createTestApp so the symbol matches the app's module instance.
  const { S3_CLIENT } = await import('../src/storage/s3-client.provider.js');
  return mockClient(t.app.get<S3Client>(S3_CLIENT));
}

describe('storage health endpoint', () => {
  let t: TestApp;
  let s3: Awaited<ReturnType<typeof s3MockFor>>;

  beforeAll(async () => {
    t = await createTestApp({ S3_PUBLIC_BUCKET: 'acme-public-images', S3_PRIVATE_BUCKET: 'acme-private-images' });
    s3 = await s3MockFor(t);
  });

  beforeEach(() => {
    s3.reset();
  });

  afterAll(async () => {
    const logText = t.logs.join('\n');
    expect(logText).not.toMatch(/arn:aws|123456789012|TEST-NOT-A-REAL/);
    s3.restore();
    await t.close();
  });

  it('migrated the database to the image-metadata schema (v2)', () => {
    expect((t.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    const tables = (t.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['image_assets', 'upload_intents', 'pending_deletions']));
  });

  it('anonymous visitors get 401 and trigger no S3 call', async () => {
    await new Client(t.http).get(PATH).expect(401);
    expect(s3.calls()).toHaveLength(0);
  });

  it.each(['staff-001', 'staff-002'] as const)('%s gets 403 and triggers no S3 call', async (user) => {
    const c = await loggedIn(t, user);
    await c.get(PATH).expect(403);
    expect(s3.calls()).toHaveLength(0);
  });

  it('owner: one read-only, prefix-scoped ListObjectsV2 per bucket; response reveals no bucket details', async () => {
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'dishes/x.jpg' }] });
    const res = await (await loggedIn(t, 'owner')).get(PATH).expect(200);

    expect(Object.keys(res.body).sort()).toEqual(['checkedAt', 'ok', 'privateBucket', 'publicBucket']);
    expect(res.body).toMatchObject({ ok: true, publicBucket: 'ok', privateBucket: 'ok' });
    expect(JSON.stringify(res.body)).not.toMatch(/acme-|us-east-1|dishes\/|arn:/);

    const inputs = s3.calls().map((c) => {
      expect(c.args[0]).toBeInstanceOf(ListObjectsV2Command);
      return (c.args[0] as ListObjectsV2Command).input;
    });
    expect(inputs).toEqual(
      expect.arrayContaining([
        { Bucket: 'acme-public-images', Prefix: 'dishes/', MaxKeys: 1 },
        { Bucket: 'acme-private-images', Prefix: 'staff/', MaxKeys: 1 },
      ]),
    );
    expect(inputs).toHaveLength(2);
  });

  it('owner: AWS errors become generic status words without ARNs or account IDs', async () => {
    s3.on(ListObjectsV2Command, { Bucket: 'acme-public-images' })
      .resolves({})
      .on(ListObjectsV2Command, { Bucket: 'acme-private-images' })
      .rejects(s3Error('AccessDenied', 403));
    const res = await (await loggedIn(t, 'owner')).get(PATH).expect(200);
    expect(res.body).toMatchObject({ ok: false, publicBucket: 'ok', privateBucket: 'denied' });
    expect(JSON.stringify(res.body)).not.toMatch(/arn:|123456789012|secret-bucket-name/);
  });

  it('owner: missing credentials are reported as such (no profile name or path leaked)', async () => {
    s3.on(ListObjectsV2Command).rejects(
      Object.assign(new Error('Could not load credentials from profile s3-practice in C:\\Users\\x\\.aws'), { name: 'CredentialsProviderError' }),
    );
    const res = await (await loggedIn(t, 'owner')).get(PATH).expect(200);
    expect(res.body).toMatchObject({ publicBucket: 'no_credentials', privateBucket: 'no_credentials' });
    expect(t.logs.join('\n')).not.toMatch(/s3-practice in|\.aws/);
  });

  it('is rate limited (10 per minute per client)', async () => {
    s3.on(ListObjectsV2Command).resolves({});
    const owner = await loggedIn(t, 'owner');
    for (let i = 0; i < 10; i++) await owner.get(PATH).expect(200);
    await owner.get(PATH).expect(429);
  });

  it('only GET exists (no write-style storage endpoints in Step 3)', async () => {
    const owner = await loggedIn(t, 'owner');
    expect((await owner.post(PATH)).status).toBe(404);
    expect(s3.calls()).toHaveLength(0);
  });
});

describe('storage health with placeholder bucket names', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ S3_PUBLIC_BUCKET: 'replace-me-public-bucket', S3_PRIVATE_BUCKET: 'replace-me-private-bucket' });
  });

  afterAll(async () => {
    await t.close();
  });

  it('reports not_configured and makes no AWS call at all', async () => {
    const s3 = await s3MockFor(t);
    const res = await (await loggedIn(t, 'owner')).get(PATH).expect(200);
    expect(res.body).toMatchObject({ ok: false, publicBucket: 'not_configured', privateBucket: 'not_configured' });
    expect(s3.calls()).toHaveLength(0);
    s3.restore();
    expect(t.logs.join('\n')).toMatch(/placeholders/);
  });
});
