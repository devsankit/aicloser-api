-- One licensed mobile slot and one licensed desktop slot per user.
CREATE TYPE "AppClientChannel" AS ENUM ('MOBILE', 'DESKTOP');
CREATE TYPE "AppClientSlotStatus" AS ENUM ('AVAILABLE', 'ACTIVE');
CREATE TYPE "AppClientSessionStatus" AS ENUM ('ACTIVE', 'LOGGED_OUT', 'REVOKED');

CREATE TABLE "AppClientSlot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT NOT NULL,
    "channel" "AppClientChannel" NOT NULL,
    "status" "AppClientSlotStatus" NOT NULL DEFAULT 'AVAILABLE',
    "activeSessionId" TEXT,
    "installationId" TEXT,
    "deviceId" TEXT,
    "deviceName" TEXT,
    "platform" TEXT,
    "appVersion" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),
    "lastLogoutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AppClientSlot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppClientSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "channel" "AppClientChannel" NOT NULL,
    "installationId" TEXT NOT NULL,
    "deviceId" TEXT,
    "deviceName" TEXT,
    "platform" TEXT,
    "appVersion" TEXT,
    "status" "AppClientSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "loginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "logoutAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AppClientSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppClientSlot_userId_channel_key" ON "AppClientSlot"("userId", "channel");
CREATE UNIQUE INDEX "AppClientSlot_activeSessionId_key" ON "AppClientSlot"("activeSessionId");
CREATE UNIQUE INDEX "AppClientSession_sessionId_key" ON "AppClientSession"("sessionId");
CREATE INDEX "AppClientSlot_tenantId_channel_status_idx" ON "AppClientSlot"("tenantId", "channel", "status");
CREATE INDEX "AppClientSlot_tenantId_lastActiveAt_idx" ON "AppClientSlot"("tenantId", "lastActiveAt");
CREATE INDEX "AppClientSession_userId_channel_createdAt_idx" ON "AppClientSession"("userId", "channel", "createdAt");
CREATE INDEX "AppClientSession_tenantId_lastActiveAt_idx" ON "AppClientSession"("tenantId", "lastActiveAt");
CREATE INDEX "AppClientSession_status_lastActiveAt_idx" ON "AppClientSession"("status", "lastActiveAt");

ALTER TABLE "AppClientSlot"
  ADD CONSTRAINT "AppClientSlot_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppClientSlot"
  ADD CONSTRAINT "AppClientSlot_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppClientSession"
  ADD CONSTRAINT "AppClientSession_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppClientSession"
  ADD CONSTRAINT "AppClientSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppClientSession"
  ADD CONSTRAINT "AppClientSession_slotId_fkey"
  FOREIGN KEY ("slotId") REFERENCES "AppClientSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppClientSlot"
  ADD CONSTRAINT "AppClientSlot_activeSessionId_fkey"
  FOREIGN KEY ("activeSessionId") REFERENCES "AppClientSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
