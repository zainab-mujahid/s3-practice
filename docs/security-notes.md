# Security notes

> **Local development only.** Everything below is designed for one developer
> running the app on their own machine. It is **not** production identity
> management or production session infrastructure.

## Authentication & sessions (Step 2)

### Request pipeline

```
Browser ──► Vite :5173 (/api proxy, xfwd) ──► NestJS :3000 (bound to 127.0.0.1)
              express-session (SqliteSessionStore)
              ├─ ClientIpThrottlerGuard   429  too many requests from this client IP
              ├─ CsrfGuard                403  bad Origin or CSRF token (POST/PUT/PATCH/DELETE)
              ├─ SessionAuthGuard         401  no valid session (deny-by-default; @Public() opts out)
              ├─ RolesGuard               403  role not in @Roles(...)
              └─ handler → StaffAccessPolicy  400/403/404  object-level staff ownership
```

### Identities

- Accounts (`owner`, `staff-001`, `staff-002`), their roles and staff IDs are
  defined in code (`backend/src/auth/accounts.ts`), so no request, session
  value or data file can change a role or staff ID.
- The session stores only `userId`, `authenticatedAt`, `csrfToken` and the
  cookie metadata. Role and staff ID are looked up from code on every request.
- Ownership: a STAFF user may access `staff/<their own staffId>` only. The
  requested staffId is validated (`^staff-\d{3}$`) before any lookup, so path
  traversal such as `../owner` is rejected with 400. Staff get 403 for every
  other ID (existing or not), so they cannot enumerate colleagues. The Owner gets
  404 for unknown IDs.

### Passwords

- scrypt (N=2^17, r=8, p=1, 16-byte random salt, 64-byte key), compared
  with `timingSafeEqual`. Parameters read from disk are bounds-checked.
- Unknown usernames still run a dummy scrypt check, so response time does not reveal
  whether an account exists.
- `npm run setup:accounts` / `npm run reset-password` print new passwords only
  to an interactive terminal (TTY check). Hashes are stored in the git-ignored
  `backend/data/accounts.json`, and plaintext is never written anywhere.

### Session store (`node:sqlite`, `backend/data/app.db`)

| Property | How |
|---|---|
| No raw session IDs on disk | Rows are keyed by SHA-256(session ID) |
| Expired sessions never served | Checked on every read, and pruned every 10 min |
| No resurrection after logout / regenerate / reset | Destroyed IDs are tombstoned inside the same transaction; a late `set()` from a concurrent request is ignored |
| `touch()` cannot create sessions | `UPDATE … WHERE expires_at > now` only |
| No sensitive data persisted | Whitelist of fields; anything else is dropped |
| DB failure | Fails closed with a generic `503` (no stack trace or SQL) |
| Concurrency | WAL mode, `busy_timeout`, `BEGIN IMMEDIATE` transactions, parameterised SQL |

### Brute-force protection

- **Per client IP:** 10 login requests per minute (`@nestjs/throttler`, in
  memory) → 429. Includes requests that fail CSRF or validation.
- **Per (username, client IP):** 5 failures within 15 minutes → that pair is locked
  for 15 minutes → 429 with `Retry-After`. Stored in SQLite, so it survives restarts.
- Keying on (username, IP) rather than username alone means an attacker
  cannot lock the real owner out from a different client (lockout DoS).
- Unknown usernames are tracked the same way, so lockouts don't reveal accounts.

### Client IP and `trust proxy`

Express trusts exactly **one** proxy hop, and only when the direct peer is
loopback (the Vite dev server). Vite appends the real client address as the
right-most `X-Forwarded-For` entry, and that is the only entry used.
Client-supplied `X-Forwarded-For` values are ignored. (Tested through Vite: a
spoofed `X-Forwarded-For: 6.6.6.6` is logged as `::1`.)

## Known limitations (acceptable locally, not in production)

1. **Single process, single file.** The SQLite session store cannot be shared
   between several backend instances, is not replicated, and is not encrypted
   at rest. Production would use Redis or a managed database with TLS, encryption
   and monitoring.
2. **Hard-coded identities.** Three accounts defined in code; no user
   management, MFA, password policy UI, account recovery, or audit trail.
   Production would use an identity provider (e.g. Amazon Cognito, Entra ID,
   Auth0) with MFA.
3. **Local processes are trusted.** Any program on this machine can call
   `127.0.0.1:3000` directly and set `X-Forwarded-For`, which affects only the
   rate-limit/lockout key. Production would trust only its real load balancer.
4. **Distributed guessing.** An attacker with many IPs gets 5 guesses per IP per
   15 minutes. The long random passwords make this impractical, but production would
   add MFA, CAPTCHA and anomaly detection.
5. **In-memory request throttle.** The per-IP request counters reset when the
   backend restarts. The failed-login lockouts are persisted.
6. **HTTP only.** Local development runs on plain HTTP. With HTTPS, set
   `COOKIE_SECURE=true`.
7. **File permissions.** `accounts.json` is created with mode 0600, which
   Windows ignores. Protect your user profile and disk.
