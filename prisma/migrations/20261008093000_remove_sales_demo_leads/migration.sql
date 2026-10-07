-- This migration is already present in the shared database history.
-- Keep the API migration tree in sync with the application migration tree.
-- It removes only the four development-only lead-pool rows created by the
-- dashboard bootstrap; customer-created leads are not affected.
DELETE FROM "SalesLeadPoolItem"
WHERE "id" IN (
  'sales-pool-sample-b2b-saas',
  'sales-pool-sample-fintech-calling',
  'sales-pool-sample-edtech-team',
  'sales-pool-sample-insurance-agency'
);
