CREATE TABLE "AppFreelancerOnboarding" (
  "userId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  "currentStep" INTEGER NOT NULL DEFAULT 1,
  "serviceId" TEXT,
  "primaryCategory" TEXT,
  "secondaryCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "serviceSubmittedAt" TIMESTAMP(3),
  "profileCompletedAt" TIMESTAMP(3),
  "identityChoiceAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastCampaignAt" TIMESTAMP(3),
  "campaignOptOut" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppFreelancerOnboarding_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "AppFreelancerAssessment" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "primaryCategory" TEXT NOT NULL,
  "questionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "answers" JSONB NOT NULL DEFAULT '{}',
  "score" INTEGER,
  "submittedAt" TIMESTAMP(3),
  "resetAt" TIMESTAMP(3),
  "resetByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppFreelancerAssessment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppFreelancerIdentity" (
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'DIGILOCKER',
  "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
  "providerSubject" TEXT,
  "requestedDocumentType" TEXT,
  "documentType" TEXT,
  "issuer" TEXT,
  "verifiedName" TEXT,
  "oauthStateHash" TEXT,
  "oauthNonceHash" TEXT,
  "oauthCodeVerifier" TEXT,
  "oauthExpiresAt" TIMESTAMP(3),
  "consentedAt" TIMESTAMP(3),
  "skippedAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppFreelancerIdentity_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "AppFreelancerTrustSnapshot" (
  "userId" TEXT NOT NULL,
  "score" INTEGER NOT NULL DEFAULT 0,
  "provisional" BOOLEAN NOT NULL DEFAULT true,
  "assessmentPoints" INTEGER NOT NULL DEFAULT 0,
  "profilePoints" INTEGER NOT NULL DEFAULT 0,
  "portfolioPoints" INTEGER NOT NULL DEFAULT 0,
  "identityPoints" INTEGER NOT NULL DEFAULT 0,
  "reliabilityPoints" INTEGER NOT NULL DEFAULT 0,
  "onTimePoints" INTEGER NOT NULL DEFAULT 0,
  "responsePoints" INTEGER NOT NULL DEFAULT 0,
  "updatePoints" INTEGER NOT NULL DEFAULT 0,
  "ratingPoints" INTEGER NOT NULL DEFAULT 0,
  "completedAssignments" INTEGER NOT NULL DEFAULT 0,
  "nextAction" TEXT,
  "calculationVersion" INTEGER NOT NULL DEFAULT 1,
  "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppFreelancerTrustSnapshot_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "AppFreelancerTrustEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "component" TEXT NOT NULL,
  "delta" INTEGER NOT NULL,
  "scoreAfter" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "sourceType" TEXT,
  "sourceId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'APPLIED',
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppFreelancerTrustEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppFreelancerTrustDispute" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "resolutionNote" TEXT,
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppFreelancerTrustDispute_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppFreelancerPortfolioReview" (
  "id" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "freelancerId" TEXT NOT NULL,
  "submissionVersion" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "portfolioUrl" TEXT NOT NULL,
  "note" TEXT,
  "reviewedByUserId" TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppFreelancerPortfolioReview_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppAssignmentProgressUpdate" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "freelancerId" TEXT NOT NULL,
  "milestone" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'POSTED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppAssignmentProgressUpdate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppFreelancerAssessment_userId_key" ON "AppFreelancerAssessment"("userId");
CREATE INDEX "AppFreelancerOnboarding_status_idx" ON "AppFreelancerOnboarding"("status");
CREATE INDEX "AppFreelancerOnboarding_currentStep_idx" ON "AppFreelancerOnboarding"("currentStep");
CREATE INDEX "AppFreelancerAssessment_submittedAt_idx" ON "AppFreelancerAssessment"("submittedAt");
CREATE INDEX "AppFreelancerIdentity_status_idx" ON "AppFreelancerIdentity"("status");
CREATE INDEX "AppFreelancerTrustSnapshot_score_idx" ON "AppFreelancerTrustSnapshot"("score");
CREATE INDEX "AppFreelancerTrustEvent_userId_occurredAt_idx" ON "AppFreelancerTrustEvent"("userId", "occurredAt");
CREATE INDEX "AppFreelancerTrustEvent_sourceType_sourceId_idx" ON "AppFreelancerTrustEvent"("sourceType", "sourceId");
CREATE UNIQUE INDEX "AppFreelancerTrustDispute_eventId_key" ON "AppFreelancerTrustDispute"("eventId");
CREATE INDEX "AppFreelancerTrustDispute_userId_status_idx" ON "AppFreelancerTrustDispute"("userId", "status");
CREATE INDEX "AppFreelancerPortfolioReview_status_submittedAt_idx" ON "AppFreelancerPortfolioReview"("status", "submittedAt");
CREATE INDEX "AppFreelancerPortfolioReview_serviceId_idx" ON "AppFreelancerPortfolioReview"("serviceId");
CREATE INDEX "AppFreelancerPortfolioReview_freelancerId_idx" ON "AppFreelancerPortfolioReview"("freelancerId");
CREATE INDEX "AppAssignmentProgressUpdate_assignmentId_createdAt_idx" ON "AppAssignmentProgressUpdate"("assignmentId", "createdAt");
CREATE INDEX "AppAssignmentProgressUpdate_freelancerId_createdAt_idx" ON "AppAssignmentProgressUpdate"("freelancerId", "createdAt");

CREATE TABLE "AppAssignmentPerformanceContext" (
  "assignmentId" TEXT NOT NULL,
  "effectiveDeadline" TIMESTAMP(3),
  "delayAttribution" TEXT,
  "excludedFromPerformance" BOOLEAN NOT NULL DEFAULT false,
  "reason" TEXT,
  "recordedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppAssignmentPerformanceContext_pkey" PRIMARY KEY ("assignmentId")
);

CREATE INDEX "AppAssignmentPerformanceContext_delayAttribution_idx" ON "AppAssignmentPerformanceContext"("delayAttribution");
CREATE INDEX "AppAssignmentPerformanceContext_excludedFromPerformance_idx" ON "AppAssignmentPerformanceContext"("excludedFromPerformance");
ALTER TABLE "AppAssignmentPerformanceContext" ADD CONSTRAINT "AppAssignmentPerformanceContext_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "AppAssignmentRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppFreelancerOnboarding" ADD CONSTRAINT "AppFreelancerOnboarding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppFreelancerAssessment" ADD CONSTRAINT "AppFreelancerAssessment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppFreelancerIdentity" ADD CONSTRAINT "AppFreelancerIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppFreelancerTrustSnapshot" ADD CONSTRAINT "AppFreelancerTrustSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppFreelancerTrustEvent" ADD CONSTRAINT "AppFreelancerTrustEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppFreelancerTrustDispute" ADD CONSTRAINT "AppFreelancerTrustDispute_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "AppFreelancerTrustEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppFreelancerTrustDispute" ADD CONSTRAINT "AppFreelancerTrustDispute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppFreelancerPortfolioReview" ADD CONSTRAINT "AppFreelancerPortfolioReview_freelancerId_fkey" FOREIGN KEY ("freelancerId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppFreelancerPortfolioReview" ADD CONSTRAINT "AppFreelancerPortfolioReview_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "AppAuthUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AppAssignmentProgressUpdate" ADD CONSTRAINT "AppAssignmentProgressUpdate_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "AppAssignmentRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
