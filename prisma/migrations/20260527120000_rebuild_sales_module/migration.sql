-- Native Gigxomi sales module: agents, referral attribution, commissions, earnings, payouts, and messages.

ALTER TYPE "AppRole" ADD VALUE IF NOT EXISTS 'SALES_AGENT';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'SALES_AGENT';

DO $$ BEGIN
  CREATE TYPE "SalesAgentStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesLeadStage" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'QUOTE_SENT', 'PAYMENT_PENDING', 'PAID', 'HANDOFF', 'CLOSED', 'LOST');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesDealStatus" AS ENUM ('DRAFT', 'PAYMENT_PENDING', 'PAID', 'HANDOFF', 'CLOSED', 'CANCELLED', 'REFUNDED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesCommissionRuleType" AS ENUM ('FIXED', 'PERCENTAGE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesCommissionScope" AS ENUM ('ALL_AGENTS', 'AGENT_GROUP', 'INDIVIDUAL_AGENT');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesCommissionAppliesTo" AS ENUM ('ALL_PACKAGES', 'PACKAGE', 'SERVICE', 'ONE_TIME_DEAL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesEarningStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesPayoutStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PAID', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "SalesSettings" (
  "id" TEXT NOT NULL DEFAULT 'sales-settings',
  "moduleEnabled" BOOLEAN NOT NULL DEFAULT true,
  "signupRequiresApproval" BOOLEAN NOT NULL DEFAULT true,
  "defaultCommissionPercent" DECIMAL(5,2) NOT NULL DEFAULT 10,
  "payoutMinimum" DECIMAL(12,2) NOT NULL DEFAULT 500,
  "enableAnnouncements" BOOLEAN NOT NULL DEFAULT true,
  "enableMessages" BOOLEAN NOT NULL DEFAULT true,
  "enableReferralLinks" BOOLEAN NOT NULL DEFAULT true,
  "enableTeams" BOOLEAN NOT NULL DEFAULT true,
  "enableEarnings" BOOLEAN NOT NULL DEFAULT true,
  "enablePayouts" BOOLEAN NOT NULL DEFAULT true,
  "enablePackageLinks" BOOLEAN NOT NULL DEFAULT true,
  "dashboardPrimaryColor" TEXT NOT NULL DEFAULT '#D7FF2F',
  "dashboardAccentColor" TEXT NOT NULL DEFAULT '#0A0D0B',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesAgentGroup" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "defaultCommissionPercent" DECIMAL(5,2) NOT NULL DEFAULT 10,
  "parentCommissionPercent" DECIMAL(5,2) NOT NULL DEFAULT 2,
  "maxDiscountPercent" DECIMAL(5,2),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesAgentGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesAgentProfile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "groupId" TEXT,
  "parentAgentId" TEXT,
  "agentCode" TEXT NOT NULL,
  "status" "SalesAgentStatus" NOT NULL DEFAULT 'PENDING',
  "commissionPercent" DECIMAL(5,2),
  "payoutInfo" JSONB,
  "totalPaidRevenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "outstandingEarnings" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesAgentProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesLeadAssignment" (
  "id" TEXT NOT NULL,
  "leadId" TEXT,
  "assignedAgentId" TEXT NOT NULL,
  "createdById" TEXT,
  "customerName" TEXT NOT NULL,
  "customerPhone" TEXT,
  "customerEmail" TEXT,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "serviceInterest" TEXT,
  "budgetAmount" DECIMAL(10,2),
  "stage" "SalesLeadStage" NOT NULL DEFAULT 'NEW',
  "followUpAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesLeadAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesReferralCode" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "label" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesReferralCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesDeal" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "packageId" TEXT,
  "serviceId" TEXT,
  "quoteId" TEXT,
  "paymentTransactionId" TEXT,
  "referralCodeId" TEXT,
  "title" TEXT NOT NULL,
  "agreedAmount" DECIMAL(12,2) NOT NULL,
  "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "status" "SalesDealStatus" NOT NULL DEFAULT 'DRAFT',
  "paymentReference" TEXT,
  "closedAt" TIMESTAMP(3),
  "handoffNotes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesDeal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesCommissionRule" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "SalesCommissionRuleType" NOT NULL,
  "scope" "SalesCommissionScope" NOT NULL DEFAULT 'ALL_AGENTS',
  "appliesTo" "SalesCommissionAppliesTo" NOT NULL DEFAULT 'ALL_PACKAGES',
  "groupId" TEXT,
  "agentId" TEXT,
  "packageId" TEXT,
  "serviceId" TEXT,
  "value" DECIMAL(10,2) NOT NULL,
  "parentCommissionPercent" DECIMAL(5,2),
  "minOrderValue" DECIMAL(12,2),
  "maxOrderValue" DECIMAL(12,2),
  "priority" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesCommissionRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesEarning" (
  "id" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "ruleId" TEXT,
  "amount" DECIMAL(12,2) NOT NULL,
  "parentAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "status" "SalesEarningStatus" NOT NULL DEFAULT 'PENDING',
  "approvedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "payoutId" TEXT,
  CONSTRAINT "SalesEarning_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesPayout" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "status" "SalesPayoutStatus" NOT NULL DEFAULT 'REQUESTED',
  "note" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesPayout_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesAnnouncement" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "audience" TEXT NOT NULL DEFAULT 'all',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesAnnouncement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesMessageThread" (
  "id" TEXT NOT NULL,
  "agentId" TEXT,
  "subject" TEXT NOT NULL,
  "messages" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesMessageThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesActivityLog" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT,
  "actorUserId" TEXT,
  "action" TEXT NOT NULL,
  "note" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesActivityLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SalesAgentProfile_userId_key" ON "SalesAgentProfile"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "SalesAgentProfile_agentCode_key" ON "SalesAgentProfile"("agentCode");
CREATE INDEX IF NOT EXISTS "SalesAgentProfile_groupId_idx" ON "SalesAgentProfile"("groupId");
CREATE INDEX IF NOT EXISTS "SalesAgentProfile_parentAgentId_idx" ON "SalesAgentProfile"("parentAgentId");
CREATE INDEX IF NOT EXISTS "SalesAgentProfile_status_idx" ON "SalesAgentProfile"("status");
CREATE INDEX IF NOT EXISTS "SalesLeadAssignment_assignedAgentId_stage_idx" ON "SalesLeadAssignment"("assignedAgentId", "stage");
CREATE INDEX IF NOT EXISTS "SalesLeadAssignment_leadId_idx" ON "SalesLeadAssignment"("leadId");
CREATE UNIQUE INDEX IF NOT EXISTS "SalesDeal_paymentTransactionId_key" ON "SalesDeal"("paymentTransactionId");
CREATE INDEX IF NOT EXISTS "SalesDeal_agentId_status_idx" ON "SalesDeal"("agentId", "status");
CREATE INDEX IF NOT EXISTS "SalesDeal_assignmentId_idx" ON "SalesDeal"("assignmentId");
CREATE INDEX IF NOT EXISTS "SalesDeal_paymentTransactionId_idx" ON "SalesDeal"("paymentTransactionId");
CREATE INDEX IF NOT EXISTS "SalesDeal_referralCodeId_idx" ON "SalesDeal"("referralCodeId");
CREATE INDEX IF NOT EXISTS "SalesCommissionRule_scope_isActive_priority_idx" ON "SalesCommissionRule"("scope", "isActive", "priority");
CREATE INDEX IF NOT EXISTS "SalesCommissionRule_agentId_idx" ON "SalesCommissionRule"("agentId");
CREATE INDEX IF NOT EXISTS "SalesCommissionRule_packageId_idx" ON "SalesCommissionRule"("packageId");
CREATE INDEX IF NOT EXISTS "SalesCommissionRule_serviceId_idx" ON "SalesCommissionRule"("serviceId");
CREATE INDEX IF NOT EXISTS "SalesEarning_agentId_status_idx" ON "SalesEarning"("agentId", "status");
CREATE INDEX IF NOT EXISTS "SalesEarning_dealId_idx" ON "SalesEarning"("dealId");
CREATE INDEX IF NOT EXISTS "SalesPayout_agentId_status_idx" ON "SalesPayout"("agentId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "SalesReferralCode_code_key" ON "SalesReferralCode"("code");
CREATE INDEX IF NOT EXISTS "SalesMessageThread_agentId_status_idx" ON "SalesMessageThread"("agentId", "status");
CREATE INDEX IF NOT EXISTS "SalesActivityLog_assignmentId_idx" ON "SalesActivityLog"("assignmentId");
CREATE INDEX IF NOT EXISTS "SalesActivityLog_actorUserId_idx" ON "SalesActivityLog"("actorUserId");

ALTER TABLE "SalesAgentProfile" ADD CONSTRAINT "SalesAgentProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesAgentProfile" ADD CONSTRAINT "SalesAgentProfile_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SalesAgentGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesAgentProfile" ADD CONSTRAINT "SalesAgentProfile_parentAgentId_fkey" FOREIGN KEY ("parentAgentId") REFERENCES "SalesAgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesLeadAssignment" ADD CONSTRAINT "SalesLeadAssignment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesLeadAssignment" ADD CONSTRAINT "SalesLeadAssignment_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesLeadAssignment" ADD CONSTRAINT "SalesLeadAssignment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AppAuthUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesReferralCode" ADD CONSTRAINT "SalesReferralCode_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesDeal" ADD CONSTRAINT "SalesDeal_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "SalesLeadAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesDeal" ADD CONSTRAINT "SalesDeal_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesDeal" ADD CONSTRAINT "SalesDeal_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesDeal" ADD CONSTRAINT "SalesDeal_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesDeal" ADD CONSTRAINT "SalesDeal_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesDeal" ADD CONSTRAINT "SalesDeal_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "payment_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesDeal" ADD CONSTRAINT "SalesDeal_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "SalesReferralCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesCommissionRule" ADD CONSTRAINT "SalesCommissionRule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SalesAgentGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesCommissionRule" ADD CONSTRAINT "SalesCommissionRule_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesCommissionRule" ADD CONSTRAINT "SalesCommissionRule_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesCommissionRule" ADD CONSTRAINT "SalesCommissionRule_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesEarning" ADD CONSTRAINT "SalesEarning_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "SalesDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesEarning" ADD CONSTRAINT "SalesEarning_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesEarning" ADD CONSTRAINT "SalesEarning_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "SalesPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesPayout" ADD CONSTRAINT "SalesPayout_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesMessageThread" ADD CONSTRAINT "SalesMessageThread_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesActivityLog" ADD CONSTRAINT "SalesActivityLog_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "SalesLeadAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesActivityLog" ADD CONSTRAINT "SalesActivityLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "AppAuthUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
