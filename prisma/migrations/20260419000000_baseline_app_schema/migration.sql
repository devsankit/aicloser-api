-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'EDITOR', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "TeamMembershipStatus" AS ENUM ('INVITED', 'REQUESTED', 'ACTIVE', 'SUSPENDED', 'DECLINED');

-- CreateEnum
CREATE TYPE "TenantSubscriptionPlan" AS ENUM ('INTERNAL', 'STARTER', 'GROWTH', 'SCALE');

-- CreateEnum
CREATE TYPE "PaymentSecurityStatus" AS ENUM ('PENDING', 'SECURED_FOR_EDITOR', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('YOUTUBE_VIDEO', 'IMAGE', 'THUMBNAIL', 'FILE');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'SHORTLISTED', 'ASSIGNED', 'CUSTOMER_CONTACTED', 'NEGOTIATING', 'PAYMENT_PENDING', 'IN_PROGRESS', 'DELIVERED', 'PAYOUT_PENDING', 'CLOSED');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('DRAFT', 'PAYMENT_PENDING', 'PAID', 'DELIVERED', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('DASHBOARD', 'WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAUSED');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "MonetizationPlan" AS ENUM ('STANDARD_COMMISSION', 'SUBSCRIPTION_MONTHLY', 'SUBSCRIPTION_QUARTERLY', 'SUBSCRIPTION_YEARLY');

-- CreateEnum
CREATE TYPE "PayoutRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "ConversationRouting" AS ENUM ('CLIENT_VISIBLE', 'MANAGER_INTERNAL');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'INTERNAL_REVIEW', 'MANAGER_APPROVED', 'CLIENT_SENT', 'PAID', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('DRAFT', 'SHARED', 'EXPIRED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ShowcasePermissionStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "PlatformYouTubeConnectionStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "PlatformYouTubePublishJobStatus" AS ENUM ('PENDING', 'UPLOADING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "AppRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'FREELANCER');

-- CreateEnum
CREATE TYPE "AppPackageAudience" AS ENUM ('FREELANCER', 'AGENCY');

-- CreateEnum
CREATE TYPE "AppPackageStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AppWorkspaceMode" AS ENUM ('AGENCY', 'FREELANCER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "phone" TEXT,
    "authProvider" TEXT NOT NULL DEFAULT 'email',
    "wordpressUserId" INTEGER,
    "role" "UserRole" NOT NULL DEFAULT 'EDITOR',
    "tenantId" TEXT,
    "onboardingStatus" "VerificationStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditorProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wordpressServiceId" INTEGER,
    "title" TEXT,
    "bio" TEXT,
    "category" TEXT,
    "deliveryTime" TEXT,
    "startingPrice" DECIMAL(10,2),
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true,
    "avatarUrl" TEXT,
    "youtubeChannelUrl" TEXT,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'DRAFT',
    "paymentSetupComplete" BOOLEAN NOT NULL DEFAULT false,
    "monetizationPlan" "MonetizationPlan" NOT NULL DEFAULT 'STANDARD_COMMISSION',
    "commissionRate" DECIMAL(5,2) NOT NULL DEFAULT 30,
    "directQuoteEnabled" BOOLEAN NOT NULL DEFAULT false,
    "responseScore" INTEGER NOT NULL DEFAULT 0,
    "deliveryScore" INTEGER NOT NULL DEFAULT 0,
    "clientRatingScore" DECIMAL(3,2),
    "karmaScore" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'PENDING',
    "subscriptionPlan" "TenantSubscriptionPlan" NOT NULL DEFAULT 'STARTER',
    "setupFeePaid" BOOLEAN NOT NULL DEFAULT false,
    "editorSeatLimit" INTEGER NOT NULL DEFAULT 3,
    "whatsappPhone" TEXT,
    "whatsappDisplayName" TEXT,
    "publicPageTitle" TEXT,
    "publicPageDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMembership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "editorProfileId" TEXT NOT NULL,
    "invitedById" TEXT,
    "status" "TeamMembershipStatus" NOT NULL DEFAULT 'INVITED',
    "assignmentEligible" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "editorProfileId" TEXT NOT NULL,
    "wordpressServiceId" INTEGER,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "priceType" TEXT,
    "price" DECIMAL(10,2),
    "deliveryTime" TEXT,
    "sourceUrl" TEXT,
    "sourceSystem" TEXT NOT NULL DEFAULT 'wordpress',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" "ServiceStatus" NOT NULL DEFAULT 'DRAFT',
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "seoSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "youtubeId" TEXT,
    "thumbnailUrl" TEXT,
    "altText" TEXT,
    "fileSizeKb" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "uploadStatus" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "deliveryUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "customerBudgetMin" DECIMAL(10,2),
    "customerBudgetMax" DECIMAL(10,2),
    "urgency" TEXT,
    "prompt" TEXT NOT NULL,
    "extractedIntent" JSONB,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "whatsappThreadRef" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchResult" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "rationale" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "leadId" TEXT NOT NULL,
    "editorProfileId" TEXT NOT NULL,
    "assignedById" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'ASSIGNED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "agreedAmount" DECIMAL(10,2) NOT NULL,
    "commissionAmount" DECIMAL(10,2) NOT NULL,
    "payoutAmount" DECIMAL(10,2) NOT NULL,
    "status" "DealStatus" NOT NULL DEFAULT 'DRAFT',
    "paymentReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "quoteId" TEXT,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "editorAmount" DECIMAL(10,2) NOT NULL,
    "status" "DealStatus" NOT NULL DEFAULT 'DRAFT',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationDocument" (
    "id" TEXT NOT NULL,
    "editorProfileId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentNumber" TEXT,
    "fileUrl" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletLedgerEntry" (
    "id" TEXT NOT NULL,
    "editorProfileId" TEXT NOT NULL,
    "dealId" TEXT,
    "quoteId" TEXT,
    "type" TEXT NOT NULL,
    "grossAmount" DECIMAL(10,2),
    "commissionAmount" DECIMAL(10,2),
    "netAmount" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutRequest" (
    "id" TEXT NOT NULL,
    "editorProfileId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "PayoutRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "leadId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "externalThreadRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageEvent" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT,
    "routing" "ConversationRouting" NOT NULL,
    "body" TEXT NOT NULL,
    "deliveredExternally" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "conversationId" TEXT NOT NULL,
    "editorProfileId" TEXT NOT NULL,
    "serviceId" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "baseAmount" DECIMAL(10,2) NOT NULL,
    "addonAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "finalAmount" DECIMAL(10,2) NOT NULL,
    "directPayAllowed" BOOLEAN NOT NULL DEFAULT false,
    "managerApprovedAt" TIMESTAMP(3),
    "sentToClientAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLineItem" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "conversationId" TEXT NOT NULL,
    "quoteId" TEXT,
    "driveFileId" TEXT,
    "publicUrl" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShowcasePermission" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "serviceId" TEXT,
    "status" "ShowcasePermissionStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowcasePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentSecurityRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT,
    "quoteId" TEXT,
    "status" "PaymentSecurityStatus" NOT NULL DEFAULT 'PENDING',
    "securedAmount" DECIMAL(10,2),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentSecurityRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformYouTubeConnection" (
    "id" TEXT NOT NULL,
    "connectionKey" TEXT NOT NULL,
    "status" "PlatformYouTubeConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "channelId" TEXT,
    "channelName" TEXT,
    "channelHandle" TEXT,
    "refreshTokenCipher" TEXT,
    "accessTokenCipher" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "connectedAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformYouTubeConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformYouTubePublishJob" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "tenantId" TEXT,
    "conversationId" TEXT NOT NULL,
    "freelancerId" TEXT,
    "freelancerName" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "privacy" TEXT NOT NULL,
    "categoryId" TEXT,
    "tags" TEXT[],
    "madeForKids" BOOLEAN NOT NULL DEFAULT false,
    "status" "PlatformYouTubePublishJobStatus" NOT NULL DEFAULT 'PENDING',
    "sourceFilePath" TEXT NOT NULL,
    "sourceFileName" TEXT NOT NULL,
    "sourceMimeType" TEXT NOT NULL,
    "sourceSizeBytes" BIGINT,
    "youtubeVideoId" TEXT,
    "youtubeVideoUrl" TEXT,
    "lastError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformYouTubePublishJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppAuthUser" (
    "id" TEXT NOT NULL,
    "role" "AppRole" NOT NULL,
    "assignedRole" "AppRole" NOT NULL,
    "tenantId" TEXT,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT NOT NULL,
    "loginPhoneAliases" TEXT[],
    "packageId" TEXT,
    "packageName" TEXT,
    "packageAudience" "AppPackageAudience",
    "packageStatus" "AppPackageStatus",
    "packageExpiresAt" TIMESTAMP(3),
    "workspaceMode" "AppWorkspaceMode",
    "passwordSalt" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "otpCode" TEXT NOT NULL,
    "permissions" TEXT[],
    "isSeeded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "lastOtpSentAt" TIMESTAMP(3),

    CONSTRAINT "AppAuthUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppAuthChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveryMode" TEXT NOT NULL,

    CONSTRAINT "AppAuthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppPasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "AppPasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppFreelancerWorkspace" (
    "userId" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "verification" JSONB NOT NULL,
    "paymentDetails" JSONB NOT NULL,
    "payoutRequests" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppFreelancerWorkspace_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AppFreelancerService" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "ownerAlias" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppFreelancerService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppConversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "serviceSlug" TEXT NOT NULL,
    "assignedFreelancerId" TEXT,
    "assignedFreelancerName" TEXT,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "leadStatusId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppPublishingDraft" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ownerDisplayName" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "linkedEntityId" TEXT,
    "currentStep" TEXT,
    "missingFields" TEXT[],
    "payload" JSONB NOT NULL,
    "rawMessages" JSONB NOT NULL,
    "lastSuggestedValues" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppPublishingDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_wordpressUserId_key" ON "User"("wordpressUserId");

-- CreateIndex
CREATE UNIQUE INDEX "EditorProfile_userId_key" ON "EditorProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_ownerUserId_key" ON "Tenant"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMembership_tenantId_editorProfileId_key" ON "TeamMembership"("tenantId", "editorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_wordpressServiceId_key" ON "Service"("wordpressServiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_slug_key" ON "Service"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_leadId_key" ON "Deal"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_quoteId_key" ON "Deal"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_dealId_key" ON "Payout"("dealId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformYouTubeConnection_connectionKey_key" ON "PlatformYouTubeConnection"("connectionKey");

-- CreateIndex
CREATE INDEX "PlatformYouTubePublishJob_assetId_idx" ON "PlatformYouTubePublishJob"("assetId");

-- CreateIndex
CREATE INDEX "PlatformYouTubePublishJob_draftId_idx" ON "PlatformYouTubePublishJob"("draftId");

-- CreateIndex
CREATE INDEX "PlatformYouTubePublishJob_status_idx" ON "PlatformYouTubePublishJob"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AppAuthUser_email_key" ON "AppAuthUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AppAuthUser_phone_key" ON "AppAuthUser"("phone");

-- CreateIndex
CREATE INDEX "AppAuthUser_tenantId_idx" ON "AppAuthUser"("tenantId");

-- CreateIndex
CREATE INDEX "AppAuthUser_role_idx" ON "AppAuthUser"("role");

-- CreateIndex
CREATE INDEX "AppAuthUser_assignedRole_idx" ON "AppAuthUser"("assignedRole");

-- CreateIndex
CREATE INDEX "AppAuthChallenge_userId_idx" ON "AppAuthChallenge"("userId");

-- CreateIndex
CREATE INDEX "AppAuthChallenge_phone_idx" ON "AppAuthChallenge"("phone");

-- CreateIndex
CREATE INDEX "AppAuthChallenge_expiresAt_idx" ON "AppAuthChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppPasswordResetToken_tokenHash_key" ON "AppPasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AppPasswordResetToken_userId_idx" ON "AppPasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "AppPasswordResetToken_expiresAt_idx" ON "AppPasswordResetToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppFreelancerService_slug_key" ON "AppFreelancerService"("slug");

-- CreateIndex
CREATE INDEX "AppFreelancerService_ownerId_idx" ON "AppFreelancerService"("ownerId");

-- CreateIndex
CREATE INDEX "AppFreelancerService_status_idx" ON "AppFreelancerService"("status");

-- CreateIndex
CREATE INDEX "AppConversation_tenantId_idx" ON "AppConversation"("tenantId");

-- CreateIndex
CREATE INDEX "AppConversation_serviceId_idx" ON "AppConversation"("serviceId");

-- CreateIndex
CREATE INDEX "AppConversation_assignedFreelancerId_idx" ON "AppConversation"("assignedFreelancerId");

-- CreateIndex
CREATE INDEX "AppConversation_status_idx" ON "AppConversation"("status");

-- CreateIndex
CREATE INDEX "AppPublishingDraft_ownerId_mode_idx" ON "AppPublishingDraft"("ownerId", "mode");

-- CreateIndex
CREATE INDEX "AppPublishingDraft_status_idx" ON "AppPublishingDraft"("status");

-- CreateIndex
CREATE INDEX "AppPublishingDraft_linkedEntityId_idx" ON "AppPublishingDraft"("linkedEntityId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditorProfile" ADD CONSTRAINT "EditorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_editorProfileId_fkey" FOREIGN KEY ("editorProfileId") REFERENCES "EditorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_editorProfileId_fkey" FOREIGN KEY ("editorProfileId") REFERENCES "EditorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_editorProfileId_fkey" FOREIGN KEY ("editorProfileId") REFERENCES "EditorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationDocument" ADD CONSTRAINT "VerificationDocument_editorProfileId_fkey" FOREIGN KEY ("editorProfileId") REFERENCES "EditorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_editorProfileId_fkey" FOREIGN KEY ("editorProfileId") REFERENCES "EditorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_editorProfileId_fkey" FOREIGN KEY ("editorProfileId") REFERENCES "EditorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageEvent" ADD CONSTRAINT "MessageEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_editorProfileId_fkey" FOREIGN KEY ("editorProfileId") REFERENCES "EditorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLineItem" ADD CONSTRAINT "QuoteLineItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAsset" ADD CONSTRAINT "DeliveryAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAsset" ADD CONSTRAINT "DeliveryAsset_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAsset" ADD CONSTRAINT "DeliveryAsset_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcasePermission" ADD CONSTRAINT "ShowcasePermission_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSecurityRecord" ADD CONSTRAINT "PaymentSecurityRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSecurityRecord" ADD CONSTRAINT "PaymentSecurityRecord_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSecurityRecord" ADD CONSTRAINT "PaymentSecurityRecord_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppAuthChallenge" ADD CONSTRAINT "AppAuthChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppPasswordResetToken" ADD CONSTRAINT "AppPasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppFreelancerWorkspace" ADD CONSTRAINT "AppFreelancerWorkspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
