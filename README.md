# Restaurant S3 Practice

A small local learning app for hands-on practice with Amazon S3, IAM, bucket
policies, public vs. private access, presigned URLs (POST and GET), and
server-side RBAC.

```
React (Vite, :5173) ──/api proxy──► NestJS (:3000) ──AWS SDK v3──► S3 (public bucket + private bucket)
```

> This is a local learning project, not a production system. AWS infrastructure
> (buckets, policies, IAM) is created **manually** by you; the app never
> creates or modifies AWS resources.

## Layout

```
backend/    NestJS API (ESM, Vitest, oxlint)
frontend/   React + Vite + TypeScript + Tailwind CSS v4
docs/       AWS setup guide, policy review, sample policies (docs/policies), security notes
```

## Prerequisites

- Node.js 24+ and npm 11+
- For real S3 access: the two buckets, an IAM user and a local AWS CLI profile you set up
  yourself by following [`docs/aws-setup.md`](docs/aws-setup.md). Until then the app runs
  with placeholder bucket names and makes no AWS calls.

## First-time setup (Windows, PowerShell or Git Bash)

```bash
cd backend
npm install
copy .env.example .env      # Git Bash: cp .env.example .env  — then edit values
cd ../frontend
npm install
```

## Test accounts (run these yourself, in your own terminal)

The app has three application identities (not AWS identities) plus anonymous visitors:

| Username    | Role    | Staff ID    | Can do (enforced by the backend)                     |
|-------------|---------|-------------|------------------------------------------------------|
| `owner`     | OWNER   | –           | Everything; all staff records                        |
| `staff-001` | STAFF   | `staff-001` | Own profile/record only                              |
| `staff-002` | STAFF   | `staff-002` | Own profile/record only                              |
| (none)      | VISITOR | –           | Public pages only — open the app in a private window |

Create them once:

```powershell
cd backend
npm run setup:accounts
```

- Generates three random 20-character passwords and a `SESSION_SECRET`.
- Stores only **scrypt hashes** in `backend/data/accounts.json` (git-ignored) and
  appends `SESSION_SECRET` to `backend/.env` (git-ignored).
- Prints the passwords **once**. Save them in a password manager.
- Never overwrites: existing accounts and an existing `SESSION_SECRET` are kept.
- Refuses to run unless its output is an interactive terminal (PowerShell,
  Windows Terminal, VS Code terminal). In Git Bash/mintty use `winpty npm run setup:accounts`.
  Do not paste the output anywhere (chat, tickets, screenshots).

Forgot or leaked a password? Reset one account:

```powershell
npm run reset-password -- staff-001
```

This prints a new password once, signs that user out on every device, clears
their failed-login counters, and leaves all other users signed in.

## Security model (Step 2)

- Session cookie `s3p.sid`: `HttpOnly`, `SameSite=Strict`, `Secure` when
  `COOKIE_SECURE=true`; new session ID on login; destroyed on logout;
  idle timeout 30 min, absolute timeout 8 h.
- CSRF: every POST/PUT/PATCH/DELETE (including login) needs `Origin` =
  `FRONTEND_URL` **and** an `X-CSRF-Token` matching the session (`GET /api/auth/csrf`).
- Brute force: 10 login requests/min per client IP, plus a 15-minute lock per
  (username, client IP) after 5 failures. Counters live in SQLite.
- Authorization is decided only by NestJS guards (deny-by-default) and
  `StaffAccessPolicy`. Frontend role checks only change what is displayed.
- See [`docs/security-notes.md`](docs/security-notes.md) for the design and its
  local-only limitations.

## S3 storage foundation (Step 3)

- `backend/src/storage/` contains:
  - one S3 client, using the AWS SDK v3 default credential chain via `AWS_PROFILE`;
  - a key allow-list checked before every S3 call;
  - file-type checks and post-upload verification;
  - the staging → verify → promote flow;
  - a SQLite metadata store for the active logo, dishes, staff pictures, upload intents and pending deletions.
- Upload/replace/delete endpoints use this pipeline from Step 4 on (public images; staff pictures follow in Step 5).
- `GET /api/admin/storage/health` is Owner-only and read-only. It makes one
  prefix-scoped `ListObjectsV2` call per bucket. On the Owner dashboard, use **Check S3 connection**.
- Docs:
  - AWS setup: [`docs/aws-setup.md`](docs/aws-setup.md)
  - least-privilege review: [`docs/policy-review.md`](docs/policy-review.md)
  - sample policies: `docs/policies/`
- All automated tests mock S3 with `aws-sdk-client-mock`. With `NODE_ENV=test`, the S3 client
  uses fake keys and an unroutable endpoint, so tests can never reach AWS.

## Public restaurant images (Step 4)

- The Owner uploads, replaces and deletes the restaurant logo and up to 50 dish images.
  Everyone, including anonymous visitors, sees the published images.
- Flow: React → NestJS (session, CSRF, OWNER) → presigned POST → browser uploads straight to
  `staging/` in S3 → NestJS verifies the stored bytes → copies them to `logo/` or `dishes/` → SQLite.
  Image bytes never pass through NestJS, and AWS secrets never reach the browser.
- The presigned POST is pinned to one server-generated staging key, the exact Content-Type,
  32 B–5 MiB, and expires after at most 300 s.
- A failed replacement never removes the published image. The old object is deleted only after
  the new one is active, and failed deletions are retried.
- Endpoints, controls, recovery, limits and the manual live-check list:
  [`docs/public-images.md`](docs/public-images.md).

## Run locally

Two terminals:

```bash
# Terminal 1
cd backend
npm run start:dev           # http://127.0.0.1:3000/api/health

# Terminal 2
cd frontend
npm run dev                 # http://localhost:5173
```

The browser only talks to `http://localhost:5173`; Vite proxies `/api/*` to
the backend. The header badge shows "Backend connected" when the proxy and
backend are working.

## Checks

```bash
cd backend  && npm run lint && npm test && npm run test:e2e && npm run build
cd frontend && npm run lint && npm test && npm run build
```

## Secrets

- `backend/.env` and any `.env.*` / `*.local` files are git-ignored; only `.env.example` files are committed.
- `backend/data/` (SQLite DB with sessions/login counters, `accounts.json` with password hashes) is git-ignored.
- Plaintext passwords are never written to any file, log or source code.
- No AWS access keys in `.env`: the backend uses the AWS SDK default credential chain (`AWS_PROFILE`),
  and the key of the dedicated IAM user lives only in `~/.aws/credentials`.
- AWS credentials and AWS error messages are never sent to the browser or logged. The private bucket's
  name never leaves the backend. The **public** bucket's name is part of every public image URL and of the
  presigned POST URL; this is unavoidable without a CDN. Presigned POST fields contain the IAM
  **access key ID** (never the secret), as every SigV4 presigned request does.
- Nothing under `frontend/src` may contain secrets — it is shipped to the browser.
