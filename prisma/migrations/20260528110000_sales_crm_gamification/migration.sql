-- Extend native sales with a real CRM queue, referral attribution events, goals, and rewards.

CREATE TYPE "SalesLeadPoolStatus" AS ENUM ('OPEN', 'CLAIMED', 'ARCHIVED');
CREATE TYPE "SalesReferralEventType" AS ENUM ('PRICING_VIEW', 'SIGNUP_STARTED', 'SIGNUP_VERIFIED', 'PAYMENT_STARTED', 'PAYMENT_SUCCESS', 'DEAL_CREATED');
CREATE TYPE "SalesGoalMetric" AS ENUM ('PAID_REVENUE', 'CLOSED_DEALS', 'REFERRAL_SIGNUPS', 'CONVERSION_RATE', 'LEADS_CLAIMED');
CREATE TYPE "SalesGoalScope" AS ENUM ('ALL_AGENTS', 'AGENT_GROUP', 'INDIVIDUAL_AGENT');

ALTER TYPE "SalesLeadStage" ADD VALUE IF NOT EXISTS 'CONVERTED_FREE';

ALTER TABLE "SalesAgentProfile"
  ADD COLUMN "canCreateSubAgents" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "canClaimLeads" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "maxActiveLeads" INTEGER,
  ADD COLUMN "permissions" JSONB;

ALTER TABLE "SalesLeadAssignment"
  ADD COLUMN "segment" TEXT,
  ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "lastContactedAt" TIMESTAMP(3);

ALTER TABLE "SalesSettings"
  ALTER COLUMN "dashboardPrimaryColor" SET DEFAULT '#D7FF2F',
  ALTER COLUMN "dashboardAccentColor" SET DEFAULT '#0A0D0B';

CREATE TABLE "SalesLeadPoolItem" (
  "id" TEXT NOT NULL,
  "assignedAgentId" TEXT,
  "claimedByAgentId" TEXT,
  "convertedAssignmentId" TEXT,
  "customerName" TEXT NOT NULL,
  "customerPhone" TEXT,
  "customerEmail" TEXT,
  "source" TEXT NOT NULL DEFAULT 'round_robin',
  "serviceInterest" TEXT,
  "segment" TEXT,
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "budgetAmount" DECIMAL(10,2),
  "status" "SalesLeadPoolStatus" NOT NULL DEFAULT 'OPEN',
  "notes" TEXT,
  "claimedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesLeadPoolItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesReferralEvent" (
  "id" TEXT NOT NULL,
  "referralCodeId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "userId" TEXT,
  "packageId" TEXT,
  "paymentTransactionId" TEXT,
  "dealId" TEXT,
  "eventType" "SalesReferralEventType" NOT NULL,
  "eventKey" TEXT,
  "path" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesReferralEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesGoal" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "metric" "SalesGoalMetric" NOT NULL,
  "scope" "SalesGoalScope" NOT NULL DEFAULT 'INDIVIDUAL_AGENT',
  "agentId" TEXT,
  "groupId" TEXT,
  "target" DECIMAL(12,2) NOT NULL,
  "rewardText" TEXT,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "isPinned" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesGoal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesReward" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "agentId" TEXT,
  "groupId" TEXT,
  "isPinned" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "unlockedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesReward_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SalesLeadPoolItem_convertedAssignmentId_key" ON "SalesLeadPoolItem"("convertedAssignmentId");
CREATE INDEX "SalesLeadPoolItem_status_createdAt_idx" ON "SalesLeadPoolItem"("status", "createdAt");
CREATE INDEX "SalesLeadPoolItem_assignedAgentId_status_idx" ON "SalesLeadPoolItem"("assignedAgentId", "status");
CREATE INDEX "SalesLeadPoolItem_claimedByAgentId_idx" ON "SalesLeadPoolItem"("claimedByAgentId");

CREATE UNIQUE INDEX "SalesReferralEvent_eventKey_key" ON "SalesReferralEvent"("eventKey");
CREATE INDEX "SalesReferralEvent_referralCodeId_eventType_idx" ON "SalesReferralEvent"("referralCodeId", "eventType");
CREATE INDEX "SalesReferralEvent_agentId_createdAt_idx" ON "SalesReferralEvent"("agentId", "createdAt");
CREATE INDEX "SalesReferralEvent_packageId_idx" ON "SalesReferralEvent"("packageId");
CREATE INDEX "SalesReferralEvent_paymentTransactionId_idx" ON "SalesReferralEvent"("paymentTransactionId");

CREATE INDEX "SalesGoal_scope_isActive_idx" ON "SalesGoal"("scope", "isActive");
CREATE INDEX "SalesGoal_agentId_idx" ON "SalesGoal"("agentId");
CREATE INDEX "SalesGoal_groupId_idx" ON "SalesGoal"("groupId");
CREATE INDEX "SalesReward_agentId_isActive_idx" ON "SalesReward"("agentId", "isActive");
CREATE INDEX "SalesReward_groupId_isActive_idx" ON "SalesReward"("groupId", "isActive");
CREATE INDEX "SalesLeadAssignment_conversationId_idx" ON "SalesLeadAssignment"("conversationId");

ALTER TABLE "SalesLeadPoolItem" ADD CONSTRAINT "SalesLeadPoolItem_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "SalesAgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesLeadPoolItem" ADD CONSTRAINT "SalesLeadPoolItem_claimedByAgentId_fkey" FOREIGN KEY ("claimedByAgentId") REFERENCES "SalesAgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesLeadPoolItem" ADD CONSTRAINT "SalesLeadPoolItem_convertedAssignmentId_fkey" FOREIGN KEY ("convertedAssignmentId") REFERENCES "SalesLeadAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SalesReferralEvent" ADD CONSTRAINT "SalesReferralEvent_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "SalesReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesReferralEvent" ADD CONSTRAINT "SalesReferralEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesReferralEvent" ADD CONSTRAINT "SalesReferralEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesReferralEvent" ADD CONSTRAINT "SalesReferralEvent_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesReferralEvent" ADD CONSTRAINT "SalesReferralEvent_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "payment_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesReferralEvent" ADD CONSTRAINT "SalesReferralEvent_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "SalesDeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SalesGoal" ADD CONSTRAINT "SalesGoal_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesGoal" ADD CONSTRAINT "SalesGoal_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SalesAgentGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesReward" ADD CONSTRAINT "SalesReward_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesReward" ADD CONSTRAINT "SalesReward_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SalesAgentGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
