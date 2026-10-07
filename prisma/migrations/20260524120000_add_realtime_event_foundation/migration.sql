CREATE INDEX IF NOT EXISTS "DevicePushToken_platform_isActive_idx" ON "DevicePushToken"("platform", "isActive");
CREATE INDEX IF NOT EXISTS "DevicePushToken_lastSeenAt_idx" ON "DevicePushToken"("lastSeenAt");

CREATE INDEX IF NOT EXISTS "AppNotification_userId_readAt_idx" ON "AppNotification"("userId", "readAt");
CREATE INDEX IF NOT EXISTS "AppNotification_tenantId_userId_idx" ON "AppNotification"("tenantId", "userId");

CREATE TABLE IF NOT EXISTS "AppRealtimeEvent" (
  "id" TEXT PRIMARY KEY,
  "topic" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "tenantId" TEXT,
  "actorUserId" TEXT,
  "audienceUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "audienceRoles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "payload" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "AppRealtimeEvent_topic_createdAt_idx" ON "AppRealtimeEvent"("topic", "createdAt");
CREATE INDEX IF NOT EXISTS "AppRealtimeEvent_tenantId_createdAt_idx" ON "AppRealtimeEvent"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "AppRealtimeEvent_actorUserId_createdAt_idx" ON "AppRealtimeEvent"("actorUserId", "createdAt");

CREATE TABLE IF NOT EXISTS "AppChatMessageReceipt" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT,
  "conversationId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deliveredAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "AppChatMessageReceipt_messageId_userId_key" ON "AppChatMessageReceipt"("messageId", "userId");
CREATE INDEX IF NOT EXISTS "AppChatMessageReceipt_tenantId_conversationId_idx" ON "AppChatMessageReceipt"("tenantId", "conversationId");
CREATE INDEX IF NOT EXISTS "AppChatMessageReceipt_conversationId_userId_idx" ON "AppChatMessageReceipt"("conversationId", "userId");
CREATE INDEX IF NOT EXISTS "AppChatMessageReceipt_readAt_idx" ON "AppChatMessageReceipt"("readAt");

CREATE TABLE IF NOT EXISTS "AppChatTypingPresence" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT,
  "conversationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT,
  "isTyping" BOOLEAN NOT NULL DEFAULT FALSE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "AppChatTypingPresence_conversationId_userId_key" ON "AppChatTypingPresence"("conversationId", "userId");
CREATE INDEX IF NOT EXISTS "AppChatTypingPresence_tenantId_conversationId_idx" ON "AppChatTypingPresence"("tenantId", "conversationId");
CREATE INDEX IF NOT EXISTS "AppChatTypingPresence_expiresAt_idx" ON "AppChatTypingPresence"("expiresAt");
