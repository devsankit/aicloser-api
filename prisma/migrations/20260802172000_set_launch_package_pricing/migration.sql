-- Keep the two launch packages aligned with the public signup promise.
-- Existing historical subscriptions remain untouched; only new registrations use
-- the free freelancer plan or the annual agency plan.
UPDATE "packages"
SET
  "name" = 'Freelancer',
  "shortSubtitle" = '₹0 forever — no subscription fee',
  "description" = 'Build your editor business with a public portfolio, service marketplace, agency opportunities, delivery tools, and payouts at no subscription cost.',
  "badgeText" = 'Free for freelancers',
  "ctaLabel" = 'Start free',
  "billingType" = 'FREE'::"PackageBillingType",
  "billingInterval" = 'CUSTOM'::"PackageBillingInterval",
  "amount" = 0,
  "priceMonthly" = NULL,
  "priceQuarterly" = NULL,
  "priceYearly" = NULL,
  "priceOneTime" = NULL,
  "isFree" = true,
  "paymentRequired" = false,
  "autoRenewEnabled" = false,
  "durationDays" = 3650,
  "selectedSummaryBullets" = ARRAY[
    'Free public editor profile and portfolio',
    'Publish services in Gigxomi marketplace',
    'Receive agency offers and apply for projects',
    'Manage chat, delivery, and revisions',
    'Track leads, earnings, wallet, and payouts',
    'Use analytics, profile boost, and verification tools'
  ],
  "compareHighlights" = ARRAY['₹0 forever', 'Public portfolio', 'Service marketplace', 'Agency opportunities', 'Delivery workflow', 'Wallet & payouts']
WHERE "slug" = 'freelancer-pro';

UPDATE "packages"
SET
  "name" = 'Agency',
  "shortSubtitle" = '₹12,000/year — one complete agency workspace',
  "description" = 'Run leads, editor sourcing, projects, approvals, clients, managers, finance, automation, and analytics for the equivalent of ₹1,000 per month, billed annually.',
  "badgeText" = 'Best for agencies',
  "ctaLabel" = 'Get annual access',
  "billingType" = 'RECURRING'::"PackageBillingType",
  "billingInterval" = 'YEARLY'::"PackageBillingInterval",
  "amount" = 12000,
  "priceMonthly" = NULL,
  "priceQuarterly" = NULL,
  "priceYearly" = 12000,
  "priceOneTime" = NULL,
  "isFree" = false,
  "paymentRequired" = true,
  "autoRenewEnabled" = true,
  "durationDays" = 365,
  "selectedSummaryBullets" = ARRAY[
    'Lead CRM, clients, managers, and agency dashboard',
    'Find editors, send offers, and manage your Team',
    'Route projects, review delivery, and collect approvals',
    'Manage invoices, collections, wallet, and accounting',
    'Use AI tools, automations, analytics, and integrations',
    'Customize branding with API, webhooks, and priority support'
  ],
  "compareHighlights" = ARRAY['₹1,000/month equivalent', 'Lead CRM', 'Editor Team', 'Client approvals', 'Finance & analytics', 'Branding & integrations']
WHERE "slug" = 'agency-launch';
