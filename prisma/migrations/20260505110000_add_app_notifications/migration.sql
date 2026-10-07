CREATE TABLE "AppNotification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNREAD',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppNotification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AppNotification_userId_status_idx" ON "AppNotification"("userId", "status");
CREATE INDEX "AppNotification_tenantId_idx" ON "AppNotification"("tenantId");
CREATE INDEX "AppNotification_type_idx" ON "AppNotification"("type");
CREATE INDEX "AppNotification_entityType_entityId_idx" ON "AppNotification"("entityType", "entityId");
CREATE INDEX "AppNotification_createdAt_idx" ON "AppNotification"("createdAt");
