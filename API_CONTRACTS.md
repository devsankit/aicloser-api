# AIcloser Dedicated Backend API (`aicloser-api`) Contracts

**Version**: `v1`  
**Base URL**: `https://api.aicloser.com/api/v1` (Local Dev: `http://127.0.0.1:3060/api/v1`)  
**Database**: Dedicated standalone PostgreSQL `aicloser`  
**Tenant Boundary**: Every operational entity is strictly partitioned by `tenantId`.

---

## 1. Security & Multi-Tenant Isolation Architecture

### 1.1 Tenant Boundary Enforcement
- **Root Ownership Boundary**: Every entity (`SalesLeadAssignment`, `SalesMobileCall`, `MarketingContact`, `AppConversation`, `SalesDeal`, `SalesActivityLog`) contains a mandatory, indexed `tenantId`.
- **Session-Derived Scope**: The tenant scope is **ALWAYS** derived server-side from the authenticated JWT session (`req.user.tenantId`).
- **Zero Client Spoofing**: Any request payload or query parameter containing a foreign `tenantId` is immediately rejected with `403 Forbidden` (`TenantIsolationViolation`).
- **Super Admin Audit**: Cross-tenant administrative access is allowed only for `SUPER_ADMIN` via the explicit header `x-target-tenant-id`, and every access is written to the audit log.

### 1.2 Authentication Headers & Cookies
```http
Authorization: Bearer <jwt_session_token>
# OR
Cookie: aicloser_token=<jwt_session_token>; gx_session=<jwt_session_token>
```

---

## 2. API Endpoints Specification

### 2.1 Health Check
- **`GET /health`**
  - **Auth**: None
  - **Response `200 OK`**:
    ```json
    {
      "status": "pass",
      "timestamp": "2026-10-07T12:00:00.000Z",
      "uptimeSeconds": 1420,
      "service": "aicloser-api",
      "version": "1.0.0",
      "checks": {
        "database": {
          "status": "healthy",
          "latencyMs": 4
        }
      }
    }
    ```

---

### 2.2 Authentication (`/api/v1/auth`)

#### `POST /api/v1/auth/login`
- **Body**:
  ```json
  {
    "identifier": "+919876543210", // Phone, email, or alias
    "password": "user_password"
  }
  ```
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "data": {
      "token": "eyJhbGciOi...",
      "user": {
        "userId": "user-sales-agent-0ead1704",
        "role": "SALES_AGENT",
        "tenantId": "tenant-agency-8deafdbb",
        "displayName": "Anshita Gaur",
        "phone": "+919876543210",
        "email": "agent@agency.com"
      }
    }
  }
  ```

#### `GET /api/v1/auth/me`
- **Auth**: Required
- **Response `200 OK`**: Current authenticated user and tenant session details.

#### `POST /api/v1/auth/logout`
- **Auth**: None
- **Response `200 OK`**: Clears session cookies.

---

### 2.3 Leads Management (`/api/v1/leads`)

#### `GET /api/v1/leads`
- **Auth**: Required (Tenant Scoped)
- **Query Parameters**:
  - `page` (number, default: 1)
  - `limit` (number, default: 25, max: 100)
  - `stage` (SalesLeadStage: `NEW`, `ASSIGNED`, `CONTACTED`, `INTERESTED`, `CLOSED_WON`, etc.)
  - `search` (string: searches name, phone, email)
  - `assignedAgentId` (string)
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "data": {
      "leads": [
        {
          "id": "cmunqcdst15g3a4jpkuf8sjit",
          "tenantId": "tenant-agency-8deafdbb",
          "customerName": "Rohan Verma",
          "customerPhone": "+919876543211",
          "stage": "NEW",
          "priority": "normal",
          "assignedAgent": {
            "id": "cms1gc6tk0000tqjplhlhcvys",
            "agentCode": "GX-ANSHITA-20E6AE",
            "user": { "displayName": "Anshita Gaur" }
          },
          "createdAt": "2026-10-07T10:00:00.000Z"
        }
      ],
      "pagination": {
        "total": 703,
        "page": 1,
        "limit": 25,
        "totalPages": 29
      }
    }
  }
  ```

#### `POST /api/v1/leads`
- **Auth**: Required (Tenant Scoped)
- **Body**:
  ```json
  {
    "customerName": "Vikram Singh",
    "customerPhone": "+919876543222",
    "customerEmail": "vikram@example.com",
    "assignedAgentId": "cms1gc6tk0000tqjplhlhcvys",
    "serviceInterest": "B2B SaaS Sales",
    "priority": "high",
    "notes": "Ad lead qualified via WhatsApp",
    "stage": "NEW",
    "budgetAmount": 50000
  }
  ```
- **Response `201 Created`**: Lead record with `tenantId` permanently attached.

#### `GET /api/v1/leads/:id`
- **Auth**: Required (Tenant Scoped)
- **Response `200 OK`**: Lead details with calls history and activity timeline. Returns `404` if the lead belongs to another tenant.

#### `PATCH /api/v1/leads/:id`
- **Auth**: Required (Tenant Scoped)
- **Body**: Stage, priority, notes, follow-up date, or reassignment. Returns `404` if tenant mismatch.

#### `DELETE /api/v1/leads/:id`
- **Auth**: Required (Tenant Scoped)
- **Response `200 OK`**: Soft/hard delete scoped to tenant.

---

### 2.4 Contacts Directory & Deduplication (`/api/v1/contacts`)

#### `GET /api/v1/contacts`
- **Auth**: Required (Tenant Scoped)
- **Query Parameters**: `page`, `limit`, `search`, `tag`.

#### `POST /api/v1/contacts`
- **Auth**: Required (Tenant Scoped)
- **Body**:
  ```json
  {
    "fullName": "Priya Sharma",
    "e164Phone": "+919876543333",
    "email": "priya@example.com",
    "tags": ["vip", "inbound"],
    "source": "WHATSAPP_INGRESS"
  }
  ```
- **Behavior**:
  - **Tenant Deduplication**: If `+919876543333` already exists in this tenant, returns the existing record with `deduplicated: true`.
  - **Cross-Tenant Isolation**: If `+919876543333` exists in Tenant B, Tenant A creates its own independent contact without conflict (`@@unique([tenantId, e164Phone])`).

---

### 2.5 Telephony & Calls (`/api/v1/calls`)

#### `GET /api/v1/calls`
- **Auth**: Required (Tenant Scoped)
- **Query Parameters**: `page`, `limit`, `phoneNumber`, `agentId`.

#### `POST /api/v1/calls`
- **Auth**: Required (Tenant Scoped)
- **Body**:
  ```json
  {
    "assignmentId": "cmunqcdst15g3a4jpkuf8sjit",
    "agentId": "cms1gc6tk0000tqjplhlhcvys",
    "phoneNumber": "+919876543211",
    "direction": "OUTBOUND",
    "status": "COMPLETED",
    "durationSeconds": 185,
    "outcome": "CONNECTED_INTERESTED",
    "note": "Client requested proposal over WhatsApp"
  }
  ```

---

### 2.6 Multi-Channel Conversations (`/api/v1/conversations`)

#### `GET /api/v1/conversations`
- **Auth**: Required (Tenant Scoped)
- **Query Parameters**: `page`, `limit`, `status`, `customerPhone`.

#### `GET /api/v1/conversations/:id`
- **Auth**: Required (Tenant Scoped)
  - **Response `200 OK`**: Conversation payload with status, channel, and message history.

### 2.7 Recording Uploads and Realtime Sync (`/api/v1/recordings`, `/api/v1/realtime`)

#### `POST /api/v1/recordings/init`
- **Auth**: Required (Tenant Scoped)
- **Body**: `callId`, `clientUploadId`, optional `deviceId`, `mimeType`, `sizeBytes`, and `durationSeconds`.
- **Behavior**: Creates or returns the same upload for a repeated `clientUploadId`. The response contains a private signed S3/R2 PUT URL when object storage is configured. Local development returns an API upload URL.

#### `POST /api/v1/recordings/:id/content`
- **Auth**: Required (Tenant Scoped)
- **Behavior**: Local-development fallback for raw audio bytes. Production object storage uploads must use the signed URL from `init`.

#### `POST /api/v1/recordings/:id/complete`
- **Auth**: Required (Tenant Scoped)
- **Behavior**: Verifies the object exists, marks the upload `UPLOADED`, and updates the call recording state atomically.

#### `GET /api/v1/recordings/:id/playback`
- **Auth**: Required (Tenant Scoped)
- **Response**: A short-lived signed playback URL for S3/R2 or a private streamed response for local development.

#### `GET /api/v1/realtime/events`
- **Auth**: Required (Tenant Scoped)
- **Response**: SSE stream with durable outbox events and reconnect cursor support through the `since` timestamp.

#### Mobile sync endpoints
- `POST /api/v1/mobile/devices` registers or reactivates the authenticated agent's device.
- `POST /api/v1/mobile/devices/:deviceId/heartbeat` updates device liveness within the current tenant.
- `POST /api/v1/mobile/offline-events/sync` accepts up to 100 idempotent events per batch. `CALL_END` is applied exactly once and acknowledged with its client idempotency key.

Call recording states are restricted to `NONE`, `RECORDING_UNAVAILABLE`, `LOCAL_PENDING`, `UPLOADING`, `UPLOADED`, and `FAILED`. `PENDING_UPLOAD` is not a valid server state.

---

### 2.8 Super Admin Cross-Tenant Management (`/api/v1/super-admin`)

#### `GET /api/v1/super-admin/tenants`
- **Auth**: `SUPER_ADMIN` only
- **Response `200 OK`**: List of all workspaces with active user and lead counts.

#### `POST /api/v1/super-admin/tenants/:tenantId/impersonate`
- **Auth**: `SUPER_ADMIN` only
- **Response `200 OK`**: Generates an audited, short-lived session token explicitly scoped to `:tenantId`.

---

### 2.9 Meta Webhooks Ingress (`/api/v1/webhooks/meta`)

#### `GET /api/v1/webhooks/meta`
- **Auth**: Meta Hub Verify Handshake (`hub.challenge`, `hub.verify_token`).

#### `POST /api/v1/webhooks/meta`
- **Auth**: Verified via header `X-Hub-Signature-256` using HMAC SHA-256 with `WEBHOOK_APP_SECRET`.
- **Behavior**: Routes inbound WhatsApp messages directly into the tenant owning the target `phoneNumberId`.

---

## 3. Standard Error Contract

```json
{
  "success": false,
  "error": "TenantIsolationViolation", // or ValidationError, Unauthorized, Forbidden, NotFound, TooManyRequests
  "message": "Access denied: Client cannot query or mutate data outside their assigned workspace",
  "details": []
}
```
