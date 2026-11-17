import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';

// Deterministic, fake configuration for tests. Values already present in
// process.env take precedence over backend/.env, so the local .env is ignored.
const TEST_ENV = {
  NODE_ENV: 'test',
  BACKEND_PORT: '3999',
  FRONTEND_URL: 'http://localhost:5173',
  AWS_REGION: 'us-east-1',
  S3_PUBLIC_BUCKET: 'test-public-bucket',
  S3_PRIVATE_BUCKET: 'test-private-bucket',
};

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    Object.assign(process.env, TEST_ENV);
    const { AppModule } = await import('../src/app.module.js');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health returns 200 with status ok', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('does not leak bucket names or region in the health response', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(TEST_ENV.S3_PUBLIC_BUCKET);
    expect(text).not.toContain(TEST_ENV.S3_PRIVATE_BUCKET);
    expect(text).not.toContain(TEST_ENV.AWS_REGION);
  });

  it('unknown routes return 404', async () => {
    await request(app.getHttpServer()).get('/api/does-not-exist').expect(404);
  });
});
