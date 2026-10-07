ALTER TABLE "recurring_billing_events"
ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "recurring_billing_events_dedupeKey_key"
ON "recurring_billing_events"("dedupeKey");
