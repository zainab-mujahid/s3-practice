import request from 'supertest';
import { Client, createTestApp, loggedIn, sleep, type TestApp } from './support.js';

const sidCookie = (res: request.Response) =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('s3p.sid='))?.split(';')[0];

describe('idle timeout (3 s)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ SESSION_IDLE_TIMEOUT_SECONDS: '3', SESSION_ABSOLUTE_TIMEOUT_SECONDS: '60' });
  });
  afterAll(() => t.close());

  it('activity keeps the session alive (rolling)', async () => {
    const c = await loggedIn(t, 'staff-001');
    for (let i = 0; i < 3; i++) {
      await sleep(1500);
      await c.get('/auth/me').expect(200); // 4.5 s after login in total, but never 3 s idle
    }
  }, 15_000);

  it('the server rejects the session after 3 s of inactivity, even if the client still sends the cookie', async () => {
    const c = await loggedIn(t, 'staff-002');
    // Grab the raw cookie and replay it ourselves, bypassing the client's own
    // cookie expiry: this proves expiry is enforced server-side.
    const raw = sidCookie(await c.get('/auth/me').expect(200))!;
    await sleep(3300);
    await request(t.http).get('/api/auth/me').set('Cookie', raw).expect(401);
  }, 15_000);
});

describe('absolute timeout (5 s, idle 3 s)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ SESSION_IDLE_TIMEOUT_SECONDS: '3', SESSION_ABSOLUTE_TIMEOUT_SECONDS: '5' });
  });
  afterAll(() => t.close());

  it('ends the session 5 s after login even though the user stays active', async () => {
    const c = await loggedIn(t, 'owner');
    for (let i = 0; i < 3; i++) {
      await sleep(1400);
      await c.get('/auth/me').expect(200); // ~4.2 s: never idle for 3 s, still < 5 s
    }
    await sleep(1200); // ~5.4 s after login
    const res = await c.get('/auth/me').expect(401);
    expect(res.body.message).toBe('Session expired. Please log in again.');
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get('owner') as { n: number }).n).toBe(0);
  }, 15_000);
});

describe('COOKIE_SECURE=true', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ COOKIE_SECURE: 'true' });
  });
  afterAll(() => t.close());

  it('sets the Secure flag when the trusted local proxy reports HTTPS', async () => {
    const res = await request(t.http)
      .get('/api/auth/csrf')
      .set('X-Forwarded-For', '198.51.100.250')
      .set('X-Forwarded-Proto', 'https')
      .expect(200);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('s3p.sid='));
    expect(cookie).toMatch(/; Secure/);
  });

  it('never issues a Secure cookie over plain HTTP', async () => {
    const res = await request(t.http).get('/api/auth/csrf').expect(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('session store failure', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('fails closed with a generic 503 JSON (no stack trace, no SQL details)', async () => {
    const c = await loggedIn(t, 'owner');
    await c.get('/auth/me').expect(200);

    t.db.close(); // simulate the database becoming unavailable

    const res = await c.get('/auth/me');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ statusCode: 503, error: 'Service Unavailable', message: 'Session service unavailable. Please try again.' });
    expect(res.text).not.toMatch(/at \w+ \(|sqlite|SELECT|node_modules/i);
    expect(t.logs.some((l) => l.startsWith('ERROR') && l.includes('Session store error'))).toBe(true);
  });

  it('protected routes never fall through as authenticated when the store is down', async () => {
    const c = new Client(t.http);
    const res = await c.get('/staff');
    expect([401, 503]).toContain(res.status);
  });
});
