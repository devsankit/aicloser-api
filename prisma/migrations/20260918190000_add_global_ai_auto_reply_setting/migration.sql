ALTER TABLE "SalesSettings"
ADD COLUMN "aiAutoReplyEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "aiAutoReplyUpdatedById" TEXT,
ADD COLUMN "aiAutoReplyUpdatedByName" TEXT;
