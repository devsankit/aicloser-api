-- Durable recording upload state and search/sync indexes for the unified web/mobile CRM.
CREATE TYPE "CallRecordingUploadStatus" AS ENUM ('LOCAL_PENDING', 'UPLOADING', 'UPLOADED', 'FAILED');

CREATE TABLE "CallRecordingUpload" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "deviceId" TEXT,
    "clientUploadId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "status" "CallRecordingUploadStatus" NOT NULL DEFAULT 'LOCAL_PENDING',
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "durationSeconds" INTEGER,
    "checksum" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CallRecordingUpload_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallRecordingUpload_tenantId_clientUploadId_key" ON "CallRecordingUpload"("tenantId", "clientUploadId");
CREATE INDEX "CallRecordingUpload_tenantId_status_updatedAt_idx" ON "CallRecordingUpload"("tenantId", "status", "updatedAt");
CREATE INDEX "CallRecordingUpload_callId_createdAt_idx" ON "CallRecordingUpload"("callId", "createdAt");
CREATE INDEX "CallRecordingUpload_deviceId_status_updatedAt_idx" ON "CallRecordingUpload"("deviceId", "status", "updatedAt");

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "SalesLeadAssignment_customerName_trgm_idx" ON "SalesLeadAssignment" USING GIN ("customerName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "SalesLeadAssignment_customerPhone_trgm_idx" ON "SalesLeadAssignment" USING GIN ("customerPhone" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "SalesLeadAssignment_customerEmail_trgm_idx" ON "SalesLeadAssignment" USING GIN ("customerEmail" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "MarketingContact_fullName_trgm_idx" ON "MarketingContact" USING GIN ("fullName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "MarketingContact_e164Phone_trgm_idx" ON "MarketingContact" USING GIN ("e164Phone" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "MarketingContact_email_trgm_idx" ON "MarketingContact" USING GIN ("email" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "AppConversation_customerPhone_trgm_idx" ON "AppConversation" USING GIN ("customerPhone" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "SalesMobileCall_tenantId_recordingStatus_updatedAt_idx" ON "SalesMobileCall"("tenantId", "recordingStatus", "updatedAt");
CREATE INDEX IF NOT EXISTS "SalesMobileCall_tenantId_agentId_startedAt_idx" ON "SalesMobileCall"("tenantId", "agentId", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "SalesMobileOfflineEvent_tenantId_status_createdAt_idx" ON "SalesMobileOfflineEvent"("tenantId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "AppRealtimeEvent_tenantId_createdAt_id_idx" ON "AppRealtimeEvent"("tenantId", "createdAt" DESC, "id");
CREATE INDEX IF NOT EXISTS "AppRealtimeEvent_topic_tenantId_createdAt_id_idx" ON "AppRealtimeEvent"("topic", "tenantId", "createdAt" DESC, "id");
CREATE INDEX IF NOT EXISTS "AppConversation_tenantId_updatedAt_id_idx" ON "AppConversation"("tenantId", "updatedAt" DESC, "id");
