CREATE TABLE IF NOT EXISTS "AgencySitesSsoHandoff" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "agencySlug" TEXT NOT NULL,
    "redirectPath" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgencySitesSsoHandoff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgencySitesSsoHandoff_codeHash_key" ON "AgencySitesSsoHandoff"("codeHash");
CREATE INDEX IF NOT EXISTS "AgencySitesSsoHandoff_expiresAt_idx" ON "AgencySitesSsoHandoff"("expiresAt");
CREATE INDEX IF NOT EXISTS "AgencySitesSsoHandoff_userId_expiresAt_idx" ON "AgencySitesSsoHandoff"("userId", "expiresAt");
CREATE INDEX IF NOT EXISTS "AgencySitesSsoHandoff_tenantId_expiresAt_idx" ON "AgencySitesSsoHandoff"("tenantId", "expiresAt");
