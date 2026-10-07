CREATE TABLE "AppPaymentRequest" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agencyUserId" TEXT NOT NULL,
    "agencyName" TEXT NOT NULL,
    "freelancerId" TEXT NOT NULL,
    "freelancerName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "requestedAmount" INTEGER NOT NULL,
    "approvedAmount" INTEGER,
    "commissionPercent" DECIMAL(5,2) NOT NULL DEFAULT 30,
    "platformCommissionAmount" INTEGER NOT NULL DEFAULT 0,
    "freelancerWalletAmount" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "rejectedReason" TEXT,
    "paymentProof" TEXT,
    "chatThreadId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'PHONEPE',
    "merchantOrderId" TEXT,
    "paymentLink" TEXT,
    "gatewayStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "gatewayReference" TEXT,
    "gatewayRawResponse" JSONB,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "walletCreditedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppPaymentRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppFreelancerWalletEntry" (
    "id" TEXT NOT NULL,
    "freelancerId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "grossAmount" INTEGER NOT NULL,
    "commissionPercent" DECIMAL(5,2) NOT NULL DEFAULT 30,
    "commissionAmount" INTEGER NOT NULL,
    "netAmount" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppFreelancerWalletEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppPaymentRequest_merchantOrderId_key" ON "AppPaymentRequest"("merchantOrderId");
CREATE INDEX "AppPaymentRequest_assignmentId_idx" ON "AppPaymentRequest"("assignmentId");
CREATE INDEX "AppPaymentRequest_tenantId_idx" ON "AppPaymentRequest"("tenantId");
CREATE INDEX "AppPaymentRequest_freelancerId_idx" ON "AppPaymentRequest"("freelancerId");
CREATE INDEX "AppPaymentRequest_status_idx" ON "AppPaymentRequest"("status");
CREATE INDEX "AppPaymentRequest_createdAt_idx" ON "AppPaymentRequest"("createdAt");

CREATE UNIQUE INDEX "AppFreelancerWalletEntry_paymentRequestId_key" ON "AppFreelancerWalletEntry"("paymentRequestId");
CREATE INDEX "AppFreelancerWalletEntry_freelancerId_idx" ON "AppFreelancerWalletEntry"("freelancerId");
CREATE INDEX "AppFreelancerWalletEntry_tenantId_idx" ON "AppFreelancerWalletEntry"("tenantId");
CREATE INDEX "AppFreelancerWalletEntry_assignmentId_idx" ON "AppFreelancerWalletEntry"("assignmentId");
CREATE INDEX "AppFreelancerWalletEntry_status_idx" ON "AppFreelancerWalletEntry"("status");
CREATE INDEX "AppFreelancerWalletEntry_createdAt_idx" ON "AppFreelancerWalletEntry"("createdAt");
