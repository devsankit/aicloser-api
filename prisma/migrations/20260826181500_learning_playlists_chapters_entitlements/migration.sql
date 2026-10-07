ALTER TABLE "SalesTrainingModule"
  ADD COLUMN "thumbnailUrl" TEXT,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "accessMode" TEXT NOT NULL DEFAULT 'ALL_MATCHING_PACKAGES',
  ADD COLUMN "isPublished" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "SalesTrainingLesson"
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "isPublished" BOOLEAN NOT NULL DEFAULT true;

INSERT INTO "SalesTrainingModule" ("id", "courseId", "title", "description", "sortOrder", "createdAt", "updatedAt")
SELECT 'legacy-start-' || course."id", course."id", 'Start here', 'Getting started lessons', -100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "SalesTrainingCourse" course
WHERE EXISTS (
  SELECT 1 FROM "SalesTrainingLesson" lesson
  WHERE lesson."courseId" = course."id" AND lesson."moduleId" IS NULL
)
ON CONFLICT ("id") DO NOTHING;

UPDATE "SalesTrainingLesson" lesson
SET "moduleId" = 'legacy-start-' || lesson."courseId"
WHERE lesson."moduleId" IS NULL;

CREATE TABLE "LearningChapterPackageAccess" (
  "id" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LearningChapterPackageAccess_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LearningChapterPackageAccess_chapterId_packageId_key" ON "LearningChapterPackageAccess"("chapterId", "packageId");
CREATE INDEX "LearningChapterPackageAccess_packageId_chapterId_idx" ON "LearningChapterPackageAccess"("packageId", "chapterId");
ALTER TABLE "LearningChapterPackageAccess" ADD CONSTRAINT "LearningChapterPackageAccess_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "SalesTrainingModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearningChapterPackageAccess" ADD CONSTRAINT "LearningChapterPackageAccess_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LearningWatchSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "activeWatchedSeconds" INTEGER NOT NULL DEFAULT 0,
  "durationSeconds" INTEGER NOT NULL DEFAULT 0,
  "lastPositionSeconds" INTEGER NOT NULL DEFAULT 0,
  "lastEventId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LearningWatchSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LearningWatchSession_userId_lessonId_startedAt_idx" ON "LearningWatchSession"("userId", "lessonId", "startedAt");
CREATE INDEX "LearningWatchSession_courseId_chapterId_idx" ON "LearningWatchSession"("courseId", "chapterId");
CREATE INDEX "LearningWatchSession_lastHeartbeatAt_idx" ON "LearningWatchSession"("lastHeartbeatAt");
ALTER TABLE "LearningWatchSession" ADD CONSTRAINT "LearningWatchSession_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "SalesTrainingModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearningWatchSession" ADD CONSTRAINT "LearningWatchSession_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "SalesTrainingLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LearningWatchEvent" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "activeSeconds" INTEGER NOT NULL,
  "positionSeconds" INTEGER NOT NULL,
  "durationSeconds" INTEGER NOT NULL,
  "playbackState" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LearningWatchEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LearningWatchEvent_userId_lessonId_createdAt_idx" ON "LearningWatchEvent"("userId", "lessonId", "createdAt");
CREATE INDEX "LearningWatchEvent_sessionId_createdAt_idx" ON "LearningWatchEvent"("sessionId", "createdAt");
ALTER TABLE "LearningWatchEvent" ADD CONSTRAINT "LearningWatchEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LearningWatchSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearningWatchEvent" ADD CONSTRAINT "LearningWatchEvent_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "SalesTrainingLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
