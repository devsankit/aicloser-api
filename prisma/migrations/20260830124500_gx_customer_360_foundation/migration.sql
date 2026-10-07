ALTER TABLE "gapp_webinars"
  ALTER COLUMN "priceMode" SET DEFAULT 'FREE',
  ALTER COLUMN "priceAmount" SET DEFAULT 0,
  ALTER COLUMN "phonePeEnabled" SET DEFAULT false;

ALTER TABLE "gapp_webinar_registrations"
  ADD COLUMN IF NOT EXISTS "sourceUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "attribution" JSONB,
  ADD COLUMN IF NOT EXISTS "consentContext" JSONB;

CREATE TABLE "gx_journey_events" (
  "id" TEXT NOT NULL,
  "externalEventId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventVersion" INTEGER NOT NULL DEFAULT 1,
  "source" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "appUserId" TEXT,
  "salesLeadId" TEXT,
  "salesPoolItemId" TEXT,
  "webinarRegistrationId" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "sourceReceivedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  "consentContext" JSONB,
  CONSTRAINT "gx_journey_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gx_journey_snapshots" (
  "id" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "appUserId" TEXT,
  "salesLeadId" TEXT,
  "salesPoolItemId" TEXT,
  "lifecycleStage" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "commercialState" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "engagementState" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "identityStatus" TEXT NOT NULL DEFAULT 'UNRESOLVED',
  "firstTouch" JSONB,
  "lastTouch" JSONB,
  "lastEventType" TEXT,
  "lastEventAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gx_journey_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gx_lead_identity_links" (
  "id" TEXT NOT NULL,
  "salesLeadId" TEXT NOT NULL,
  "appUserId" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "confidence" TEXT NOT NULL DEFAULT 'VERIFIED',
  "conflictStatus" TEXT NOT NULL DEFAULT 'NONE',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "linkedById" TEXT,
  "unlinkedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gx_lead_identity_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gx_lead_tasks" (
  "id" TEXT NOT NULL,
  "salesLeadId" TEXT NOT NULL,
  "ownerAgentId" TEXT,
  "createdById" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "priority" TEXT NOT NULL DEFAULT 'NORMAL',
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "dueAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gx_lead_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gx_journey_events_externalEventId_key" ON "gx_journey_events"("externalEventId");
CREATE UNIQUE INDEX "gx_journey_events_eventKey_key" ON "gx_journey_events"("eventKey");
CREATE INDEX "gx_journey_events_subjectType_subjectId_occurredAt_idx" ON "gx_journey_events"("subjectType", "subjectId", "occurredAt");
CREATE INDEX "gx_journey_events_appUserId_occurredAt_idx" ON "gx_journey_events"("appUserId", "occurredAt");
CREATE INDEX "gx_journey_events_salesLeadId_occurredAt_idx" ON "gx_journey_events"("salesLeadId", "occurredAt");
CREATE INDEX "gx_journey_events_salesPoolItemId_occurredAt_idx" ON "gx_journey_events"("salesPoolItemId", "occurredAt");
CREATE INDEX "gx_journey_events_eventType_occurredAt_idx" ON "gx_journey_events"("eventType", "occurredAt");
CREATE UNIQUE INDEX "gx_journey_snapshots_subjectType_subjectId_key" ON "gx_journey_snapshots"("subjectType", "subjectId");
CREATE INDEX "gx_journey_snapshots_appUserId_idx" ON "gx_journey_snapshots"("appUserId");
CREATE INDEX "gx_journey_snapshots_salesLeadId_idx" ON "gx_journey_snapshots"("salesLeadId");
CREATE INDEX "gx_journey_snapshots_salesPoolItemId_idx" ON "gx_journey_snapshots"("salesPoolItemId");
CREATE INDEX "gx_journey_snapshots_lifecycleStage_updatedAt_idx" ON "gx_journey_snapshots"("lifecycleStage", "updatedAt");
CREATE INDEX "gx_journey_snapshots_commercialState_updatedAt_idx" ON "gx_journey_snapshots"("commercialState", "updatedAt");
CREATE INDEX "gx_lead_identity_links_salesLeadId_isActive_idx" ON "gx_lead_identity_links"("salesLeadId", "isActive");
CREATE INDEX "gx_lead_identity_links_appUserId_isActive_idx" ON "gx_lead_identity_links"("appUserId", "isActive");
CREATE INDEX "gx_lead_identity_links_conflictStatus_idx" ON "gx_lead_identity_links"("conflictStatus");
CREATE INDEX "gx_lead_tasks_salesLeadId_status_dueAt_idx" ON "gx_lead_tasks"("salesLeadId", "status", "dueAt");
CREATE INDEX "gx_lead_tasks_ownerAgentId_status_dueAt_idx" ON "gx_lead_tasks"("ownerAgentId", "status", "dueAt");
CREATE INDEX "gx_lead_tasks_createdById_createdAt_idx" ON "gx_lead_tasks"("createdById", "createdAt");
