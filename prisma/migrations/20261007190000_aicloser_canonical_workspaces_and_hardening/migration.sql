-- CreateTable AicloserWorkspace
CREATE TABLE IF NOT EXISTS "AicloserWorkspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "ownerUserId" TEXT,
    "ownerEmail" TEXT,
    "ownerPhone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "planTier" TEXT NOT NULL DEFAULT 'PRO',
    "maxSeats" INTEGER NOT NULL DEFAULT 5,
    "settings" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AicloserWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AicloserWorkspace_slug_key" ON "AicloserWorkspace"("slug");
CREATE INDEX IF NOT EXISTS "AicloserWorkspace_status_idx" ON "AicloserWorkspace"("status");
CREATE INDEX IF NOT EXISTS "AicloserWorkspace_createdAt_idx" ON "AicloserWorkspace"("createdAt");

-- Backfill AicloserWorkspace from AppAuthUser (preserving all existing tenant IDs)
INSERT INTO "AicloserWorkspace" ("id", "name", "slug", "ownerUserId", "ownerEmail", "ownerPhone", "status", "createdAt", "updatedAt")
SELECT DISTINCT ON (u."tenantId")
    u."tenantId" AS "id",
    COALESCE(u."displayName" || '''s Workspace', u."tenantId") AS "name",
    LOWER(REGEXP_REPLACE(u."tenantId", '[^a-zA-Z0-9]', '-', 'g')) AS "slug",
    u."id" AS "ownerUserId",
    u."email" AS "ownerEmail",
    u."phone" AS "ownerPhone",
    'ACTIVE' AS "status",
    u."createdAt" AS "createdAt",
    CURRENT_TIMESTAMP AS "updatedAt"
FROM "AppAuthUser" u
WHERE u."tenantId" IS NOT NULL
ORDER BY u."tenantId", CASE WHEN u."role" IN ('ADMIN', 'SUPER_ADMIN') THEN 0 ELSE 1 END, u."createdAt" ASC
ON CONFLICT ("id") DO NOTHING;

-- Backfill missing workspace IDs from operational tables
INSERT INTO "AicloserWorkspace" ("id", "name", "slug", "status", "createdAt", "updatedAt")
SELECT DISTINCT
    s."tenantId" AS "id",
    s."tenantId" || ' Workspace' AS "name",
    LOWER(REGEXP_REPLACE(s."tenantId", '[^a-zA-Z0-9]', '-', 'g')) AS "slug",
    'ACTIVE' AS "status",
    CURRENT_TIMESTAMP AS "createdAt",
    CURRENT_TIMESTAMP AS "updatedAt"
FROM (
    SELECT "tenantId" FROM "SalesLeadAssignment" WHERE "tenantId" IS NOT NULL
    UNION
    SELECT "tenantId" FROM "AppConversation" WHERE "tenantId" IS NOT NULL
    UNION
    SELECT "tenantId" FROM "MarketingContact" WHERE "tenantId" IS NOT NULL
    UNION
    SELECT "tenantId" FROM "SalesAgentProfile" WHERE "tenantId" IS NOT NULL
    UNION
    SELECT "tenantId" FROM "SalesMobileCall" WHERE "tenantId" IS NOT NULL
    UNION
    SELECT "tenantId" FROM "SalesLeadPoolItem" WHERE "tenantId" IS NOT NULL
    UNION
    SELECT "tenantId" FROM "SalesLeadTimelineEntry" WHERE "tenantId" IS NOT NULL
    UNION
    SELECT "tenantId" FROM "SalesActivityLog" WHERE "tenantId" IS NOT NULL
    UNION
    SELECT "tenantId" FROM "SalesMobileDevice" WHERE "tenantId" IS NOT NULL
) s
ON CONFLICT ("id") DO NOTHING;

-- Enforce NOT NULL on tenantId columns in core tables
ALTER TABLE "SalesLeadAssignment" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SalesAgentProfile" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SalesMobileCall" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SalesLeadTimelineEntry" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SalesActivityLog" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SalesLeadPoolItem" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SalesMobileDevice" ALTER COLUMN "tenantId" SET NOT NULL;

-- Add Foreign Key Constraints to canonical AicloserWorkspace
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesLeadAssignment_tenantId_fkey') THEN
        ALTER TABLE "SalesLeadAssignment" ADD CONSTRAINT "SalesLeadAssignment_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesAgentProfile_tenantId_fkey') THEN
        ALTER TABLE "SalesAgentProfile" ADD CONSTRAINT "SalesAgentProfile_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesMobileCall_tenantId_fkey') THEN
        ALTER TABLE "SalesMobileCall" ADD CONSTRAINT "SalesMobileCall_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesLeadTimelineEntry_tenantId_fkey') THEN
        ALTER TABLE "SalesLeadTimelineEntry" ADD CONSTRAINT "SalesLeadTimelineEntry_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesActivityLog_tenantId_fkey') THEN
        ALTER TABLE "SalesActivityLog" ADD CONSTRAINT "SalesActivityLog_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesLeadPoolItem_tenantId_fkey') THEN
        ALTER TABLE "SalesLeadPoolItem" ADD CONSTRAINT "SalesLeadPoolItem_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesMobileDevice_tenantId_fkey') THEN
        ALTER TABLE "SalesMobileDevice" ADD CONSTRAINT "SalesMobileDevice_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketingContact_tenantId_fkey') THEN
        ALTER TABLE "MarketingContact" ADD CONSTRAINT "MarketingContact_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AppConversation_tenantId_fkey') THEN
        ALTER TABLE "AppConversation" ADD CONSTRAINT "AppConversation_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AppAuthUser_tenantId_fkey') THEN
        ALTER TABLE "AppAuthUser" ADD CONSTRAINT "AppAuthUser_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- Compound Indexes & Tenant Guardrails
CREATE INDEX IF NOT EXISTS "SalesLeadAssignment_tenantId_assignedAgentId_idx" ON "SalesLeadAssignment"("tenantId", "assignedAgentId");
CREATE INDEX IF NOT EXISTS "SalesMobileCall_tenantId_agentId_idx" ON "SalesMobileCall"("tenantId", "agentId");
CREATE INDEX IF NOT EXISTS "MarketingContact_tenantId_createdAt_idx" ON "MarketingContact"("tenantId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "MarketingContact_tenantId_e164Phone_key" ON "MarketingContact"("tenantId", "e164Phone");
CREATE INDEX IF NOT EXISTS "AppConversation_tenantId_status_idx" ON "AppConversation"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "AppConversation_tenantId_customerPhone_idx" ON "AppConversation"("tenantId", "customerPhone");
