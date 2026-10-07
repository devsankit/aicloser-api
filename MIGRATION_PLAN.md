# AIcloser Backend Migration Plan

This plan documents the transition from internal Next.js API routes in `AIcloser/application` to the dedicated backend service `aicloser-api`.

---

## 1. Current State vs Target Architecture

| Component | Previous Architecture | Target Dedicated Architecture | Status |
| :--- | :--- | :--- | :--- |
| **Database** | Shared `gigxomi` database on PostgreSQL | Dedicated PostgreSQL DB `aicloser` with dedicated user `aicloser_user` | **COMPLETED & VERIFIED** |
| **Tenant Partitioning** | Porous joins via `assignedAgentId` | Mandatory `tenantId` on all models with compound indexes | **COMPLETED & BACKFILLED** |
| **Backend Service** | Next.js API routes (`src/app/api/*`) | Dedicated Express/TypeScript API service `aicloser-api` (`/api/v1/*`) | **SCAFFOLDED & TESTED** |
| **Isolation Tests** | None | Automated multi-tenant unit & integration test suites (100% passing) | **COMPLETED** |
| **Frontend UI** | Directly queries `/api/*` | Queries `api.aicloser.com/api/v1/*` or proxies through Next.js rewrite | **READY FOR PHASE 3** |

---

## 2. API Routes Mapping

| Purpose | Current Next.js Route | Dedicated `aicloser-api` Route |
| :--- | :--- | :--- |
| **Health** | `GET /api/health` | `GET /health` |
| **Session** | `POST /api/auth/login`, `GET /api/auth/session` | `POST /api/v1/auth/login`, `GET /api/v1/auth/me` |
| **Leads** | `GET /api/sales/leads`, `POST /api/sales/leads` | `GET /api/v1/leads`, `POST /api/v1/leads`, `PATCH /api/v1/leads/:id` |
| **Contacts** | `GET /api/whatsapp-marketing/contacts` | `GET /api/v1/contacts`, `POST /api/v1/contacts` |
| **Calls** | `GET /api/sales/mobile/calls`, `POST ...` | `GET /api/v1/calls`, `POST /api/v1/calls` |
| **Conversations** | `GET /api/conversations` | `GET /api/v1/conversations`, `GET /api/v1/conversations/:id` |
| **Super Admin** | `GET /api/super-admin/tenants` | `GET /api/v1/super-admin/tenants`, `POST /api/v1/super-admin/tenants/:id/impersonate` |
| **Webhooks** | `POST /api/webhooks/meta` | `POST /api/v1/webhooks/meta` (with HMAC sha256 signature verification) |

---

## 3. Phased Execution Checklist

### Phase 1: Database Separation (Completed)
- [x] Provision standalone database `aicloser` and user `aicloser_user`.
- [x] Restore full snapshot from `gigxomi` to `aicloser`.
- [x] Update local `.env` and production VPS `/var/www/aicloser-app/.env` to point to `aicloser`.
- [x] Execute safe additive migration adding `tenantId` and compound indexes across all 22 CRM models.
- [x] Backfill `tenantId` on all 756 leads, 6 agents, 5 calls, 12 timeline entries, 86 activity logs, 112 pool items, 7 devices with 0 nulls remaining.
- [x] Validate zero data loss and verify multi-tenant isolation tests.

### Phase 2: Standalone API Engine (Completed)
- [x] Scaffold `aicloser-api` repository (`D:\Gigxomi-Ecosystem\AIcloser\aicloser-api`).
- [x] Implement strict server-side session authentication (`src/middlewares/auth.ts`).
- [x] Implement multi-tenant boundary isolation with zero client spoofing (`src/middlewares/tenant-isolation.ts`).
- [x] Implement RBAC authorization, rate limiting, Zod validation, and webhook signature validation.
- [x] Implement versioned `/api/v1/*` routes for Leads, Contacts, Calls, Conversations, Auth, Super Admin, and Webhooks.
- [x] Complete TypeScript compilation (`npm run build`).

### Phase 2.5: Canonical Workspace Registry & Database Hardening (Completed)
- [x] Configure Prisma 7.x compatibility (`prisma.config.ts`).
- [x] Baseline all 40 historical migrations in `_prisma_migrations`.
- [x] Create migration `20261007190000_aicloser_canonical_workspaces_and_hardening`:
  - Created canonical workspace model `AicloserWorkspace` preserving all 78 existing tenant IDs without merging or loss.
  - Backfilled 78 distinct workspaces idempotently from `AppAuthUser` and operational CRM tables.
  - Enforced `NOT NULL` on `tenantId` across all core CRM models.
  - Added Foreign Key constraints referencing `AicloserWorkspace(id)` across `SalesLeadAssignment`, `SalesAgentProfile`, `SalesMobileCall`, `SalesLeadTimelineEntry`, `SalesActivityLog`, `SalesLeadPoolItem`, `SalesMobileDevice`, `MarketingContact`, `AppConversation`, and `AppAuthUser`.
  - Added compound indexes for tenant plus common query dimensions.
- [x] Applied migration permanently with `prisma migrate deploy` (41 total migrations applied, schema up-to-date).
- [x] Regenerated Prisma Client v7.10.0 with full relations.
- [x] Hardened `enforceTenantIsolation` middleware:
  - Validates `x-target-tenant-id` exists in canonical registry before permitting Super Admin override.
  - Rejects unknown workspaces with 404 `WorkspaceNotFound`.
  - Requires tenant context for Super Admin (400 `MissingTenantContext`).
  - Blocks cross-tenant spoofing across headers, query parameters, and JSON body.
- [x] Hardened `callsRouter.post`: validates that assigned agent belongs to the caller's workspace (400 `InvalidAgent`).
- [x] Expanded integration test suite to 21 automated tests covering cross-tenant access, spoofing, foreign agent rejection, audited override, and health check (21/21 passed).
- [x] Created read-only database audit script `scripts/db-audit.cjs` confirming 0 null tenant rows and 0 tenant mismatches.

### Phase 3: Frontend Client Integration (Pending Approval)
- [ ] Add optional `NEXT_PUBLIC_AICLOSER_API_URL` to `AIcloser/application/.env`.
- [ ] Configure `next.config.ts` rewrites to proxy `/api/v1/*` to `http://127.0.0.1:3060/api/v1/*`.
- [ ] Verify frontend dashboard loads leads, calls, and contacts via the dedicated API.

### Phase 2.75: Unified Sync and Recording Foundation (Implemented Locally)
- [x] Added `CallRecordingUpload` with tenant-scoped idempotency, retry metadata, lifecycle timestamps, and status indexes.
- [x] Added recording init/upload-complete/playback endpoints with private S3/R2 signed URL support and a local development fallback.
- [x] Added cursor-based calls pagination and separated call end from recording completion.
- [x] Added a durable tenant SSE stream backed by `AppRealtimeEvent`.
- [x] Added PostgreSQL `pg_trgm` search indexes and CRM/realtime/recording indexes.
- [x] Replaced Android's invalid `PENDING_UPLOAD` value with `LOCAL_PENDING`.
- [x] Replaced the single Android pending-recording preference with a SQLite queue and network-constrained WorkManager retries.
- [x] Added dashboard SSE refresh integration for CRM and recording events.
- [ ] Complete the remaining conversations/message APIs and move all dashboard CRM reads/writes behind the dedicated API.
- [x] Added optional Redis Pub/Sub fan-out with database-outbox polling fallback.
- [ ] Configure `REDIS_URL` and production S3/R2 credentials before running multiple API instances.

### Phase 4: Production Deployment (Pending Explicit User Approval)
- [ ] Deploy `aicloser-api` to VPS `/var/www/aicloser-api` managed by PM2 process `aicloser-api` on Port 3060.
- [ ] Configure Nginx reverse proxy for `api.aicloser.com` -> `127.0.0.1:3060`.
- [ ] Push local `aicloser-api` commits to `git@github.com:devsankit/aicloser-api.git` **ONLY AFTER EXPLICIT CONFIRMATION**.
