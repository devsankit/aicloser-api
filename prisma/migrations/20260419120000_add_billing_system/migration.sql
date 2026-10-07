-- Production package billing, PhonePe payment, and subscription lifecycle tables.

CREATE TYPE "BillingPackageType" AS ENUM ('FREELANCER', 'AGENCY', 'BOTH');
CREATE TYPE "PackageBillingType" AS ENUM ('FREE', 'ONE_TIME_PAID', 'RECURRING');
CREATE TYPE "PackageBillingInterval" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY', 'ONE_TIME', 'CUSTOM');
CREATE TYPE "PackageFeatureType" AS ENUM ('BOOLEAN', 'NUMBER', 'TEXT');
CREATE TYPE "UserSubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'TRIALING', 'PAST_DUE', 'PAUSED', 'CANCELLED', 'REVOKED', 'EXPIRED');
CREATE TYPE "SubscriptionPaymentStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PAID', 'FAILED', 'REFUNDED');
CREATE TYPE "BillingPaymentProvider" AS ENUM ('PHONEPE');
CREATE TYPE "PaymentTransactionType" AS ENUM ('SETUP', 'ONE_TIME', 'RENEWAL', 'REFUND');
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('PENDING', 'INITIATED', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "RecurringBillingEventType" AS ENUM ('SETUP', 'NOTIFY', 'EXECUTE', 'RENEWAL_SUCCESS', 'RENEWAL_FAILED', 'PAUSE', 'UNPAUSE', 'REVOKE', 'CANCEL', 'STATUS', 'WEBHOOK');

CREATE TABLE "packages" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "packageType" "BillingPackageType" NOT NULL,
  "shortSubtitle" TEXT,
  "description" TEXT,
  "badgeText" TEXT,
  "ctaLabel" TEXT,
  "billingType" "PackageBillingType" NOT NULL,
  "billingInterval" "PackageBillingInterval" NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "priceMonthly" DECIMAL(12,2),
  "priceQuarterly" DECIMAL(12,2),
  "priceYearly" DECIMAL(12,2),
  "priceOneTime" DECIMAL(12,2),
  "isFree" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isVisibleOnRegistration" BOOLEAN NOT NULL DEFAULT true,
  "isRecommended" BOOLEAN NOT NULL DEFAULT false,
  "allowRegistration" BOOLEAN NOT NULL DEFAULT true,
  "paymentRequired" BOOLEAN NOT NULL DEFAULT false,
  "autoRenewEnabled" BOOLEAN NOT NULL DEFAULT false,
  "trialEnabled" BOOLEAN NOT NULL DEFAULT false,
  "trialDays" INTEGER NOT NULL DEFAULT 0,
  "setupFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "gracePeriodDays" INTEGER NOT NULL DEFAULT 0,
  "durationDays" INTEGER NOT NULL DEFAULT 30,
  "sortOrder" INTEGER NOT NULL DEFAULT 100,
  "selectedSummaryBullets" TEXT[] NOT NULL,
  "compareHighlights" TEXT[] NOT NULL,
  "showBadge" BOOLEAN NOT NULL DEFAULT true,
  "showCta" BOOLEAN NOT NULL DEFAULT true,
  "featureOrder" TEXT[] NOT NULL,
  "serviceLimit" INTEGER,
  "activeProjectLimit" INTEGER,
  "portfolioItemLimit" INTEGER,
  "teamMemberLimit" INTEGER,
  "staffAccountLimit" INTEGER,
  "clientLimit" INTEGER,
  "editorFreelancerLimit" INTEGER,
  "storageLimitMb" INTEGER,
  "maxUploadSizeMb" INTEGER,
  "chatAccess" BOOLEAN NOT NULL DEFAULT false,
  "clientChat" BOOLEAN NOT NULL DEFAULT false,
  "teamChat" BOOLEAN NOT NULL DEFAULT false,
  "whatsappIntegration" BOOLEAN NOT NULL DEFAULT false,
  "aiToolsAccess" BOOLEAN NOT NULL DEFAULT false,
  "aiCredits" INTEGER,
  "proposalLimit" INTEGER,
  "biddingApplyLimit" INTEGER,
  "leadsUnlockLimit" INTEGER,
  "featuredListing" BOOLEAN NOT NULL DEFAULT false,
  "boostProfile" BOOLEAN NOT NULL DEFAULT false,
  "prioritySupport" BOOLEAN NOT NULL DEFAULT false,
  "analyticsAccess" BOOLEAN NOT NULL DEFAULT false,
  "advancedAnalytics" BOOLEAN NOT NULL DEFAULT false,
  "invoiceTools" BOOLEAN NOT NULL DEFAULT false,
  "paymentCollectionTools" BOOLEAN NOT NULL DEFAULT false,
  "whiteLabelAccess" BOOLEAN NOT NULL DEFAULT false,
  "brandingCustomization" BOOLEAN NOT NULL DEFAULT false,
  "automationTools" BOOLEAN NOT NULL DEFAULT false,
  "apiAccess" BOOLEAN NOT NULL DEFAULT false,
  "webhookAccess" BOOLEAN NOT NULL DEFAULT false,
  "verificationBadgeEligible" BOOLEAN NOT NULL DEFAULT false,
  "dedicatedManager" BOOLEAN NOT NULL DEFAULT false,
  "commissionOverridePercent" DECIMAL(5,2),
  "upgradePathIds" TEXT[] NOT NULL,
  "downgradePathIds" TEXT[] NOT NULL,
  "isDefaultFreePackage" BOOLEAN NOT NULL DEFAULT false,
  "expiryBehavior" TEXT,
  "cancellationBehavior" TEXT,
  "pausedBehavior" TEXT,
  "reactivationBehavior" TEXT,
  "mandateExpiryDays" INTEGER,
  "phonepeAmountType" TEXT,
  "phonepeFrequency" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "package_features" (
  "id" TEXT NOT NULL,
  "featureKey" TEXT NOT NULL,
  "featureLabel" TEXT NOT NULL,
  "featureType" "PackageFeatureType" NOT NULL,
  "category" TEXT,
  "showInRegistrationCompare" BOOLEAN NOT NULL DEFAULT false,
  "showInSelectedSummary" BOOLEAN NOT NULL DEFAULT false,
  "shortDisplayText" TEXT,
  "iconKey" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 100,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "package_features_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "package_feature_values" (
  "id" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "featureId" TEXT NOT NULL,
  "booleanValue" BOOLEAN,
  "numericValue" DECIMAL(12,2),
  "textValue" TEXT,
  "shortDisplayText" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "package_feature_values_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_subscriptions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "packageType" "BillingPackageType" NOT NULL,
  "provider" "BillingPaymentProvider",
  "billingType" "PackageBillingType" NOT NULL,
  "billingInterval" "PackageBillingInterval" NOT NULL,
  "status" "UserSubscriptionStatus" NOT NULL DEFAULT 'PENDING',
  "paymentStatus" "SubscriptionPaymentStatus" NOT NULL DEFAULT 'PENDING',
  "startsAt" TIMESTAMP(3),
  "renewsAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "graceEndsAt" TIMESTAMP(3),
  "autoRenew" BOOLEAN NOT NULL DEFAULT false,
  "merchantSubscriptionId" TEXT,
  "providerSubscriptionId" TEXT,
  "setupOrderId" TEXT,
  "mandateStatus" TEXT,
  "subscriptionState" TEXT,
  "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "maxAmount" DECIMAL(12,2),
  "frequency" TEXT,
  "amountType" TEXT,
  "autoDebit" BOOLEAN NOT NULL DEFAULT false,
  "validAfter" TIMESTAMP(3),
  "providerExpireAt" TIMESTAMP(3),
  "nextBillingDate" TIMESTAMP(3),
  "pauseStartDate" TIMESTAMP(3),
  "pauseEndDate" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "cancellationReason" TEXT,
  "revocationReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_status_history" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "fromStatus" "UserSubscriptionStatus",
  "toStatus" "UserSubscriptionStatus" NOT NULL,
  "reason" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_status_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_transactions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "provider" "BillingPaymentProvider" NOT NULL,
  "transactionType" "PaymentTransactionType" NOT NULL,
  "transactionId" TEXT,
  "merchantTransactionId" TEXT,
  "merchantOrderId" TEXT,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" "PaymentTransactionStatus" NOT NULL DEFAULT 'PENDING',
  "rawRequest" JSONB,
  "rawResponse" JSONB,
  "redirectUrl" TEXT,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_logs" (
  "id" TEXT NOT NULL,
  "transactionId" TEXT,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "package_change_history" (
  "id" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "changedById" TEXT,
  "changeType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "package_change_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recurring_billing_events" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "eventType" "RecurringBillingEventType" NOT NULL,
  "providerReference" TEXT,
  "payload" JSONB NOT NULL,
  "state" TEXT,
  "occurredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recurring_billing_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_provider_configs" (
  "id" TEXT NOT NULL,
  "provider" "BillingPaymentProvider" NOT NULL,
  "environment" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "config" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_provider_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "packages_slug_key" ON "packages"("slug");
CREATE INDEX "packages_packageType_isActive_isVisibleOnRegistration_idx" ON "packages"("packageType", "isActive", "isVisibleOnRegistration");
CREATE INDEX "packages_billingType_billingInterval_idx" ON "packages"("billingType", "billingInterval");
CREATE UNIQUE INDEX "package_features_featureKey_key" ON "package_features"("featureKey");
CREATE INDEX "package_features_isActive_sortOrder_idx" ON "package_features"("isActive", "sortOrder");
CREATE UNIQUE INDEX "package_feature_values_packageId_featureId_key" ON "package_feature_values"("packageId", "featureId");
CREATE INDEX "package_feature_values_featureId_idx" ON "package_feature_values"("featureId");
CREATE UNIQUE INDEX "user_subscriptions_merchantSubscriptionId_key" ON "user_subscriptions"("merchantSubscriptionId");
CREATE INDEX "user_subscriptions_userId_status_idx" ON "user_subscriptions"("userId", "status");
CREATE INDEX "user_subscriptions_packageId_idx" ON "user_subscriptions"("packageId");
CREATE INDEX "user_subscriptions_billingType_billingInterval_idx" ON "user_subscriptions"("billingType", "billingInterval");
CREATE INDEX "user_subscriptions_nextBillingDate_idx" ON "user_subscriptions"("nextBillingDate");
CREATE INDEX "subscription_status_history_subscriptionId_createdAt_idx" ON "subscription_status_history"("subscriptionId", "createdAt");
CREATE UNIQUE INDEX "payment_transactions_merchantTransactionId_key" ON "payment_transactions"("merchantTransactionId");
CREATE UNIQUE INDEX "payment_transactions_merchantOrderId_key" ON "payment_transactions"("merchantOrderId");
CREATE INDEX "payment_transactions_userId_status_idx" ON "payment_transactions"("userId", "status");
CREATE INDEX "payment_transactions_subscriptionId_idx" ON "payment_transactions"("subscriptionId");
CREATE INDEX "payment_transactions_provider_transactionType_idx" ON "payment_transactions"("provider", "transactionType");
CREATE INDEX "payment_logs_transactionId_idx" ON "payment_logs"("transactionId");
CREATE INDEX "payment_logs_eventType_createdAt_idx" ON "payment_logs"("eventType", "createdAt");
CREATE INDEX "package_change_history_packageId_createdAt_idx" ON "package_change_history"("packageId", "createdAt");
CREATE INDEX "recurring_billing_events_subscriptionId_eventType_idx" ON "recurring_billing_events"("subscriptionId", "eventType");
CREATE INDEX "recurring_billing_events_providerReference_idx" ON "recurring_billing_events"("providerReference");
CREATE UNIQUE INDEX "payment_provider_configs_provider_environment_key" ON "payment_provider_configs"("provider", "environment");

ALTER TABLE "package_feature_values" ADD CONSTRAINT "package_feature_values_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "package_feature_values" ADD CONSTRAINT "package_feature_values_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "package_features"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_status_history" ADD CONSTRAINT "subscription_status_history_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "user_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "user_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_logs" ADD CONSTRAINT "payment_logs_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "payment_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "package_change_history" ADD CONSTRAINT "package_change_history_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recurring_billing_events" ADD CONSTRAINT "recurring_billing_events_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "user_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
