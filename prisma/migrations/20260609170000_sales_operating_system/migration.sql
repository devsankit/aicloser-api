-- Sales operating system: LMS, training ladder, mock-call review, webinars, learning wall, conversations, and distribution rules.

ALTER TYPE "SalesLeadStage" ADD VALUE IF NOT EXISTS 'ASSIGNED';
ALTER TYPE "SalesLeadStage" ADD VALUE IF NOT EXISTS 'INTERESTED';
ALTER TYPE "SalesLeadStage" ADD VALUE IF NOT EXISTS 'WEBINAR_INVITED';
ALTER TYPE "SalesLeadStage" ADD VALUE IF NOT EXISTS 'WEBINAR_ATTENDED';
ALTER TYPE "SalesLeadStage" ADD VALUE IF NOT EXISTS 'FOLLOW_UP';
ALTER TYPE "SalesLeadStage" ADD VALUE IF NOT EXISTS 'NEGOTIATION';
ALTER TYPE "SalesLeadStage" ADD VALUE IF NOT EXISTS 'CLOSED_WON';
ALTER TYPE "SalesLeadStage" ADD VALUE IF NOT EXISTS 'CLOSED_LOST';
ALTER TYPE "SalesLeadStage" ADD VALUE IF NOT EXISTS 'NOT_REACHABLE';
ALTER TYPE "SalesLeadStage" ADD VALUE IF NOT EXISTS 'RECYCLED';

CREATE TABLE "SalesTrainingCourse" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "assignedRole" TEXT,
  "assignedTeamId" TEXT,
  "isPublished" BOOLEAN NOT NULL DEFAULT false,
  "requiredCompletionPercent" INTEGER NOT NULL DEFAULT 100,
  "requiredQuizScore" INTEGER,
  "requiresMockCall" BOOLEAN NOT NULL DEFAULT false,
  "requiresManagerReview" BOOLEAN NOT NULL DEFAULT false,
  "leadUnlockQuantity" INTEGER NOT NULL DEFAULT 0,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesTrainingCourse_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesTrainingModule" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesTrainingModule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesTrainingLesson" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "moduleId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "videoUrl" TEXT,
  "videoEmbedUrl" TEXT,
  "content" TEXT,
  "estimatedDuration" INTEGER,
  "isRequired" BOOLEAN NOT NULL DEFAULT true,
  "quizRequired" BOOLEAN NOT NULL DEFAULT false,
  "mockCallRequired" BOOLEAN NOT NULL DEFAULT false,
  "managerReviewRequired" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesTrainingLesson_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesTrainingProgress" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agentId" TEXT,
  "courseId" TEXT NOT NULL,
  "lessonId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
  "progressPercent" INTEGER NOT NULL DEFAULT 0,
  "completedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesTrainingProgress_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesQuizAttempt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agentId" TEXT,
  "courseId" TEXT,
  "lessonId" TEXT,
  "score" INTEGER NOT NULL DEFAULT 0,
  "passed" BOOLEAN NOT NULL DEFAULT false,
  "answers" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesQuizAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesMockCallAttempt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agentId" TEXT,
  "scenario" TEXT NOT NULL,
  "transcript" TEXT NOT NULL,
  "aiScore" INTEGER,
  "managerScore" INTEGER,
  "feedback" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesMockCallAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesUnlockRule" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "stepKey" TEXT NOT NULL,
  "description" TEXT,
  "requirement" TEXT,
  "reward" TEXT,
  "requiredCourseId" TEXT,
  "requiredProgressPercent" INTEGER,
  "requiredQuizScore" INTEGER,
  "requiresMockApproval" BOOLEAN NOT NULL DEFAULT false,
  "requiresManagerReview" BOOLEAN NOT NULL DEFAULT false,
  "leadUnlockQuantity" INTEGER NOT NULL DEFAULT 0,
  "unlockRole" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesUnlockRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesAgentLevel" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agentId" TEXT,
  "currentLevel" TEXT NOT NULL DEFAULT 'TRAINEE_JOINED',
  "currentStep" TEXT NOT NULL DEFAULT 'trainee_joined',
  "leadsUnlocked" INTEGER NOT NULL DEFAULT 0,
  "managerPathUnlocked" BOOLEAN NOT NULL DEFAULT false,
  "teamCreationUnlocked" BOOLEAN NOT NULL DEFAULT false,
  "overrideNote" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesAgentLevel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesLearningPost" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'Sales tip',
  "audience" TEXT NOT NULL DEFAULT 'all',
  "teamId" TEXT,
  "role" TEXT,
  "authorId" TEXT,
  "isPinned" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "linkUrl" TEXT,
  "videoUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesLearningPost_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesLearningPostReaction" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'helpful',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesLearningPostReaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesWebinar" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "hostId" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "registrationLink" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesWebinar_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesWebinarInvite" (
  "id" TEXT NOT NULL,
  "webinarId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'INVITED',
  "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attendedAt" TIMESTAMP(3),
  "notes" TEXT,
  CONSTRAINT "SalesWebinarInvite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesLeadTimelineEntry" (
  "id" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "agentId" TEXT,
  "userId" TEXT,
  "type" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesLeadTimelineEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesRoundRobinRule" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "teamId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "maxActiveLeads" INTEGER,
  "requireTrainingLevel" TEXT,
  "priorityMode" TEXT,
  "batchSize" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesRoundRobinRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SalesTrainingCourse_isPublished_sortOrder_idx" ON "SalesTrainingCourse"("isPublished", "sortOrder");
CREATE INDEX "SalesTrainingCourse_assignedRole_assignedTeamId_idx" ON "SalesTrainingCourse"("assignedRole", "assignedTeamId");
CREATE INDEX "SalesTrainingModule_courseId_sortOrder_idx" ON "SalesTrainingModule"("courseId", "sortOrder");
CREATE INDEX "SalesTrainingLesson_courseId_sortOrder_idx" ON "SalesTrainingLesson"("courseId", "sortOrder");
CREATE INDEX "SalesTrainingLesson_moduleId_sortOrder_idx" ON "SalesTrainingLesson"("moduleId", "sortOrder");
CREATE UNIQUE INDEX "SalesTrainingProgress_userId_courseId_lessonId_key" ON "SalesTrainingProgress"("userId", "courseId", "lessonId");
CREATE INDEX "SalesTrainingProgress_userId_status_idx" ON "SalesTrainingProgress"("userId", "status");
CREATE INDEX "SalesTrainingProgress_agentId_idx" ON "SalesTrainingProgress"("agentId");
CREATE INDEX "SalesQuizAttempt_userId_createdAt_idx" ON "SalesQuizAttempt"("userId", "createdAt");
CREATE INDEX "SalesQuizAttempt_agentId_idx" ON "SalesQuizAttempt"("agentId");
CREATE INDEX "SalesMockCallAttempt_userId_status_idx" ON "SalesMockCallAttempt"("userId", "status");
CREATE INDEX "SalesMockCallAttempt_agentId_status_idx" ON "SalesMockCallAttempt"("agentId", "status");
CREATE UNIQUE INDEX "SalesUnlockRule_stepKey_key" ON "SalesUnlockRule"("stepKey");
CREATE INDEX "SalesUnlockRule_isActive_sortOrder_idx" ON "SalesUnlockRule"("isActive", "sortOrder");
CREATE UNIQUE INDEX "SalesAgentLevel_userId_key" ON "SalesAgentLevel"("userId");
CREATE INDEX "SalesAgentLevel_agentId_idx" ON "SalesAgentLevel"("agentId");
CREATE INDEX "SalesLearningPost_audience_isActive_isPinned_idx" ON "SalesLearningPost"("audience", "isActive", "isPinned");
CREATE INDEX "SalesLearningPost_teamId_isActive_idx" ON "SalesLearningPost"("teamId", "isActive");
CREATE INDEX "SalesLearningPost_role_isActive_idx" ON "SalesLearningPost"("role", "isActive");
CREATE UNIQUE INDEX "SalesLearningPostReaction_postId_userId_type_key" ON "SalesLearningPostReaction"("postId", "userId", "type");
CREATE INDEX "SalesLearningPostReaction_userId_idx" ON "SalesLearningPostReaction"("userId");
CREATE INDEX "SalesWebinar_isActive_startsAt_idx" ON "SalesWebinar"("isActive", "startsAt");
CREATE INDEX "SalesWebinar_hostId_idx" ON "SalesWebinar"("hostId");
CREATE UNIQUE INDEX "SalesWebinarInvite_webinarId_leadId_key" ON "SalesWebinarInvite"("webinarId", "leadId");
CREATE INDEX "SalesWebinarInvite_agentId_status_idx" ON "SalesWebinarInvite"("agentId", "status");
CREATE INDEX "SalesWebinarInvite_leadId_idx" ON "SalesWebinarInvite"("leadId");
CREATE INDEX "SalesLeadTimelineEntry_leadId_createdAt_idx" ON "SalesLeadTimelineEntry"("leadId", "createdAt");
CREATE INDEX "SalesLeadTimelineEntry_agentId_createdAt_idx" ON "SalesLeadTimelineEntry"("agentId", "createdAt");
CREATE INDEX "SalesRoundRobinRule_isActive_teamId_idx" ON "SalesRoundRobinRule"("isActive", "teamId");

ALTER TABLE "SalesTrainingModule" ADD CONSTRAINT "SalesTrainingModule_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "SalesTrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesTrainingLesson" ADD CONSTRAINT "SalesTrainingLesson_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "SalesTrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesTrainingLesson" ADD CONSTRAINT "SalesTrainingLesson_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "SalesTrainingModule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesTrainingProgress" ADD CONSTRAINT "SalesTrainingProgress_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "SalesTrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesTrainingProgress" ADD CONSTRAINT "SalesTrainingProgress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "SalesTrainingLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesLearningPostReaction" ADD CONSTRAINT "SalesLearningPostReaction_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SalesLearningPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesWebinarInvite" ADD CONSTRAINT "SalesWebinarInvite_webinarId_fkey" FOREIGN KEY ("webinarId") REFERENCES "SalesWebinar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
