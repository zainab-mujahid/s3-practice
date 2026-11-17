import type { Account } from './accounts.js';

declare module 'express-session' {
  // Everything stored in a session. Only these fields are persisted by
  // SqliteSessionStore (whitelist). Never put passwords, hashes or AWS
  // credentials here.
  interface SessionData {
    /** Account.id of the authenticated user (absent for anonymous sessions). */
    userId?: string;
    /** Epoch ms of login; enforces the absolute session timeout. */
    authenticatedAt?: number;
    /** Synchronizer CSRF token for this session. */
    csrfToken?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by SessionAuthGuard from the server-side session. Never from client input. */
      user?: Account;
    }
  }
}
