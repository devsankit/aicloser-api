-- Persisted app-level delivery submission and revision circuit.
CREATE TABLE IF NOT EXISTS "AppDeliverySubmission" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "freelancerId" TEXT NOT NULL,
  "freelancerName" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "deliveryLinks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "notes" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "reviewedById" TEXT,
  "reviewedByRole" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppDeliverySubmission_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AppDeliverySubmission_assignmentId_idx" ON "AppDeliverySubmission"("assignmentId");
CREATE INDEX IF NOT EXISTS "AppDeliverySubmission_tenantId_idx" ON "AppDeliverySubmission"("tenantId");
CREATE INDEX IF NOT EXISTS "AppDeliverySubmission_freelancerId_idx" ON "AppDeliverySubmission"("freelancerId");
CREATE INDEX IF NOT EXISTS "AppDeliverySubmission_status_idx" ON "AppDeliverySubmission"("status");

CREATE TABLE IF NOT EXISTS "AppRevisionRequest" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "submissionId" TEXT,
  "tenantId" TEXT NOT NULL,
  "freelancerId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "notes" TEXT NOT NULL,
  "dueDate" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "requestedByRole" TEXT NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppRevisionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AppRevisionRequest_assignmentId_idx" ON "AppRevisionRequest"("assignmentId");
CREATE INDEX IF NOT EXISTS "AppRevisionRequest_submissionId_idx" ON "AppRevisionRequest"("submissionId");
CREATE INDEX IF NOT EXISTS "AppRevisionRequest_tenantId_idx" ON "AppRevisionRequest"("tenantId");
CREATE INDEX IF NOT EXISTS "AppRevisionRequest_freelancerId_idx" ON "AppRevisionRequest"("freelancerId");
CREATE INDEX IF NOT EXISTS "AppRevisionRequest_status_idx" ON "AppRevisionRequest"("status");
