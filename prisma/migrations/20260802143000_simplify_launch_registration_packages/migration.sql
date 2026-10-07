-- Keep historical packages available for existing subscriptions while exposing
-- exactly one complete freelancer plan and one complete agency plan to signup.
UPDATE "packages"
SET
  "isVisibleOnRegistration" = false,
  "allowRegistration" = false
WHERE "packageType"::text IN ('FREELANCER', 'AGENCY')
  AND "slug" NOT IN ('freelancer-pro', 'agency-launch');

UPDATE "packages"
SET
  "name" = 'Freelancer',
  "shortSubtitle" = 'One complete workspace for independent editors',
  "description" = 'Publish your work, receive opportunities, manage projects, chat, delivery, earnings, and payouts from one account.',
  "badgeText" = 'Complete freelancer workspace',
  "isVisibleOnRegistration" = true,
  "allowRegistration" = true,
  "isRecommended" = true,
  "chatAccess" = true,
  "teamChat" = true,
  "aiToolsAccess" = true,
  "analyticsAccess" = true,
  "advancedAnalytics" = true,
  "automationTools" = true,
  "featuredListing" = true,
  "boostProfile" = true,
  "prioritySupport" = true,
  "verificationBadgeEligible" = true,
  "selectedSummaryBullets" = ARRAY[
    'Public editor profile and portfolio',
    'Service publishing and marketplace discovery',
    'Agency offers and project applications',
    'Project chat, delivery, and revision workflow',
    'Lead, earnings, wallet, and payout tracking',
    'Analytics, profile boost, and verification eligibility'
  ],
  "compareHighlights" = ARRAY['Editor profile', 'Services', 'Agency offers', 'Project workflow', 'Wallet & payouts', 'Analytics']
WHERE "slug" = 'freelancer-pro';

UPDATE "packages"
SET
  "name" = 'Agency',
  "shortSubtitle" = 'One complete operating system for growing teams',
  "description" = 'Run leads, editor offers, projects, approvals, clients, managers, accounts, automation, and analytics from one workspace.',
  "badgeText" = 'Complete agency workspace',
  "isVisibleOnRegistration" = true,
  "allowRegistration" = true,
  "isRecommended" = true,
  "chatAccess" = true,
  "clientChat" = true,
  "teamChat" = true,
  "whatsappIntegration" = true,
  "aiToolsAccess" = true,
  "analyticsAccess" = true,
  "advancedAnalytics" = true,
  "invoiceTools" = true,
  "paymentCollectionTools" = true,
  "whiteLabelAccess" = true,
  "brandingCustomization" = true,
  "automationTools" = true,
  "apiAccess" = true,
  "webhookAccess" = true,
  "prioritySupport" = true,
  "verificationBadgeEligible" = true,
  "dedicatedManager" = true,
  "selectedSummaryBullets" = ARRAY[
    'Agency dashboard, leads, clients, and manager access',
    'Editor discovery, offers, Team membership, and routing',
    'Client and team chat with delivery approvals',
    'Invoices, payment collection, wallet, and accounting',
    'AI tools, automation, analytics, and integrations',
    'Branding, white-label, API, webhook, and priority support'
  ],
  "compareHighlights" = ARRAY['Agency operations', 'Editor Team', 'Client delivery', 'Accounts', 'AI & automation', 'Branding & integrations']
WHERE "slug" = 'agency-launch';
