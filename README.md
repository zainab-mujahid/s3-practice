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
docs/       AWS setup guide, sample policies, testing checklist (later steps)
```

## Prerequisites

- Node.js 24+ and npm 11+
- (From Step 4) An AWS CLI profile configured by you, plus the two buckets

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
cd frontend && npm run lint && npm run build
```

## Secrets

- `backend/.env` and any `.env.*` / `*.local` files are git-ignored; only `.env.example` files are committed.
- `backend/data/` (SQLite DB with sessions/login counters, `accounts.json` with password hashes) is git-ignored.
- Plaintext passwords are never written to any file, log or source code.
- No AWS access keys in `.env`: the backend uses the AWS SDK default credential chain (`AWS_PROFILE`).
- Nothing under `frontend/src` may contain secrets — it is shipped to the browser.
