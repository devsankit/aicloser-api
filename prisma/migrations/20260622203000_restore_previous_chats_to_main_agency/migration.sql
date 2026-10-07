-- Restore every conversation captured by the 2026-06-22 agency reset backup
-- and transfer it to the official Gigxomi tenant now connected to 9981807309.
WITH backed_up_conversations AS (
  SELECT DISTINCT ON ("sourceId") "payload"
  FROM "AgencyResetBackup20260622"
  WHERE "sourceTable" = 'AppConversation'
    AND "sourceId" IS NOT NULL
  ORDER BY "sourceId", "backedUpAt" DESC
)
INSERT INTO "AppConversation" (
  "id",
  "tenantId",
  "serviceId",
  "serviceSlug",
  "assignedFreelancerId",
  "assignedFreelancerName",
  "customerName",
  "customerPhone",
  "status",
  "leadStatusId",
  "payload",
  "createdAt",
  "updatedAt"
)
SELECT
  "payload" ->> 'id',
  'tenant-gigxomi',
  "payload" ->> 'serviceId',
  "payload" ->> 'serviceSlug',
  NULLIF("payload" ->> 'assignedFreelancerId', ''),
  NULLIF("payload" ->> 'assignedFreelancerName', ''),
  "payload" ->> 'customerName',
  "payload" ->> 'customerPhone',
  "payload" ->> 'status',
  "payload" ->> 'leadStatusId',
  jsonb_set("payload" -> 'payload', '{tenantId}', to_jsonb('tenant-gigxomi'::TEXT), TRUE),
  ("payload" ->> 'createdAt')::TIMESTAMPTZ,
  ("payload" ->> 'updatedAt')::TIMESTAMPTZ
FROM backed_up_conversations
ON CONFLICT ("id") DO UPDATE SET
  "tenantId" = 'tenant-gigxomi',
  "payload" = jsonb_set(EXCLUDED."payload", '{tenantId}', to_jsonb('tenant-gigxomi'::TEXT), TRUE),
  "updatedAt" = EXCLUDED."updatedAt";
