# AIcloser New API Catalog and Capacity Audit

Date: 2026-10-16  
Scope: New Express/Prisma API under `/api/v1`, current local database, and the UI integration contract.

## Executive decision

The backend has a real conversation API surface, but it is not yet ready to claim safe capacity for 500,000 conversations or 5,000,000 leads. The API contract is usable for the first UI integration after the access-control and message-delivery gaps below are fixed. The UI should be built against a typed API adapter and cursor/page-based data boundaries, not against the legacy Next.js conversation routes.

Do not seed 500k/5M synthetic rows into the current database. The local setup is connected to a real database, so scale validation should use an isolated benchmark database or a production-like staging clone.

## API catalog

The server mounts these routers from `src/routes/v1/index.ts`:

| Domain | Endpoints | UI responsibility |
| --- | --- | --- |
| Auth | `POST /auth/login`, `POST /auth/heartbeat`, `GET /auth/me`, `POST /auth/logout` | Session bootstrap, logout, session health |
| Leads | `GET/POST /leads`, `GET /leads/:id`, `PATCH/DELETE /leads/:id`, `GET /leads/:id/360` | Lead list, lead profile, 360 view, edit/delete |
| Lead workflow | `GET /leads/pipeline-aggregates`, `GET /leads/pool`, `GET /leads/duplicates`, `POST /leads/merge`, `POST /leads/:id/claim` | Pipeline board, pool, dedupe and merge |
| Lead activity | `GET/POST /leads/:id/notes`, `GET/POST /leads/:id/tasks`, `PATCH/DELETE /leads/:id/tasks/:taskId` | Notes, callbacks, tasks, timeline |
| Conversations | `GET /conversations` | Paginated inbox summaries with channel, stage, assignee and last message |
| Conversation history | `GET /conversations/:id/messages` | Cursor-paginated message history |
| Conversation messaging | `POST /conversations/:id/messages`, `POST /conversations/:id/read` | Send, mark read |
| Conversation media | `POST /conversations/:id/attachments`, `GET /conversations/:id/attachments/:filename` | Upload and authenticated preview/download |
| Conversation actions | `POST /:id/assign`, `PATCH /:id/stage`, `POST /:id/notes`, `POST /:id/callback` | Assignment, stage, note and follow-up actions |
| Conversation presence | `POST /:id/typing`, `GET /realtime/events` | Typing indicator and tenant-scoped realtime events |
| Conversation extras | `PATCH /:id/transport`, `POST /:id/ai-reply`, `POST /:id/drip` | Transport selection, reply draft, nurture state |
| Contacts | `GET/POST /contacts`, `GET /contacts/:id` | Contact directory and contact profile |
| Calls | `GET/POST /calls`, `POST /calls/:id/end` | Call history and call disposition |
| Recordings | `POST /recordings/init`, `POST /recordings/:id/content`, `POST /recordings/:id/complete`, `GET /recordings/:id/playback` | Recording upload and playback |
| Team | `GET /team`, `PATCH /team/:id` | Team and closer management |
| Stages | `GET /stages` | Dynamic stage definitions and UI labels |
| Custom fields | `GET/POST /custom-fields`, `PUT/DELETE /custom-fields/:id` | Configurable CRM fields |
| Payments | `GET/POST /payments`, `POST /payments/:id/approve`, `POST /payments/:id/reject` | Payment request cards and status |
| Reports | `GET /reports/summary`, `GET /reports/overview`, `GET /reports/closers` | Dashboard metrics and closer performance |
| Realtime | `GET /realtime/events` | One SSE connection per signed-in workspace |
| Integrations | Google Drive auth/status/disconnect/sync-test | Storage/recording integration settings |
| Mobile | Contacts, devices, heartbeat, offline-event sync | Mobile CRM synchronization |
| Admin | Session management, tenants and impersonation | Admin-only screens |
| Webhooks | `GET/POST /webhooks/meta` | Provider webhook verification and ingestion |

All conversation routes are mounted under `/api/v1/conversations` and currently use `authenticate` plus `enforceTenantIsolation` at router level.

## Conversation contract needed by the UI

### Inbox summary

`GET /api/v1/conversations?page=1&limit=50&search=&status=&channel=` returns a paginated array with:

- `id`, `customerName`, `customerPhone`, `status`
- `channel` / `sourceChannel`
- `stage` / `leadStage`
- `leadId`
- `assignedAgent`
- `adMetadata`
- `unreadCount`
- `lastMessage`
- `updatedAt`

This is enough for the inbox list, filters, badges and row previews. The list must not return the complete message history.

### Thread history

`GET /api/v1/conversations/:id/messages?limit=50&before=<cursor>` returns the latest page of messages and:

- `conversationId`
- customer identity and channel
- normalized `messages[]`
- `pagination.hasMore`, `pagination.nextCursor`, `pagination.totalInThread`

The UI should load this only after a conversation is selected and fetch older pages when the user scrolls upward.

### Actions

The UI action layer can map to:

| UI action | API | Current readiness |
| --- | --- | --- |
| Send reply | `POST /:id/messages` | Stores a message and emits realtime; provider delivery must be confirmed before treating as sent |
| Mark read | `POST /:id/read` | Works, but closer access guard should be added |
| Upload/preview | `POST /:id/attachments`, `GET /:id/attachments/:filename` | Authenticated route exists; closer authorization still needs tightening |
| Assign closer | `POST /:id/assign` | Route exists; role/access policy needs explicit enforcement |
| Change stage | `PATCH /:id/stage` | Route exists; closer access and stage enum validation need enforcement |
| Add note | `POST /:id/notes` | Route exists; access guard needed |
| Schedule callback | `POST /:id/callback` | Route exists; validate date and task ownership/tenant path |
| Typing | `POST /:id/typing` | Event broadcast exists; thread existence/access check is missing |
| Change transport | `PATCH /:id/transport` | Current implementation mutates `serviceSlug`; it needs tenant-safe update, channel validation and provider capability checks |
| AI draft | `POST /:id/ai-reply` | Current response is rule-based canned copy, not a production AI integration |
| Drip | `POST /:id/drip` | Current implementation changes JSON state; it does not trigger or pause a real automation worker |

## Findings before UI integration

### Critical backend blockers

1. Several conversation mutations do not call the closer access helper: attachment upload/preview, read, assign, stage, notes, callback, typing, transport, AI reply and drip. Tenant isolation alone is not enough for assigned-lead privacy.
2. `PATCH /conversations/:id/transport` checks `tenantId` only in a local variable and then updates by `{ id }`; the update itself must be tenant-scoped after a verified conversation lookup.
3. `POST /conversations/:id/messages` appends to `AppConversation.payload` and emits a realtime event, but the route does not show a WhatsApp/Instagram provider send or delivery state transition. The UI must show “queued/sent/delivered/failed” based on a real provider result.
4. The AI reply and drip endpoints are placeholders from a product perspective. Their UI controls should be feature-flagged until the actual worker/provider contracts exist.

### Data-model scaling risks

1. `AppConversation.payload` stores the entire message history as JSON. This makes every list query read full thread payloads even though the response only needs the last message. At 500k conversations this becomes a storage, IO and deserialization bottleneck.
2. `GET /conversations` performs a total count, page query, and a second lead-enrichment query for each request. The count should be optional or cached for high-volume inboxes.
3. `SalesLeadAssignment` has tenant indexes, but no composite `(tenantId, updatedAt DESC)` index. The current page query performed a sequential tenant scan and top-N sort.
4. `AppConversation` has a composite `(tenantId, updatedAt DESC)` index, which is the correct direction for inbox paging.
5. `GET /realtime/events` polls `AppRealtimeEvent` every second per SSE connection in addition to the Redis subscription. This needs a connection-capacity test and preferably a single event fan-out path before many workspaces/users are connected.
6. The global limiter is `300 requests / 15 minutes` and is currently applied to every route. A chat UI that polls or opens multiple requests per thread can hit it quickly; use endpoint-specific limits and one SSE connection instead of aggressive polling.

## Measured baseline

Environment: local API on port 3060, existing database, tenant `tenant-the-storage-test-1d01dda2`, read-only requests only.

Current counts:

- AppConversation: 311
- SalesLeadAssignment: 5,829

Database `EXPLAIN ANALYZE` observations:

| Query shape | DB execution |
| --- | ---: |
| Conversation page, tenant + updatedAt index, limit 100 | ~0.39 ms |
| Lead page, tenant filter + updatedAt sort, limit 100 | ~9.21 ms |
| Lead name/phone search with trigram indexes | ~12.11 ms |
| Conversation name/phone search | ~0.41 ms on the current 311-row table, but it used a sequential scan |

Bounded local API load test: 100 requests, concurrency 20, authenticated admin token, no writes:

| Endpoint | Success | P50 | P95 | P99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET /api/v1/conversations?page=1&limit=100` | 100/100 | 2.83 s | 3.61 s | 3.67 s | 3.82 s |
| `GET /api/v1/leads?page=1&limit=100` | 100/100 | 0.75 s | 1.25 s | 1.28 s | 1.28 s |

The test then exhausted the global `300/15 min` limiter. That is an observed operational limit, not a 500k/5M capacity result.

## Capacity verdict

### 500,000 conversations

Not safe to claim readiness yet. Pagination and the conversation ordering index are good foundations, but the JSON payload read, enrichment query, full count, attachment/message storage model and current list endpoint concurrency need redesign/benchmarking on a staging dataset.

### 5,000,000 leads

Not ready with the current index set. Before scale testing, add and verify:

- `(tenantId, updatedAt DESC, id)` for lead list paging;
- tenant-prefixed search strategy or a dedicated search index;
- optional/cached totals instead of a count on every page;
- keyset pagination for deep pages instead of large offsets;
- database partitioning or tenant sharding only after a staging benchmark proves it is needed.

## UI architecture to build against these APIs

Use a stable shell with replaceable data adapters:

```text
AppShell
├── WorkspaceHeader (tenant, user, theme, notifications)
├── PrimaryNav
└── RouteSurface
    ├── InboxScreen
    │   ├── InboxToolbar (search, channel, stage, assignee, unread)
    │   ├── ConversationList (paged summaries only)
    │   ├── ConversationThread (cursor history + composer)
    │   └── LeadContextPanel (360 summary, stage, assignee, notes, tasks, calls, payments)
    ├── LeadsScreen
    ├── PipelineScreen
    ├── ReportsScreen
    └── SettingsScreen
```

The chat screen should be split into these state boundaries:

- `conversationListQuery`: filters, page/cursor, loading, error, total/hasMore;
- `conversationDetailQuery`: selected ID, message pages, loading older messages;
- `leadContextQuery`: 360 data loaded only for the selected lead;
- `conversationActions`: optimistic UI with rollback and server error state;
- `realtimeConnection`: one tenant SSE connection that invalidates/patches affected queries;
- `featureCapabilities`: hides AI, drip, payments or channel actions until their API capability is confirmed.

This lets new APIs add a panel or action without replacing the shell or changing the inbox list contract.

## Next implementation order

1. Fix the critical access and tenant-safe mutation guards.
2. Add the lead composite paging index and benchmark on an isolated staging clone.
3. Separate conversation summary storage from message history.
4. Finish the typed API adapter so the UI stops calling legacy `/api/conversations` routes.
5. Build the new inbox shell against summaries + cursor history.
6. Add lead 360 panels progressively: stage/assignee, notes/tasks, calls, payments, custom fields.
7. Add SSE invalidation and reconnect/backoff behavior.
8. Run a staging load test with generated 500k conversation / 5M lead data and publish P50/P95/P99, throughput, error rate, DB CPU, memory and pool saturation.

