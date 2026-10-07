-- Persisted app-level marketplace task, application, and assignment circuit.
CREATE TABLE IF NOT EXISTS "AppMarketplaceTask" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "agencyUserId" TEXT NOT NULL,
  "agencyName" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "brief" TEXT NOT NULL,
  "budgetAmount" INTEGER NOT NULL,
  "deadline" TIMESTAMP(3),
  "requiredSkills" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "referenceLinks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "visibility" TEXT NOT NULL,
  "applicationDeadline" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "assignedFreelancerId" TEXT,
  "acceptedApplicationId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppMarketplaceTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AppMarketplaceTask_tenantId_idx" ON "AppMarketplaceTask"("tenantId");
CREATE INDEX IF NOT EXISTS "AppMarketplaceTask_status_idx" ON "AppMarketplaceTask"("status");
CREATE INDEX IF NOT EXISTS "AppMarketplaceTask_visibility_idx" ON "AppMarketplaceTask"("visibility");
CREATE INDEX IF NOT EXISTS "AppMarketplaceTask_assignedFreelancerId_idx" ON "AppMarketplaceTask"("assignedFreelancerId");

CREATE TABLE IF NOT EXISTS "AppTaskApplication" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "freelancerId" TEXT NOT NULL,
  "freelancerName" TEXT NOT NULL,
  "proposal" TEXT NOT NULL,
  "quotedAmount" INTEGER NOT NULL,
  "estimatedTurnaround" TEXT NOT NULL,
  "portfolioReference" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppTaskApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AppTaskApplication_taskId_freelancerId_key" ON "AppTaskApplication"("taskId", "freelancerId");
CREATE INDEX IF NOT EXISTS "AppTaskApplication_taskId_idx" ON "AppTaskApplication"("taskId");
CREATE INDEX IF NOT EXISTS "AppTaskApplication_tenantId_idx" ON "AppTaskApplication"("tenantId");
CREATE INDEX IF NOT EXISTS "AppTaskApplication_freelancerId_idx" ON "AppTaskApplication"("freelancerId");
CREATE INDEX IF NOT EXISTS "AppTaskApplication_status_idx" ON "AppTaskApplication"("status");

CREATE TABLE IF NOT EXISTS "AppAssignmentRecord" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "agencyUserId" TEXT NOT NULL,
  "agencyName" TEXT NOT NULL,
  "freelancerId" TEXT NOT NULL,
  "freelancerName" TEXT NOT NULL,
  "managerId" TEXT,
  "clientContactId" TEXT,
  "taskId" TEXT,
  "applicationId" TEXT,
  "title" TEXT NOT NULL,
  "brief" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "deadline" TIMESTAMP(3),
  "budgetAmount" INTEGER NOT NULL,
  "priority" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "revisionStatus" TEXT,
  "deliveryLinks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "notes" TEXT NOT NULL,
  "chatThreadId" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppAssignmentRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AppAssignmentRecord_tenantId_idx" ON "AppAssignmentRecord"("tenantId");
CREATE INDEX IF NOT EXISTS "AppAssignmentRecord_freelancerId_idx" ON "AppAssignmentRecord"("freelancerId");
CREATE INDEX IF NOT EXISTS "AppAssignmentRecord_taskId_idx" ON "AppAssignmentRecord"("taskId");
CREATE INDEX IF NOT EXISTS "AppAssignmentRecord_applicationId_idx" ON "AppAssignmentRecord"("applicationId");
CREATE INDEX IF NOT EXISTS "AppAssignmentRecord_status_idx" ON "AppAssignmentRecord"("status");
