CREATE TYPE "GappWebinarPriceMode" AS ENUM ('FREE', 'PAID');

CREATE TYPE "GappWebinarRegistrationStatus" AS ENUM ('REGISTERED', 'PAYMENT_PENDING', 'PAYMENT_SUCCESS', 'PAYMENT_FAILED', 'CANCELLED');

CREATE TYPE "GappWebinarPaymentStatus" AS ENUM ('PENDING', 'INITIATED', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED');

CREATE TABLE "gapp_webinars" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "description" TEXT NOT NULL,
  "thumbnailUrl" TEXT,
  "thumbnailStoragePath" TEXT,
  "meetingLink" TEXT,
  "priceMode" "GappWebinarPriceMode" NOT NULL DEFAULT 'PAID',
  "priceAmount" DECIMAL(12,2) NOT NULL DEFAULT 99,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "phonePeEnabled" BOOLEAN NOT NULL DEFAULT true,
  "registrationEnabled" BOOLEAN NOT NULL DEFAULT true,
  "countdownEnabled" BOOLEAN NOT NULL DEFAULT true,
  "capacity" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "gapp_webinars_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gapp_webinar_registrations" (
  "id" TEXT NOT NULL,
  "webinarId" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "whatsappNumber" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "participantType" TEXT NOT NULL,
  "currentMonthlyProjects" TEXT NOT NULL,
  "status" "GappWebinarRegistrationStatus" NOT NULL DEFAULT 'REGISTERED',
  "sourcePath" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "gapp_webinar_registrations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gapp_webinar_payments" (
  "id" TEXT NOT NULL,
  "registrationId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'PHONEPE',
  "merchantTransactionId" TEXT NOT NULL,
  "merchantOrderId" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" "GappWebinarPaymentStatus" NOT NULL DEFAULT 'PENDING',
  "redirectUrl" TEXT,
  "rawRequest" JSONB,
  "rawResponse" JSONB,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "gapp_webinar_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gapp_webinars_slug_key" ON "gapp_webinars"("slug");
CREATE INDEX "gapp_webinars_registrationEnabled_scheduledAt_idx" ON "gapp_webinars"("registrationEnabled", "scheduledAt");
CREATE INDEX "gapp_webinar_registrations_webinarId_createdAt_idx" ON "gapp_webinar_registrations"("webinarId", "createdAt");
CREATE INDEX "gapp_webinar_registrations_status_idx" ON "gapp_webinar_registrations"("status");
CREATE INDEX "gapp_webinar_registrations_whatsappNumber_idx" ON "gapp_webinar_registrations"("whatsappNumber");
CREATE INDEX "gapp_webinar_registrations_email_idx" ON "gapp_webinar_registrations"("email");
CREATE UNIQUE INDEX "gapp_webinar_payments_merchantTransactionId_key" ON "gapp_webinar_payments"("merchantTransactionId");
CREATE UNIQUE INDEX "gapp_webinar_payments_merchantOrderId_key" ON "gapp_webinar_payments"("merchantOrderId");
CREATE INDEX "gapp_webinar_payments_registrationId_idx" ON "gapp_webinar_payments"("registrationId");
CREATE INDEX "gapp_webinar_payments_status_idx" ON "gapp_webinar_payments"("status");

ALTER TABLE "gapp_webinar_registrations"
  ADD CONSTRAINT "gapp_webinar_registrations_webinarId_fkey"
  FOREIGN KEY ("webinarId") REFERENCES "gapp_webinars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "gapp_webinar_payments"
  ADD CONSTRAINT "gapp_webinar_payments_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "gapp_webinar_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
