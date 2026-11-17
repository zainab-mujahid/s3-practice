import request from 'supertest';
import { runResetPassword } from '../src/cli/accounts-cli.js';
import { Client, createTestApp, FRONTEND_ORIGIN, loggedIn, nextIp, type TestApp } from './support.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  // Nothing sensitive may ever reach the logs.
  const logText = t.logs.join('\n');
  for (const pw of Object.values(t.passwords)) expect(logText).not.toContain(pw);
  expect(logText).not.toContain(t.sessionSecret);
  expect(logText).not.toContain('scrypt$');
  await t.close();
});

const cookieHeader = (res: request.Response) => ([] as string[]).concat(res.headers['set-cookie'] ?? []);
const sidCookie = (res: request.Response) => cookieHeader(res).find((c) => c.startsWith('s3p.sid='))?.split(';')[0];

// ---------------------------------------------------------------------------
describe('login', () => {
  it('accepts correct credentials and returns only public user fields', async () => {
    const c = new Client(t.http);
    const res = await c.login('owner', t.passwords.owner);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: 'owner', username: 'owner', role: 'OWNER', staffId: null, displayName: 'Restaurant Owner' });
    expect(typeof res.body.csrfToken).toBe('string');

    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/scrypt|passwordHash|password/i);
    expect(text).not.toContain(t.passwords.owner);
    expect(text).not.toContain(t.sessionSecret);
  });

  it('accepts staff credentials and binds the immutable staffId', async () => {
    const c = new Client(t.http);
    const res = await c.login('staff-002', t.passwords['staff-002']);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'STAFF', staffId: 'staff-002' });
  });

  it('normalises username case and whitespace', async () => {
    const c = new Client(t.http);
    expect((await c.login('  Staff-001 ', t.passwords['staff-001'])).status).toBe(200);
  });

  it('rejects a wrong password and an unknown user with the same generic 401', async () => {
    const wrong = await new Client(t.http).login('owner', 'not-the-password');
    const unknown = await new Client(t.http).login('manager', 'whatever');
    const crossed = await new Client(t.http).login('staff-001', t.passwords['staff-002']);
    for (const res of [wrong, unknown, crossed]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Invalid username or password' });
    }
  });

  it('sets a hardened session cookie (HttpOnly, SameSite=Strict, Path=/, expiry; no Secure over HTTP)', async () => {
    const c = new Client(t.http);
    await c.fetchCsrf();
    const res = await c.post('/auth/login', { username: 'owner', password: t.passwords.owner }).expect(200);
    const cookie = cookieHeader(res).find((x) => x.startsWith('s3p.sid='))!;
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Strict/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; Expires=/);
    expect(cookie).not.toMatch(/; Secure/);
  });

  it('regenerates the session ID on login (session fixation is not possible)', async () => {
    const ip = nextIp();
    const pre = await request(t.http).get('/api/auth/csrf').set('X-Forwarded-For', ip).expect(200);
    const preCookie = sidCookie(pre)!;

    const login = await request(t.http)
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .set('Origin', FRONTEND_ORIGIN)
      .set('Cookie', preCookie)
      .set('X-CSRF-Token', pre.body.csrfToken)
      .send({ username: 'owner', password: t.passwords.owner })
      .expect(200);
    const postCookie = sidCookie(login)!;

    expect(postCookie).toBeDefined();
    expect(postCookie).not.toBe(preCookie);
    // The pre-login ID is dead: it is not authenticated and cannot be revived.
    await request(t.http).get('/api/auth/me').set('Cookie', preCookie).expect(401);
    await request(t.http).get('/api/auth/me').set('Cookie', postCookie).expect(200);
    // The CSRF token was rotated too.
    expect(login.body.csrfToken).not.toBe(pre.body.csrfToken);
  });

  it('stores no password, hash or role in the session database', async () => {
    await loggedIn(t, 'staff-001');
    const rows = t.db.prepare('SELECT data FROM sessions').all() as { data: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const { data } of rows) {
      // Only the whitelisted keys; role/staffId are looked up from code on every request.
      const keys = Object.keys(JSON.parse(data));
      expect(keys.every((k) => ['cookie', 'userId', 'authenticatedAt', 'csrfToken'].includes(k))).toBe(true);
    }
    const all = rows.map((r) => r.data).join('\n');
    expect(all).not.toMatch(/scrypt|password|"role"|"staffId"/i);
    for (const pw of Object.values(t.passwords)) expect(all).not.toContain(pw);
  });
});

// ---------------------------------------------------------------------------
describe('request validation', () => {
  it.each([
    ['empty body', {}],
    ['missing password', { username: 'owner' }],
    ['unexpected field', { username: 'owner', password: 'x', role: 'OWNER' }],
    ['non-string username', { username: 123, password: 'x' }],
    ['username with illegal chars', { username: '../owner', password: 'x' }],
    ['too-long username', { username: 'a'.repeat(65), password: 'x' }],
    ['too-long password', { username: 'owner', password: 'P'.repeat(257) }],
  ])('rejects %s with 400 and does not echo the submitted values', async (_label, body) => {
    const c = new Client(t.http);
    await c.fetchCsrf();
    const res = await c.post('/auth/login', body).expect(400);
    expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request', message: 'Invalid request body' });
    expect(Array.isArray(res.body.details)).toBe(true);
    const text = JSON.stringify(res.body);
    if ('password' in body && typeof body.password === 'string' && body.password.length > 5) {
      expect(text).not.toContain(body.password);
    }
  });

  it('rejects malformed JSON with 400', async () => {
    const c = new Client(t.http);
    await c.fetchCsrf();
    await c.post('/auth/login').set('Content-Type', 'application/json').send('{"username": "owner", ').expect(400);
  });
});

// ---------------------------------------------------------------------------
describe('CSRF protection', () => {
  it('rejects login without a CSRF token', async () => {
    const res = await request(t.http)
      .post('/api/auth/login')
      .set('X-Forwarded-For', nextIp())
      .set('Origin', FRONTEND_ORIGIN)
      .send({ username: 'owner', password: t.passwords.owner })
      .expect(403);
    expect(res.body.message).toBe('Invalid or missing CSRF token');
  });

  it('rejects a valid token sent from a foreign Origin', async () => {
    const c = new Client(t.http);
    await c.fetchCsrf();
    const res = await c
      .post('/auth/login', { username: 'owner', password: t.passwords.owner })
      .set('Origin', 'http://evil.example')
      .expect(403);
    expect(res.body.message).toBe('Request origin not allowed');
  });

  it('rejects state-changing requests with neither Origin nor Referer', async () => {
    const c = new Client(t.http);
    const token = await c.fetchCsrf();
    await c.agent
      .post('/api/auth/login')
      .set('X-Forwarded-For', c.ip)
      .set('X-CSRF-Token', token)
      .send({ username: 'owner', password: t.passwords.owner })
      .expect(403);
  });

  it('accepts a same-origin Referer when Origin is absent', async () => {
    const c = new Client(t.http);
    const token = await c.fetchCsrf();
    await c.agent
      .post('/api/auth/login')
      .set('X-Forwarded-For', c.ip)
      .set('Referer', `${FRONTEND_ORIGIN}/login`)
      .set('X-CSRF-Token', token)
      .send({ username: 'owner', password: t.passwords.owner })
      .expect(200);
  });

  it('rejects a token that belongs to a different session', async () => {
    const victim = new Client(t.http);
    const attacker = new Client(t.http);
    const victimToken = await victim.fetchCsrf();
    await attacker.fetchCsrf();
    attacker.csrfToken = victimToken;
    await attacker.post('/auth/login', { username: 'owner', password: t.passwords.owner }).expect(403);
  });

  it('rejects the pre-login token after login (rotation) and requires a token for logout', async () => {
    const c = new Client(t.http);
    const preLogin = await c.fetchCsrf();
    await c.login('owner', t.passwords.owner);
    const fresh = c.csrfToken!;

    c.csrfToken = preLogin;
    await c.post('/auth/logout').expect(403);
    c.csrfToken = undefined;
    await c.post('/auth/logout').expect(403);
    c.csrfToken = fresh;
    await c.post('/auth/logout').expect(204);
  });

  it('safe methods (GET) do not need a token', async () => {
    const c = await loggedIn(t, 'owner');
    await c.agent.get('/api/auth/me').expect(200);
  });
});

// ---------------------------------------------------------------------------
describe('authentication required (anonymous visitor)', () => {
  it.each(['/auth/me', '/profile/me', '/staff', '/staff/staff-001', '/staff/staff-002'])('GET %s -> 401', async (path) => {
    const res = await request(t.http).get(`/api${path}`).expect(401);
    expect(res.body).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
  });

  it('anonymous logout with a valid CSRF token -> 401', async () => {
    const c = new Client(t.http);
    await c.fetchCsrf();
    await c.post('/auth/logout').expect(401);
  });

  it('public endpoints stay reachable', async () => {
    await request(t.http).get('/api/health').expect(200);
    await request(t.http).get('/api/auth/csrf').expect(200);
  });

  it('a forged / unsigned session cookie is ignored', async () => {
    await request(t.http).get('/api/auth/me').set('Cookie', 's3p.sid=s%3Aforged.invalidsignature').expect(401);
    await request(t.http).get('/api/auth/me').set('Cookie', 's3p.sid=owner').expect(401);
  });
});

// ---------------------------------------------------------------------------
describe('RBAC and staff ownership', () => {
  let owner: Client;
  let staffA: Client;
  let staffB: Client;

  beforeAll(async () => {
    owner = await loggedIn(t, 'owner');
    staffA = await loggedIn(t, 'staff-001');
    staffB = await loggedIn(t, 'staff-002');
  });

  it('GET /auth/me and /profile/me return the caller’s own identity from the session', async () => {
    expect((await staffA.get('/auth/me').expect(200)).body.user).toMatchObject({ id: 'staff-001', staffId: 'staff-001' });
    expect((await staffB.get('/profile/me').expect(200)).body.profile).toMatchObject({
      id: 'staff-002',
      role: 'STAFF',
      position: 'Server',
    });
    expect((await owner.get('/profile/me').expect(200)).body.profile).toMatchObject({ id: 'owner', role: 'OWNER' });
  });

  it('identity cannot be influenced by query strings or headers', async () => {
    const res = await staffA.get('/profile/me?userId=owner&staffId=staff-002').set('X-User-Id', 'owner').expect(200);
    expect(res.body.profile.id).toBe('staff-001');
  });

  it('Owner can list all staff', async () => {
    const res = await owner.get('/staff').expect(200);
    expect(res.body.staff.map((s: { staffId: string }) => s.staffId)).toEqual(['staff-001', 'staff-002']);
  });

  it('Staff cannot list staff (Owner-only) -> 403', async () => {
    for (const c of [staffA, staffB]) {
      const res = await c.get('/staff').expect(403);
      expect(res.body.message).toBe('You do not have permission to perform this action');
    }
  });

  it('Owner can read any staff record; unknown -> 404', async () => {
    await owner.get('/staff/staff-001').expect(200);
    await owner.get('/staff/staff-002').expect(200);
    await owner.get('/staff/staff-999').expect(404);
  });

  it('Staff A can read only Staff A', async () => {
    expect((await staffA.get('/staff/staff-001').expect(200)).body.staff.staffId).toBe('staff-001');
    const res = await staffA.get('/staff/staff-002').expect(403);
    expect(res.body.message).toBe('You can only access your own staff profile');
  });

  it('Staff B can read only Staff B', async () => {
    await staffB.get('/staff/staff-002').expect(200);
    await staffB.get('/staff/staff-001').expect(403);
  });

  it('Staff get 403 (not 404) for unknown staff IDs — no enumeration', async () => {
    await staffA.get('/staff/staff-999').expect(403);
  });

  it.each(['..%2Fstaff-002', 'staff-001%2F..%2Fstaff-002', '%2E%2E', 'owner', 'STAFF-002', 'staff-2'])(
    'rejects malformed / traversal staff ID %s with 400',
    async (bad) => {
      await owner.get(`/staff/${bad}`).expect(400);
      await staffA.get(`/staff/${bad}`).expect(400);
    },
  );
});

// ---------------------------------------------------------------------------
describe('logout', () => {
  it('destroys the server-side session; replaying the old cookie no longer works', async () => {
    const ip = nextIp();
    const pre = await request(t.http).get('/api/auth/csrf').set('X-Forwarded-For', ip).expect(200);
    const login = await request(t.http)
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .set('Origin', FRONTEND_ORIGIN)
      .set('Cookie', sidCookie(pre)!)
      .set('X-CSRF-Token', pre.body.csrfToken)
      .send({ username: 'staff-001', password: t.passwords['staff-001'] })
      .expect(200);
    const cookie = sidCookie(login)!; // keep a copy, like a stolen cookie

    await request(t.http).get('/api/auth/me').set('Cookie', cookie).expect(200);

    const out = await request(t.http)
      .post('/api/auth/logout')
      .set('X-Forwarded-For', ip)
      .set('Origin', FRONTEND_ORIGIN)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', login.body.csrfToken)
      .expect(204);
    expect(cookieHeader(out).join(';')).toMatch(/s3p\.sid=;/); // browser cookie cleared

    // Server-side session is gone: the copied cookie is useless.
    await request(t.http).get('/api/auth/me').set('Cookie', cookie).expect(401);
  });
});

// ---------------------------------------------------------------------------
describe('brute-force protection', () => {
  it('locks a (username, client) pair after 5 failures — even the correct password then gets 429 + Retry-After', async () => {
    const attacker = new Client(t.http);
    for (let i = 0; i < 5; i++) {
      expect((await attacker.login('staff-002', `wrong-${i}`)).status).toBe(401);
    }
    const res = await attacker.login('staff-002', t.passwords['staff-002']);
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body.message).toBe('Too many failed login attempts. Please try again later.');

    // Persisted in SQLite, not in process memory
    const row = t.db.prepare('SELECT locked_until FROM login_failures WHERE username = ? AND ip = ?').get('staff-002', attacker.ip) as
      | { locked_until: number }
      | undefined;
    expect(row?.locked_until).toBeGreaterThan(Date.now());
  });

  it('the real user on another client is NOT locked out (lockout-DoS mitigation)', async () => {
    const attacker = new Client(t.http);
    for (let i = 0; i < 5; i++) await attacker.login('owner', `wrong-${i}`);
    expect((await attacker.login('owner', t.passwords.owner)).status).toBe(429);

    const realOwner = new Client(t.http);
    expect((await realOwner.login('owner', t.passwords.owner)).status).toBe(200);
  });

  it('unknown usernames lock the same way (no account enumeration via lockout)', async () => {
    const c = new Client(t.http);
    for (let i = 0; i < 5; i++) expect((await c.login('ghost', 'x')).status).toBe(401);
    expect((await c.login('ghost', 'x')).status).toBe(429);
  });

  it('rate-limits login requests per client IP (10/min) -> 429', async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(t.http)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .set('Origin', FRONTEND_ORIGIN)
        .send({ username: 'owner', password: 'x' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true); // no CSRF token, but counted
    expect(statuses[10]).toBe(429);
  });

  it('spoofed X-Forwarded-For entries cannot dodge the rate limit (only the proxy-added right-most entry counts)', async () => {
    const realIp = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(t.http)
        .post('/api/auth/login')
        .set('X-Forwarded-For', `203.0.113.${i}, ${realIp}`) // client-written value + proxy-appended real IP
        .set('Origin', FRONTEND_ORIGIN)
        .send({ username: 'owner', password: 'x' });
      statuses.push(res.status);
    }
    expect(statuses[10]).toBe(429);
  });

  it('logs failed logins with the effective client IP, without passwords or unknown usernames', async () => {
    const c = new Client(t.http, '192.0.2.77');
    await c.login('owner', 'Typo-Password-123');
    await c.login('Typo-Password-456', 'x');
    const lines = t.logs.filter((l) => l.includes('192.0.2.77'));
    expect(lines.some((l) => l.includes('Failed login for account "owner" from 192.0.2.77'))).toBe(true);
    expect(lines.some((l) => l.includes('Failed login for an unknown username from 192.0.2.77'))).toBe(true);
    expect(t.logs.join('\n')).not.toMatch(/Typo-Password/i);
  });
});

// ---------------------------------------------------------------------------
describe('password reset invalidates only the affected user', () => {
  it('signs out every staff-001 session, leaves staff-002 and owner signed in, and swaps the password', async () => {
    const aLaptop = await loggedIn(t, 'staff-001');
    const aPhone = await loggedIn(t, 'staff-001');
    const b = await loggedIn(t, 'staff-002');
    const owner = await loggedIn(t, 'owner');

    const out: string[] = [];
    const io = { isTTY: true, out: (l: string) => out.push(l), err: () => undefined };
    const code = await runResetPassword('staff-001', { envFile: t.envFile, dataDir: t.dataDir }, io, {
      scryptParams: { log2N: 14, r: 8, p: 1 },
    });
    expect(code).toBe(0);
    const newPassword = /^\s{2}staff-001\s+STAFF\s+staff-001\s+(\S{20})$/m.exec(out.join('\n'))![1];

    await aLaptop.get('/auth/me').expect(401);
    await aPhone.get('/auth/me').expect(401);
    await b.get('/auth/me').expect(200);
    await owner.get('/auth/me').expect(200);

    expect((await new Client(t.http).login('staff-001', t.passwords['staff-001'])).status).toBe(401);
    expect((await new Client(t.http).login('staff-001', newPassword)).status).toBe(200);
  });
});
