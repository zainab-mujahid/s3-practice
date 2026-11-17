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

## S3 storage foundation (Step 3)

See [`aws-setup.md`](aws-setup.md) (manual setup) and
[`policy-review.md`](policy-review.md) (least-privilege review of every setting
and statement).

- **One AWS identity.** The backend uses one dedicated IAM user through the SDK
  default credential chain (`AWS_PROFILE` → `~/.aws/credentials`). The app's
  Owner, Staff and Visitor users are not AWS identities. Credentials are never in
  code, `.env`, logs or responses.
- **Buckets by alias.** Code and responses say `PUBLIC` / `PRIVATE`; bucket
  names stay in the backend config.
- **Key allow-list** (`storage/storage-locations.ts`):
  - Every S3 call validates the bucket alias and the exact key shape before the SDK runs.
  - Keys are server-generated UUIDs, so client file names are never used.
- **Verification on the stored bytes** (`storage/object-verifier.ts`):
  - size between 32 B and 5 MB;
  - JPEG/PNG/WebP signature;
  - end-of-file/container check;
  - detected format = declared format = stored Content-Type.
  - The byte reads are pinned to the HEAD ETag.
  - **This is basic file-type verification, not image validation**
    (`storage/magic-bytes.ts` lists what it does not catch).
- **Staging → verify → promote** (`storage/object-promoter.ts`):
  - A server-side copy, pinned with `CopySourceIfMatch`, moves the object to a new final key.
  - The metadata switch and the queuing of the old key happen in one SQLite transaction.
  - The old object is deleted only after that transaction. Failed deletions are retried with backoff.
  - Invalid uploads are rejected and their staging objects deleted, so they never become active.
- **Storage health check** (`GET /api/admin/storage/health`):
  - Owner only, rate limited to 10/min, read-only.
  - Returns status words only, never names, ARNs or account IDs.
  - Makes no AWS call while bucket names are placeholders.
- **Tests never reach AWS.** S3 is mocked (`aws-sdk-client-mock`). With
  `NODE_ENV=test` the client has fake keys and the endpoint `127.0.0.1:9`.

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
8. **Long-lived AWS access key.** The backend IAM user has a static key in
   `~/.aws/credentials`. Rotate it, and delete it when you're done. Production would use
   short-lived role credentials (IAM Identity Center, or an instance/task role).
9. **S3 and SQLite are not one transaction.** A crash between copying an object
   and updating the metadata can leave an orphaned copy or a staging object.
   Lifecycle rules expire `staging/` after 1 day, and queued deletions are retried, but an
   orphaned *final* copy could remain until cleaned up by hand.
10. **No content sanitisation.** Uploads are not re-encoded, and metadata
    (e.g. EXIF GPS) is not stripped. Production would re-encode images in an
    isolated worker or use a scanning service.
11. **Per-staff isolation inside `staff/*` is enforced by the backend**, not by
    IAM, because one backend identity serves every user. IAM still confines the
    backend to the five allowed prefixes.
