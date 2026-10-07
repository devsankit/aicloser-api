UPDATE "packages"
SET
  "shortSubtitle" = '30-day agency launch',
  "description" = 'Try the core agency workspace for 30 days with assignment access for up to two confirmed editors.',
  "badgeText" = '30 days free',
  "ctaLabel" = 'Start 30-day Freemium',
  "trialEnabled" = true,
  "trialDays" = 30,
  "durationDays" = 30,
  "selectedSummaryBullets" = ARRAY[
    'WhatsApp and Instagram inbox',
    'Invite and confirm freelancers',
    'Assign active work to 2 distinct editors for 30 days'
  ]::TEXT[],
  "compareHighlights" = ARRAY[
    '30-day multichannel workspace',
    'Confirmed team members',
    '2 active editors'
  ]::TEXT[],
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "slug" = 'agency-freemium' OR "id" = 'pkg-agency-freemium';

UPDATE "user_subscriptions"
SET "expiresAt" = COALESCE("startsAt", "createdAt") + INTERVAL '30 days',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "packageId" IN (
  SELECT "id" FROM "packages" WHERE "slug" = 'agency-freemium' OR "id" = 'pkg-agency-freemium'
)
AND "status" IN ('ACTIVE', 'TRIALING');

UPDATE "AppAuthUser" AS app_user
SET "packageExpiresAt" = COALESCE(subscription."startsAt", subscription."createdAt") + INTERVAL '30 days'
FROM "user_subscriptions" AS subscription
WHERE app_user."id" = subscription."userId"
AND subscription."packageId" IN (
  SELECT "id" FROM "packages" WHERE "slug" = 'agency-freemium' OR "id" = 'pkg-agency-freemium'
)
AND subscription."status" IN ('ACTIVE', 'TRIALING');
