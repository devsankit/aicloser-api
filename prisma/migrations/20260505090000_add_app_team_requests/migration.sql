-- Persisted app-level agency/freelancer team request circuit.
CREATE TABLE IF NOT EXISTS "AppTeamRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "agencyUserId" TEXT NOT NULL,
  "agencyName" TEXT NOT NULL,
  "freelancerId" TEXT NOT NULL,
  "freelancerName" TEXT NOT NULL,
  "roleType" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "offeredTerms" TEXT NOT NULL,
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "respondedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppTeamRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AppTeamRequest_tenantId_idx" ON "AppTeamRequest"("tenantId");
CREATE INDEX IF NOT EXISTS "AppTeamRequest_freelancerId_idx" ON "AppTeamRequest"("freelancerId");
CREATE INDEX IF NOT EXISTS "AppTeamRequest_status_idx" ON "AppTeamRequest"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "AppTeamRequest_active_tenant_freelancer_key"
  ON "AppTeamRequest"("tenantId", "freelancerId")
  WHERE "status" IN ('SENT', 'PENDING');

CREATE TABLE IF NOT EXISTS "AppTeamMembership" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "agencyUserId" TEXT NOT NULL,
  "agencyName" TEXT NOT NULL,
  "freelancerId" TEXT NOT NULL,
  "freelancerName" TEXT NOT NULL,
  "roleType" TEXT NOT NULL,
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" TEXT NOT NULL,
  "acceptedRequestId" TEXT,
  "removedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppTeamMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AppTeamMembership_tenantId_freelancerId_key" ON "AppTeamMembership"("tenantId", "freelancerId");
CREATE INDEX IF NOT EXISTS "AppTeamMembership_tenantId_idx" ON "AppTeamMembership"("tenantId");
CREATE INDEX IF NOT EXISTS "AppTeamMembership_freelancerId_idx" ON "AppTeamMembership"("freelancerId");
CREATE INDEX IF NOT EXISTS "AppTeamMembership_status_idx" ON "AppTeamMembership"("status");
