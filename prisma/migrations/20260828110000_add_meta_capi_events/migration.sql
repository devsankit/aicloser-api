ALTER TABLE "SalesLeadPoolItem" ADD COLUMN IF NOT EXISTS "conversationId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "SalesLeadPoolItem_conversationId_key" ON "SalesLeadPoolItem"("conversationId");

CREATE TABLE IF NOT EXISTS "meta_conversion_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "tenantId" TEXT,
    "conversationId" TEXT,
    "externalMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "traceId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "meta_conversion_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "meta_conversion_events_eventId_key" ON "meta_conversion_events"("eventId");
CREATE INDEX IF NOT EXISTS "meta_conversion_events_status_updatedAt_idx" ON "meta_conversion_events"("status", "updatedAt");
CREATE INDEX IF NOT EXISTS "meta_conversion_events_source_createdAt_idx" ON "meta_conversion_events"("source", "createdAt");
CREATE INDEX IF NOT EXISTS "meta_conversion_events_conversationId_idx" ON "meta_conversion_events"("conversationId");
CREATE INDEX IF NOT EXISTS "meta_conversion_events_externalMessageId_idx" ON "meta_conversion_events"("externalMessageId");
