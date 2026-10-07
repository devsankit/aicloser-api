CREATE TABLE "AppChannelSetupIntent" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "policyAcceptedAt" TIMESTAMP(3) NOT NULL,
    "createdIpHash" TEXT,
    "createdUserAgentHash" TEXT,
    "consumedIpHash" TEXT,
    "consumedUserAgentHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppChannelSetupIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppChannelSetupIntent_tokenHash_key" ON "AppChannelSetupIntent"("tokenHash");
CREATE INDEX "AppChannelSetupIntent_userId_channel_expiresAt_idx" ON "AppChannelSetupIntent"("userId", "channel", "expiresAt");
CREATE INDEX "AppChannelSetupIntent_tenantId_channel_expiresAt_idx" ON "AppChannelSetupIntent"("tenantId", "channel", "expiresAt");
CREATE INDEX "AppChannelSetupIntent_expiresAt_consumedAt_idx" ON "AppChannelSetupIntent"("expiresAt", "consumedAt");

ALTER TABLE "AppChannelSetupIntent" ADD CONSTRAINT "AppChannelSetupIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppAuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
