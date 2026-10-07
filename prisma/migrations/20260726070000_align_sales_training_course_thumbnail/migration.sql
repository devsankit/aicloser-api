-- Keep the Sales LMS table aligned with the Prisma model used by the dashboard.
ALTER TABLE "SalesTrainingCourse"
ADD COLUMN IF NOT EXISTS "thumbnailUrl" TEXT;
