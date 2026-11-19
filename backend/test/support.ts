/**
 * E2E test harness: a real Nest app (guards, sessions, SQLite) on a temporary
 * data directory. Test-account passwords are generated at runtime and kept in
 * memory only — no passwords in fixtures or files.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { writeCredentialsAtomic } from '../src/auth/credentials-file.js';
import { generatePassword, hashPassword } from '../src/auth/password.js';
import { credentialsFile } from '../src/paths.js';

export const FRONTEND_ORIGIN = 'http://localhost:5173';
export const USERS = ['owner', 'staff-001', 'staff-002'] as const;
export type Username = (typeof USERS)[number];

export interface TestApp {
  app: NestExpressApplication;
  http: App;
  db: DatabaseSync;
  dataDir: string;
  envFile: string;
  passwords: Record<Username, string>;
  sessionSecret: string;
  logs: string[];
  close: () => Promise<void>;
}

class CapturingLogger implements LoggerService {
  constructor(private readonly sink: string[]) {}
  private push(level: string, message: unknown, params: unknown[]) {
    this.sink.push(`${level} ${[message, ...params].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`);
  }
  log(m: unknown, ...p: unknown[]) { this.push('LOG', m, p); }
  error(m: unknown, ...p: unknown[]) { this.push('ERROR', m, p); }
  warn(m: unknown, ...p: unknown[]) { this.push('WARN', m, p); }
  debug(m: unknown, ...p: unknown[]) { this.push('DEBUG', m, p); }
  verbose(m: unknown, ...p: unknown[]) { this.push('VERBOSE', m, p); }
}

export async function createTestApp(envOverrides: Record<string, string> = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 's3p-e2e-'));
  const passwords = Object.fromEntries(USERS.map((u) => [u, generatePassword()])) as Record<Username, string>;
  const accounts: Record<string, { passwordHash: string; updatedAt: string }> = {};
  for (const u of USERS) {
    accounts[u] = { passwordHash: await hashPassword(passwords[u], { log2N: 14, r: 8, p: 1 }), updatedAt: new Date().toISOString() };
  }
  writeCredentialsAtomic(credentialsFile(dataDir), { version: 1, accounts });

  const sessionSecret = randomBytes(48).toString('base64url');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    BACKEND_PORT: '3999',
    FRONTEND_URL: FRONTEND_ORIGIN,
    AWS_REGION: 'us-east-1',
    S3_PUBLIC_BUCKET: 'test-public-bucket',
    S3_PRIVATE_BUCKET: 'test-private-bucket',
    SESSION_SECRET: sessionSecret,
    COOKIE_SECURE: 'false',
    SESSION_IDLE_TIMEOUT_SECONDS: '1800',
    SESSION_ABSOLUTE_TIMEOUT_SECONDS: '28800',
    DATA_DIR: dataDir,
    ...envOverrides,
  });

  // ConfigModule validates env when app.module is evaluated, so load a fresh copy.
  vi.resetModules();
  const { AppModule } = await import('../src/app.module.js');
  const { configureApp } = await import('../src/app.setup.js');
  const { DATABASE } = await import('../src/persistence/persistence.module.js');

  const logs: string[] = [];
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: new CapturingLogger(logs) });
  configureApp(app);
  await app.init();

  return {
    app,
    http: app.getHttpServer() as App,
    db: app.get<DatabaseSync>(DATABASE),
    dataDir,
    envFile: join(dataDir, '.env'),
    passwords,
    sessionSecret,
    logs,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

let ipCounter = 1;
/** A fresh fake client IP (as forwarded by the Vite proxy), so rate limits don't bleed between tests. */
export const nextIp = () => `198.51.100.${ipCounter++}`;

/**
 * A browser-like client: keeps cookies, sends Origin and the CSRF header,
 * and arrives "through the local proxy" with its own X-Forwarded-For address.
 */
export class Client {
  readonly agent: ReturnType<typeof request.agent>;
  csrfToken?: string;

  constructor(
    http: App,
    readonly ip: string = nextIp(),
  ) {
    this.agent = request.agent(http);
  }

  get(path: string) {
    return this.agent.get(`/api${path}`).set('X-Forwarded-For', this.ip);
  }

  /** State-changing request with Origin + CSRF token, like the real frontend. */
  post(path: string, body?: object) {
    const req = this.agent.post(`/api${path}`).set('X-Forwarded-For', this.ip).set('Origin', FRONTEND_ORIGIN);
    if (this.csrfToken) req.set('X-CSRF-Token', this.csrfToken);
    return body ? req.send(body) : req;
  }

  /** DELETE with Origin + CSRF token. */
  delete(path: string) {
    const req = this.agent.delete(`/api${path}`).set('X-Forwarded-For', this.ip).set('Origin', FRONTEND_ORIGIN);
    if (this.csrfToken) req.set('X-CSRF-Token', this.csrfToken);
    return req;
  }

  async fetchCsrf() {
    const res = await this.get('/auth/csrf').expect(200);
    this.csrfToken = res.body.csrfToken;
    return this.csrfToken!;
  }

  async login(username: string, password: string) {
    if (!this.csrfToken) await this.fetchCsrf();
    const res = await this.post('/auth/login', { username, password });
    if (res.status === 200) this.csrfToken = res.body.csrfToken;
    return res;
  }
}

export async function loggedIn(t: TestApp, username: Username): Promise<Client> {
  const c = new Client(t.http);
  const res = await c.login(username, t.passwords[username]);
  if (res.status !== 200) throw new Error(`login as ${username} failed with ${res.status}`);
  return c;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
