DO $$ BEGIN
  CREATE TYPE "SalesMobilePlatform" AS ENUM ('ANDROID');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesMobileCallDirection" AS ENUM ('INBOUND', 'OUTBOUND');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesMobileCallStatus" AS ENUM ('INITIATED', 'RINGING', 'CONNECTED', 'COMPLETED', 'MISSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesMobileRecordingStatus" AS ENUM ('NONE', 'RECORDING_UNAVAILABLE', 'LOCAL_PENDING', 'UPLOADING', 'UPLOADED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesMobileSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesMobileLeadPackStatus" AS ENUM ('OFFERED', 'CLAIMED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE "SalesMobileDevice" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "deviceName" TEXT NOT NULL,
  "platform" "SalesMobilePlatform" NOT NULL DEFAULT 'ANDROID',
  "appVersion" TEXT,
  "manufacturer" TEXT,
  "model" TEXT,
  "androidVersion" TEXT,
  "simLabel" TEXT,
  "officeSimNumber" TEXT,
  "recordingCapability" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "recordingEnabled" BOOLEAN NOT NULL DEFAULT false,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesMobileDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesMobileCall" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "deviceId" TEXT,
  "phoneNumber" TEXT NOT NULL,
  "direction" "SalesMobileCallDirection" NOT NULL DEFAULT 'OUTBOUND',
  "status" "SalesMobileCallStatus" NOT NULL DEFAULT 'INITIATED',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "connectedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "durationSeconds" INTEGER,
  "outcome" TEXT,
  "note" TEXT,
  "nextFollowUpAt" TIMESTAMP(3),
  "recordingStatus" "SalesMobileRecordingStatus" NOT NULL DEFAULT 'NONE',
  "recordingPath" TEXT,
  "recordingMimeType" TEXT,
  "recordingSizeBytes" INTEGER,
  "recordingError" TEXT,
  "noteRequired" BOOLEAN NOT NULL DEFAULT true,
  "noteSubmitted" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesMobileCall_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesMobileOfflineEvent" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "deviceId" TEXT,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "SalesMobileSyncStatus" NOT NULL DEFAULT 'PENDING',
  "result" JSONB,
  "error" TEXT,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesMobileOfflineEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesMobileLeadPack" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "status" "SalesMobileLeadPackStatus" NOT NULL DEFAULT 'OFFERED',
  "leadPoolIds" TEXT[],
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesMobileLeadPack_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SalesMobileDevice_deviceId_key" ON "SalesMobileDevice"("deviceId");
CREATE INDEX "SalesMobileDevice_agentId_isActive_idx" ON "SalesMobileDevice"("agentId", "isActive");
CREATE INDEX "SalesMobileDevice_lastSeenAt_idx" ON "SalesMobileDevice"("lastSeenAt");
CREATE INDEX "SalesMobileCall_assignmentId_startedAt_idx" ON "SalesMobileCall"("assignmentId", "startedAt");
CREATE INDEX "SalesMobileCall_agentId_noteRequired_noteSubmitted_idx" ON "SalesMobileCall"("agentId", "noteRequired", "noteSubmitted");
CREATE INDEX "SalesMobileCall_deviceId_startedAt_idx" ON "SalesMobileCall"("deviceId", "startedAt");
CREATE UNIQUE INDEX "SalesMobileOfflineEvent_idempotencyKey_key" ON "SalesMobileOfflineEvent"("idempotencyKey");
CREATE INDEX "SalesMobileOfflineEvent_agentId_status_createdAt_idx" ON "SalesMobileOfflineEvent"("agentId", "status", "createdAt");
CREATE INDEX "SalesMobileOfflineEvent_deviceId_status_idx" ON "SalesMobileOfflineEvent"("deviceId", "status");
CREATE INDEX "SalesMobileLeadPack_agentId_status_idx" ON "SalesMobileLeadPack"("agentId", "status");
CREATE INDEX "SalesMobileLeadPack_expiresAt_status_idx" ON "SalesMobileLeadPack"("expiresAt", "status");

ALTER TABLE "SalesMobileDevice" ADD CONSTRAINT "SalesMobileDevice_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesMobileCall" ADD CONSTRAINT "SalesMobileCall_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "SalesLeadAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesMobileCall" ADD CONSTRAINT "SalesMobileCall_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesMobileCall" ADD CONSTRAINT "SalesMobileCall_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "SalesMobileDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesMobileOfflineEvent" ADD CONSTRAINT "SalesMobileOfflineEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesMobileOfflineEvent" ADD CONSTRAINT "SalesMobileOfflineEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "SalesMobileDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesMobileLeadPack" ADD CONSTRAINT "SalesMobileLeadPack_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
