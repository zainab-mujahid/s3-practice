import { randomBytes } from 'node:crypto';
import type { CookieOptions } from 'express';
import type { Session, SessionData } from 'express-session';
import type { AppEnv } from '../config/env.validation.js';
import './session.types.js';

export const SESSION_COOKIE_NAME = 's3p.sid';

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

type Sess = Session & Partial<SessionData>;

export const regenerateSession = (s: Sess) =>
  new Promise<void>((resolve, reject) => s.regenerate((err: unknown) => (err ? reject(err) : resolve())));

export const saveSession = (s: Sess) =>
  new Promise<void>((resolve, reject) => s.save((err: unknown) => (err ? reject(err) : resolve())));

export const destroySession = (s: Sess) =>
  new Promise<void>((resolve, reject) => s.destroy((err: unknown) => (err ? reject(err) : resolve())));

/** Cookie attributes. maxAge implements the idle timeout (rolling: refreshed on every request). */
export function sessionCookieOptions(env: Pick<AppEnv, 'COOKIE_SECURE' | 'SESSION_IDLE_TIMEOUT_SECONDS'>): CookieOptions {
  return {
    httpOnly: true, // not readable by JavaScript
    sameSite: 'strict', // never sent on cross-site requests
    secure: env.COOKIE_SECURE, // HTTPS-only when enabled
    path: '/',
    maxAge: env.SESSION_IDLE_TIMEOUT_SECONDS * 1000,
  };
}
