DO $$ BEGIN CREATE TYPE "ConnectedAudience" AS ENUM ('CRM', 'AGENCY', 'FREELANCER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENTAGE', 'FIXED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ConnectedOnboardingStage" AS ENUM ('ROLE', 'OTP', 'PACKAGE', 'PAYMENT', 'PROFILE', 'INSTAGRAM', 'WHATSAPP', 'SERVICES', 'ASSESSMENT', 'IDENTITY', 'COMPLETE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialConnectionProvider" AS ENUM ('INSTAGRAM', 'WHATSAPP'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SocialConnectionStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'CONNECTED', 'ERROR', 'REVOKED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DripCampaignTrigger" AS ENUM ('PROFILE_INCOMPLETE', 'REQUIRED_LEARNING_INCOMPLETE', 'SLOW_REPLY', 'MISSED_WORK', 'TRUST_SCORE_BELOW'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DripDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "SalesTrainingCourse"
  ADD COLUMN IF NOT EXISTS "audiences" "ConnectedAudience"[] NOT NULL DEFAULT ARRAY['CRM']::"ConnectedAudience"[],
  ADD COLUMN IF NOT EXISTS "isRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3);

ALTER TABLE "SalesTrainingLesson"
  ADD COLUMN IF NOT EXISTS "youtubeVideoId" TEXT,
  ADD COLUMN IF NOT EXISTS "completionThreshold" INTEGER NOT NULL DEFAULT 90;

ALTER TABLE "SalesTrainingProgress"
  ADD COLUMN IF NOT EXISTS "watchedSeconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "durationSeconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastPositionSeconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMP(3);

ALTER TABLE "SalesReferralCode"
  ADD COLUMN IF NOT EXISTS "campaignId" TEXT,
  ADD COLUMN IF NOT EXISTS "discountType" "CouponDiscountType",
  ADD COLUMN IF NOT EXISTS "discountValue" DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "eligiblePackageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "maxRedemptions" INTEGER,
  ADD COLUMN IF NOT EXISTS "perUserLimit" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "startsAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "CouponCampaign" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "discountType" "CouponDiscountType" NOT NULL,
  "discountValue" DECIMAL(12,2) NOT NULL,
  "eligiblePackageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "maxRedemptions" INTEGER,
  "perUserLimit" INTEGER NOT NULL DEFAULT 1,
  "startsAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CouponCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CouponRedemption" (
  "id" TEXT NOT NULL,
  "referralCodeId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "paymentTransactionId" TEXT,
  "originalAmount" DECIMAL(12,2) NOT NULL,
  "discountAmount" DECIMAL(12,2) NOT NULL,
  "finalAmount" DECIMAL(12,2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RESERVED',
  "redeemedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ConnectedOnboardingState" (
  "userId" TEXT NOT NULL,
  "audience" "ConnectedAudience" NOT NULL,
  "stage" "ConnectedOnboardingStage" NOT NULL DEFAULT 'ROLE',
  "otpVerifiedAt" TIMESTAMP(3),
  "packageChosenAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "profileDoneAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "payload" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectedOnboardingState_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "ConnectedSignupIntent" (
  "id" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "email" TEXT,
  "audience" "ConnectedAudience" NOT NULL,
  "provisionalPackageId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "challengeId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OTP_ISSUED',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectedSignupIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MobileActiveView" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "viewType" TEXT NOT NULL,
  "referenceId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MobileActiveView_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AppSocialConnection" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" "SocialConnectionProvider" NOT NULL,
  "status" "SocialConnectionStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "externalAccountId" TEXT,
  "displayName" TEXT,
  "accessTokenCiphertext" TEXT,
  "refreshTokenCiphertext" TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "webhookSubscribedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppSocialConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AppFreelancerRating" (
  "id" TEXT NOT NULL,
  "freelancerId" TEXT NOT NULL,
  "agencyUserId" TEXT NOT NULL,
  "assignmentId" TEXT,
  "score" INTEGER NOT NULL,
  "comment" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppFreelancerRating_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AppTrustScoreRule" (
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "weight" INTEGER NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "description" TEXT,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppTrustScoreRule_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "AppDripCampaign" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "trigger" "DripCampaignTrigger" NOT NULL,
  "audiences" "ConnectedAudience"[] NOT NULL,
  "delayMinutes" INTEGER NOT NULL DEFAULT 1440,
  "cooldownMinutes" INTEGER NOT NULL DEFAULT 1440,
  "maxSendsPerUser" INTEGER NOT NULL DEFAULT 3,
  "localWindowStart" TEXT NOT NULL DEFAULT '09:00',
  "localWindowEnd" TEXT NOT NULL DEFAULT '20:00',
  "titleTemplate" TEXT NOT NULL,
  "bodyTemplate" TEXT NOT NULL,
  "destination" TEXT,
  "threshold" INTEGER,
  "stopCondition" JSONB NOT NULL DEFAULT '{}',
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppDripCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AppDripDelivery" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "triggerKey" TEXT NOT NULL,
  "status" "DripDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  "skippedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "error" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppDripDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CouponRedemption_paymentTransactionId_key" ON "CouponRedemption"("paymentTransactionId");
CREATE INDEX IF NOT EXISTS "CouponCampaign_isActive_startsAt_expiresAt_idx" ON "CouponCampaign"("isActive", "startsAt", "expiresAt");
CREATE INDEX IF NOT EXISTS "SalesReferralCode_campaignId_idx" ON "SalesReferralCode"("campaignId");
CREATE INDEX IF NOT EXISTS "CouponRedemption_referralCodeId_status_idx" ON "CouponRedemption"("referralCodeId", "status");
CREATE INDEX IF NOT EXISTS "CouponRedemption_userId_createdAt_idx" ON "CouponRedemption"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "CouponRedemption_packageId_idx" ON "CouponRedemption"("packageId");
CREATE INDEX IF NOT EXISTS "ConnectedOnboardingState_audience_stage_idx" ON "ConnectedOnboardingState"("audience", "stage");
CREATE INDEX IF NOT EXISTS "ConnectedOnboardingState_updatedAt_idx" ON "ConnectedOnboardingState"("updatedAt");
CREATE INDEX IF NOT EXISTS "ConnectedSignupIntent_phone_status_idx" ON "ConnectedSignupIntent"("phone", "status");
CREATE INDEX IF NOT EXISTS "ConnectedSignupIntent_userId_status_idx" ON "ConnectedSignupIntent"("userId", "status");
CREATE INDEX IF NOT EXISTS "ConnectedSignupIntent_expiresAt_idx" ON "ConnectedSignupIntent"("expiresAt");
CREATE UNIQUE INDEX IF NOT EXISTS "MobileActiveView_userId_viewType_referenceId_key" ON "MobileActiveView"("userId", "viewType", "referenceId");
CREATE INDEX IF NOT EXISTS "MobileActiveView_viewType_referenceId_expiresAt_idx" ON "MobileActiveView"("viewType", "referenceId", "expiresAt");
CREATE INDEX IF NOT EXISTS "MobileActiveView_userId_expiresAt_idx" ON "MobileActiveView"("userId", "expiresAt");
CREATE UNIQUE INDEX IF NOT EXISTS "AppSocialConnection_userId_provider_key" ON "AppSocialConnection"("userId", "provider");
CREATE INDEX IF NOT EXISTS "AppSocialConnection_provider_status_idx" ON "AppSocialConnection"("provider", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "AppFreelancerRating_assignmentId_agencyUserId_key" ON "AppFreelancerRating"("assignmentId", "agencyUserId");
CREATE INDEX IF NOT EXISTS "AppFreelancerRating_freelancerId_createdAt_idx" ON "AppFreelancerRating"("freelancerId", "createdAt");
CREATE INDEX IF NOT EXISTS "AppFreelancerRating_agencyUserId_idx" ON "AppFreelancerRating"("agencyUserId");
CREATE INDEX IF NOT EXISTS "AppDripCampaign_trigger_isActive_idx" ON "AppDripCampaign"("trigger", "isActive");
CREATE UNIQUE INDEX IF NOT EXISTS "AppDripDelivery_campaignId_userId_triggerKey_key" ON "AppDripDelivery"("campaignId", "userId", "triggerKey");
CREATE INDEX IF NOT EXISTS "AppDripDelivery_status_scheduledAt_idx" ON "AppDripDelivery"("status", "scheduledAt");
CREATE INDEX IF NOT EXISTS "AppDripDelivery_userId_createdAt_idx" ON "AppDripDelivery"("userId", "createdAt");

DO $$ BEGIN ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "SalesReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "SalesReferralCode" ADD CONSTRAINT "SalesReferralCode_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CouponCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "payment_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ConnectedOnboardingState" ADD CONSTRAINT "ConnectedOnboardingState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ConnectedSignupIntent" ADD CONSTRAINT "ConnectedSignupIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ConnectedSignupIntent" ADD CONSTRAINT "ConnectedSignupIntent_provisionalPackageId_fkey" FOREIGN KEY ("provisionalPackageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "AppSocialConnection" ADD CONSTRAINT "AppSocialConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "AppFreelancerRating" ADD CONSTRAINT "AppFreelancerRating_freelancerId_fkey" FOREIGN KEY ("freelancerId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "AppFreelancerRating" ADD CONSTRAINT "AppFreelancerRating_agencyUserId_fkey" FOREIGN KEY ("agencyUserId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "AppDripDelivery" ADD CONSTRAINT "AppDripDelivery_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AppDripCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "AppDripDelivery" ADD CONSTRAINT "AppDripDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE "packages"
SET "commissionOverridePercent" = 0,
    "isFree" = true,
    "paymentRequired" = false
WHERE "packageType" = 'FREELANCER';

UPDATE "SalesTrainingCourse"
SET "audiences" = ARRAY['CRM']::"ConnectedAudience"[]
WHERE "audiences" = ARRAY['CRM']::"ConnectedAudience"[];

UPDATE "SalesTrainingLesson"
SET "completionThreshold" = 90
WHERE "completionThreshold" IS NULL OR "completionThreshold" < 50;

INSERT INTO "AppTrustScoreRule" ("key", "label", "weight", "description", "createdAt", "updatedAt") VALUES
  ('ASSESSMENT', 'Capability assessment', 20, 'Freelancer onboarding assessment quality.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('PROFILE', 'Profile completion', 5, 'Required freelancer profile fields.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('PORTFOLIO', 'Portfolio approval', 10, 'Approved portfolio and service evidence.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('IDENTITY', 'Identity verification', 5, 'Verified identity status.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('RELIABILITY', 'Work reliability', 15, 'Accepted work completed successfully.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ON_TIME', 'On-time delivery', 15, 'Delivery against freelancer-owned deadlines.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('RESPONSE', 'Reply speed', 10, 'Response time to agency work activity.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('UPDATES', 'Progress updates', 10, 'Proactive project progress updates.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('RATING', 'Agency ratings', 10, 'Verified agency ratings on assignments.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
