import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from './auth/session.utils.js';
import type { AppEnv } from './config/env.validation.js';
import { SqliteSessionStore } from './persistence/sqlite-session.store.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * `trust proxy` policy: trust exactly ONE hop, and only if the direct TCP peer
 * is a loopback address (the local Vite dev proxy).
 *
 * Vite (xfwd: true) appends the real client address as the right-most entry of
 * X-Forwarded-For. Express then uses that right-most entry as req.ip. Anything
 * a client writes into X-Forwarded-For itself ends up further left and is
 * ignored. Requests from non-loopback peers never have forwarding headers trusted.
 *
 * Limitation: any local process can connect to 127.0.0.1:3000 directly and set
 * X-Forwarded-For. On a single developer machine, local processes are already
 * trusted; a production deployment would trust only its real load balancer.
 */
export function trustOnlyLocalProxyHop(addr: string, hopIndex: number): boolean {
  return hopIndex === 0 && LOOPBACK.has(addr);
}

/** HTTP-level setup shared by main.ts and the e2e tests. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);
  const store = app.get(SqliteSessionStore);
  const logger = new Logger('Session');

  app.setGlobalPrefix('api');
  app.disable('x-powered-by');
  app.set('trust proxy', trustOnlyLocalProxyHop);

  // API responses (user info, CSRF tokens) must never be cached.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const sessionMiddleware = session({
    name: SESSION_COOKIE_NAME,
    secret: config.get('SESSION_SECRET', { infer: true }),
    store,
    resave: false, // only write when the session changed…
    rolling: true, // …but refresh the idle-timeout cookie on every response (store.touch)
    saveUninitialized: false, // no DB row / cookie until something is stored (e.g. a CSRF token)
    unset: 'destroy',
    cookie: sessionCookieOptions({
      COOKIE_SECURE: config.get('COOKIE_SECURE', { infer: true }),
      SESSION_IDLE_TIMEOUT_SECONDS: config.get('SESSION_IDLE_TIMEOUT_SECONDS', { infer: true }),
    }),
  });

  // If the session store fails (DB locked/corrupt/unavailable), fail closed with a
  // generic 503 JSON instead of Express's default HTML error page with a stack trace.
  app.use((req: Request, res: Response, next: NextFunction) => {
    sessionMiddleware(req, res, (err?: unknown) => {
      if (!err) return next();
      logger.error(`Session store error: ${err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error'}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.status(503).json({ statusCode: 503, error: 'Service Unavailable', message: 'Session service unavailable. Please try again.' });
    });
  });
}
