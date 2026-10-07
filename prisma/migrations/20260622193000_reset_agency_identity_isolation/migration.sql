-- One-time agency reset requested on 2026-06-22.
-- Freelancer/editor identities and their portfolio/service records are intentionally untouched.
CREATE TABLE IF NOT EXISTS "AgencyResetBackup20260622" (
  "id" BIGSERIAL PRIMARY KEY,
  "sourceTable" TEXT NOT NULL,
  "sourceId" TEXT,
  "payload" JSONB NOT NULL,
  "backedUpAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TABLE IF EXISTS "AgencyUsersToReset20260622";
CREATE TABLE "AgencyUsersToReset20260622" AS
SELECT "id", "tenantId"
FROM "AppAuthUser"
WHERE "id" <> 'super-admin-owner'
  AND "packageAudience" IS DISTINCT FROM 'FREELANCER'::"AppPackageAudience"
  AND (
    "packageAudience" = 'AGENCY'::"AppPackageAudience"
    OR "workspaceMode" = 'AGENCY'::"AppWorkspaceMode"
    OR "role" IN ('ADMIN'::"AppRole", 'MANAGER'::"AppRole", 'SALES_AGENT'::"AppRole")
    OR "assignedRole" IN ('ADMIN'::"AppRole", 'MANAGER'::"AppRole", 'SALES_AGENT'::"AppRole")
  );

INSERT INTO "AgencyResetBackup20260622" ("sourceTable", "sourceId", "payload")
SELECT 'AppAuthUser', user_row."id", to_jsonb(user_row)
FROM "AppAuthUser" user_row
WHERE user_row."id" IN (SELECT "id" FROM "AgencyUsersToReset20260622");

INSERT INTO "AgencyResetBackup20260622" ("sourceTable", "sourceId", "payload")
SELECT 'AppConversation', conversation_row."id", to_jsonb(conversation_row)
FROM "AppConversation" conversation_row;

INSERT INTO "AgencyResetBackup20260622" ("sourceTable", "sourceId", "payload")
SELECT 'AppTeamRequest', team_row."id", to_jsonb(team_row)
FROM "AppTeamRequest" team_row;

INSERT INTO "AgencyResetBackup20260622" ("sourceTable", "sourceId", "payload")
SELECT 'AppTeamMembership', team_row."id", to_jsonb(team_row)
FROM "AppTeamMembership" team_row;

UPDATE "SalesLeadAssignment"
SET "createdById" = NULL
WHERE "createdById" IN (SELECT "id" FROM "AgencyUsersToReset20260622");

UPDATE "SalesActivityLog"
SET "actorUserId" = NULL
WHERE "actorUserId" IN (SELECT "id" FROM "AgencyUsersToReset20260622");

DELETE FROM "AppConversation";
DELETE FROM "AppTeamRequest";
DELETE FROM "AppTeamMembership";
DELETE FROM "AppAuthUser"
WHERE "id" IN (SELECT "id" FROM "AgencyUsersToReset20260622");

UPDATE "AppAuthUser"
SET
  "role" = 'SUPER_ADMIN'::"AppRole",
  "assignedRole" = 'SUPER_ADMIN'::"AppRole",
  "tenantId" = NULL,
  "email" = 'hello.ankitrathore@gmail.com',
  "phone" = '+917974063067',
  "loginPhoneAliases" = ARRAY['+917974063067', '+917566208079']::TEXT[],
  "packageId" = NULL,
  "packageName" = NULL,
  "packageAudience" = NULL,
  "packageStatus" = NULL,
  "packageExpiresAt" = NULL,
  "workspaceMode" = NULL,
  "permissions" = ARRAY['super_admin']::TEXT[],
  "isSeeded" = TRUE
WHERE "id" = 'super-admin-owner';

DROP TABLE "AgencyUsersToReset20260622";
