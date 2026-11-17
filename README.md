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
- No AWS access keys in `.env`: the backend uses the AWS SDK default credential chain (`AWS_PROFILE`).
- Nothing under `frontend/src` may contain secrets — it is shipped to the browser.
