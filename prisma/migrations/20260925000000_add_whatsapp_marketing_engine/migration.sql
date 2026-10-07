-- CreateEnum
CREATE TYPE "WhatsAppChannelStatus" AS ENUM ('ACTIVE', 'PENDING_VERIFICATION', 'RESTRICTED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "WhatsAppTemplateCategory" AS ENUM ('MARKETING', 'UTILITY', 'AUTHENTICATION');

-- CreateEnum
CREATE TYPE "WhatsAppTemplateStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED');

-- CreateEnum
CREATE TYPE "WhatsAppHeaderType" AS ENUM ('NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "MarketingContactOptInStatus" AS ENUM ('OPTED_IN', 'OPTED_OUT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ContactImportJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "WhatsAppCampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "WhatsAppRecipientStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "WhatsAppMessageStatus" AS ENUM ('ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "WhatsAppSuppressionReason" AS ENUM ('OPT_OUT', 'BOUNCE', 'SPAM_COMPLAINT', 'MANUAL_BLOCK');

-- CreateTable
CREATE TABLE "WhatsAppChannel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "businessId" TEXT,
    "businessPortfolioId" TEXT,
    "wabaId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "displayPhoneNumber" TEXT NOT NULL,
    "verifiedName" TEXT,
    "qualityRating" TEXT,
    "messagingLimitTier" TEXT,
    "status" "WhatsAppChannelStatus" NOT NULL DEFAULT 'ACTIVE',
    "graphApiVersion" TEXT NOT NULL DEFAULT 'v22.0',
    "webhookVerifyToken" TEXT,
    "encryptedAccessToken" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "metaTemplateId" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en_US',
    "category" "WhatsAppTemplateCategory" NOT NULL DEFAULT 'MARKETING',
    "status" "WhatsAppTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "rejectionReason" TEXT,
    "qualityRating" TEXT,
    "headerType" "WhatsAppHeaderType" NOT NULL DEFAULT 'NONE',
    "headerContent" TEXT,
    "headerHandle" TEXT,
    "bodyText" TEXT NOT NULL,
    "footerText" TEXT,
    "buttons" JSONB,
    "exampleValues" JSONB,
    "hasVariables" BOOLEAN NOT NULL DEFAULT false,
    "variableCount" INTEGER NOT NULL DEFAULT 0,
    "isLatestVersion" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "headerType" "WhatsAppHeaderType" NOT NULL DEFAULT 'NONE',
    "headerContent" TEXT,
    "bodyText" TEXT NOT NULL,
    "footerText" TEXT,
    "buttons" JSONB,
    "exampleValues" JSONB,
    "metaStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppTemplateSyncLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "syncType" TEXT NOT NULL DEFAULT 'FULL_SYNC',
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "templatesCreated" INTEGER NOT NULL DEFAULT 0,
    "templatesUpdated" INTEGER NOT NULL DEFAULT 0,
    "templatesDeleted" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppTemplateSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingContact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "fullName" TEXT NOT NULL,
    "e164Phone" TEXT NOT NULL,
    "email" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "leadId" TEXT,
    "assignedAgentId" TEXT,
    "optInStatus" "MarketingContactOptInStatus" NOT NULL DEFAULT 'UNKNOWN',
    "optInSource" TEXT,
    "optInAt" TIMESTAMP(3),
    "optOutSource" TEXT,
    "optOutAt" TIMESTAMP(3),
    "timeZone" TEXT DEFAULT 'Asia/Kolkata',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customFields" JSONB,
    "lastCampaignSentAt" TIMESTAMP(3),
    "lastDeliveredAt" TIMESTAMP(3),
    "lastReadAt" TIMESTAMP(3),
    "lastRepliedAt" TIMESTAMP(3),
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactGroupMembership" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactGroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactImportJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'GOOGLE_SHEETS',
    "fileName" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "status" "ContactImportJobStatus" NOT NULL DEFAULT 'PENDING',
    "consentDeclared" BOOLEAN NOT NULL DEFAULT false,
    "consentSource" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ContactImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactImportRowError" (
    "id" TEXT NOT NULL,
    "importJobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawData" JSONB,
    "errorCode" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactImportRowError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppCampaign" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateLanguage" TEXT NOT NULL DEFAULT 'en_US',
    "name" TEXT NOT NULL,
    "status" "WhatsAppCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "readCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "repliedCount" INTEGER NOT NULL DEFAULT 0,
    "variableMappings" JSONB,
    "createdById" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppCampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "e164Phone" TEXT NOT NULL,
    "status" "WhatsAppRecipientStatus" NOT NULL DEFAULT 'QUEUED',
    "skipReason" TEXT,
    "resolvedVariables" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppCampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppCampaignMessage" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "status" "WhatsAppMessageStatus" NOT NULL DEFAULT 'ACCEPTED',
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppCampaignMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessageEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPayload" JSONB,
    "campaignId" TEXT,
    "contactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppMessageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppSuppression" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "e164Phone" TEXT NOT NULL,
    "reason" "WhatsAppSuppressionReason" NOT NULL DEFAULT 'OPT_OUT',
    "source" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppOptIn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "e164Phone" TEXT NOT NULL,
    "consentType" TEXT NOT NULL DEFAULT 'EXPLICIT_MARKETING',
    "proofSource" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppOptIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppAuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppChannel_phoneNumberId_key" ON "WhatsAppChannel"("phoneNumberId");
CREATE INDEX "WhatsAppChannel_tenantId_idx" ON "WhatsAppChannel"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTemplate_tenantId_name_language_key" ON "WhatsAppTemplate"("tenantId", "name", "language");
CREATE INDEX "WhatsAppTemplate_tenantId_idx" ON "WhatsAppTemplate"("tenantId");
CREATE INDEX "WhatsAppTemplate_channelId_idx" ON "WhatsAppTemplate"("channelId");
CREATE INDEX "WhatsAppTemplate_status_idx" ON "WhatsAppTemplate"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTemplateVersion_templateId_versionNumber_key" ON "WhatsAppTemplateVersion"("templateId", "versionNumber");
CREATE INDEX "WhatsAppTemplateVersion_templateId_idx" ON "WhatsAppTemplateVersion"("templateId");

-- CreateIndex
CREATE INDEX "WhatsAppTemplateSyncLog_tenantId_idx" ON "WhatsAppTemplateSyncLog"("tenantId");
CREATE INDEX "WhatsAppTemplateSyncLog_channelId_idx" ON "WhatsAppTemplateSyncLog"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingContact_tenantId_e164Phone_key" ON "MarketingContact"("tenantId", "e164Phone");
CREATE INDEX "MarketingContact_tenantId_idx" ON "MarketingContact"("tenantId");
CREATE INDEX "MarketingContact_e164Phone_idx" ON "MarketingContact"("e164Phone");
CREATE INDEX "MarketingContact_optInStatus_idx" ON "MarketingContact"("optInStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ContactGroup_tenantId_name_key" ON "ContactGroup"("tenantId", "name");
CREATE INDEX "ContactGroup_tenantId_idx" ON "ContactGroup"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactGroupMembership_groupId_contactId_key" ON "ContactGroupMembership"("groupId", "contactId");
CREATE INDEX "ContactGroupMembership_groupId_idx" ON "ContactGroupMembership"("groupId");
CREATE INDEX "ContactGroupMembership_contactId_idx" ON "ContactGroupMembership"("contactId");

-- CreateIndex
CREATE INDEX "ContactImportJob_tenantId_idx" ON "ContactImportJob"("tenantId");

-- CreateIndex
CREATE INDEX "ContactImportRowError_importJobId_idx" ON "ContactImportRowError"("importJobId");

-- CreateIndex
CREATE INDEX "WhatsAppCampaign_tenantId_idx" ON "WhatsAppCampaign"("tenantId");
CREATE INDEX "WhatsAppCampaign_channelId_idx" ON "WhatsAppCampaign"("channelId");
CREATE INDEX "WhatsAppCampaign_status_idx" ON "WhatsAppCampaign"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppCampaignRecipient_idempotencyKey_key" ON "WhatsAppCampaignRecipient"("idempotencyKey");
CREATE INDEX "WhatsAppCampaignRecipient_campaignId_idx" ON "WhatsAppCampaignRecipient"("campaignId");
CREATE INDEX "WhatsAppCampaignRecipient_contactId_idx" ON "WhatsAppCampaignRecipient"("contactId");
CREATE INDEX "WhatsAppCampaignRecipient_status_idx" ON "WhatsAppCampaignRecipient"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppCampaignMessage_wamid_key" ON "WhatsAppCampaignMessage"("wamid");
CREATE INDEX "WhatsAppCampaignMessage_campaignId_idx" ON "WhatsAppCampaignMessage"("campaignId");
CREATE INDEX "WhatsAppCampaignMessage_recipientId_idx" ON "WhatsAppCampaignMessage"("recipientId");
CREATE INDEX "WhatsAppCampaignMessage_wamid_idx" ON "WhatsAppCampaignMessage"("wamid");

-- CreateIndex
CREATE INDEX "WhatsAppMessageEvent_tenantId_idx" ON "WhatsAppMessageEvent"("tenantId");
CREATE INDEX "WhatsAppMessageEvent_wamid_idx" ON "WhatsAppMessageEvent"("wamid");
CREATE INDEX "WhatsAppMessageEvent_eventType_idx" ON "WhatsAppMessageEvent"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppSuppression_tenantId_e164Phone_key" ON "WhatsAppSuppression"("tenantId", "e164Phone");
CREATE INDEX "WhatsAppSuppression_tenantId_idx" ON "WhatsAppSuppression"("tenantId");
CREATE INDEX "WhatsAppSuppression_e164Phone_idx" ON "WhatsAppSuppression"("e164Phone");

-- CreateIndex
CREATE INDEX "WhatsAppOptIn_tenantId_idx" ON "WhatsAppOptIn"("tenantId");
CREATE INDEX "WhatsAppOptIn_contactId_idx" ON "WhatsAppOptIn"("contactId");
CREATE INDEX "WhatsAppOptIn_e164Phone_idx" ON "WhatsAppOptIn"("e164Phone");

-- CreateIndex
CREATE INDEX "WhatsAppAuditLog_tenantId_idx" ON "WhatsAppAuditLog"("tenantId");
CREATE INDEX "WhatsAppAuditLog_action_idx" ON "WhatsAppAuditLog"("action");
CREATE INDEX "WhatsAppAuditLog_createdAt_idx" ON "WhatsAppAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "WhatsAppTemplate" ADD CONSTRAINT "WhatsAppTemplate_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "WhatsAppChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppTemplateVersion" ADD CONSTRAINT "WhatsAppTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WhatsAppTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactGroupMembership" ADD CONSTRAINT "ContactGroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ContactGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactGroupMembership" ADD CONSTRAINT "ContactGroupMembership_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "MarketingContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactImportRowError" ADD CONSTRAINT "ContactImportRowError_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "ContactImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppCampaign" ADD CONSTRAINT "WhatsAppCampaign_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "WhatsAppChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppCampaign" ADD CONSTRAINT "WhatsAppCampaign_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WhatsAppTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppCampaignRecipient" ADD CONSTRAINT "WhatsAppCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "WhatsAppCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppCampaignRecipient" ADD CONSTRAINT "WhatsAppCampaignRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "MarketingContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppCampaignMessage" ADD CONSTRAINT "WhatsAppCampaignMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "WhatsAppCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppCampaignMessage" ADD CONSTRAINT "WhatsAppCampaignMessage_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "WhatsAppCampaignRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppOptIn" ADD CONSTRAINT "WhatsAppOptIn_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "MarketingContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
