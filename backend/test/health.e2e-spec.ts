import request from 'supertest';
import { createTestApp, type TestApp } from './support.js';

describe('Health (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('GET /api/health is public and returns 200 with status ok', async () => {
    const res = await request(t.http).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('does not leak bucket names, region or secrets in the health response', async () => {
    const res = await request(t.http).get('/api/health').expect(200);
    const text = JSON.stringify(res.body);
    for (const value of ['test-public-bucket', 'test-private-bucket', 'us-east-1', t.sessionSecret]) {
      expect(text).not.toContain(value);
    }
  });

  it('unknown routes return 404', async () => {
    await request(t.http).get('/api/does-not-exist').expect(404);
  });
});
