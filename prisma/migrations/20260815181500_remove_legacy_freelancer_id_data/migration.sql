-- Manual identity collection has been replaced by DigiLocker metadata-only verification.
-- Remove legacy raw document numbers and addresses from freelancer workspace JSON.
UPDATE "AppFreelancerWorkspace"
SET "verification" = jsonb_build_object(
  'status', 'LEGACY_DISABLED',
  'documentType', '',
  'documentNumber', '',
  'address', '',
  'reviewRule', 'Use DigiLocker identity verification',
  'submittedAt', NULL,
  'updatedAt', CURRENT_TIMESTAMP
)
WHERE COALESCE("verification"->>'documentNumber', '') <> ''
   OR COALESCE("verification"->>'address', '') <> '';
