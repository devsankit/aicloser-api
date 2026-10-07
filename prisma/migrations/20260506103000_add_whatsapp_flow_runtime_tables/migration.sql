CREATE TABLE "whatsapp_flows" (
  "id" TEXT NOT NULL,
  "platformScope" TEXT NOT NULL DEFAULT 'platform',
  "tenantId" TEXT,
  "agencyId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "channel" TEXT NOT NULL DEFAULT 'whatsapp',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "nodesJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "edgesJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "settingsJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "validationJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  CONSTRAINT "whatsapp_flows_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_flow_versions" (
  "id" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "snapshotJson" JSONB NOT NULL,
  "changelog" TEXT,
  "publishedBy" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_flow_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_flow_runs" (
  "id" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  "tenantId" TEXT,
  "agencyId" TEXT,
  "contactId" TEXT NOT NULL,
  "conversationId" TEXT,
  "channel" TEXT NOT NULL DEFAULT 'whatsapp',
  "status" TEXT NOT NULL,
  "currentNodeId" TEXT,
  "waitingNodeId" TEXT,
  "waitingFor" TEXT,
  "inboundMessageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "contextJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  CONSTRAINT "whatsapp_flow_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_flow_events" (
  "id" TEXT NOT NULL,
  "flowRunId" TEXT,
  "flowId" TEXT,
  "tenantId" TEXT,
  "nodeId" TEXT,
  "eventType" TEXT NOT NULL,
  "inputJson" JSONB,
  "outputJson" JSONB,
  "status" TEXT NOT NULL,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_flow_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_webhook_message_events" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "phoneNumberId" TEXT,
  "tenantId" TEXT,
  "agencyId" TEXT,
  "payloadJson" JSONB NOT NULL,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_webhook_message_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_flow_versions_flowId_version_key" ON "whatsapp_flow_versions"("flowId", "version");
CREATE UNIQUE INDEX "whatsapp_webhook_message_events_provider_messageId_key" ON "whatsapp_webhook_message_events"("provider", "messageId");

CREATE INDEX "whatsapp_flows_tenantId_channel_status_idx" ON "whatsapp_flows"("tenantId", "channel", "status");
CREATE INDEX "whatsapp_flows_agencyId_channel_status_idx" ON "whatsapp_flows"("agencyId", "channel", "status");
CREATE INDEX "whatsapp_flows_platformScope_channel_status_idx" ON "whatsapp_flows"("platformScope", "channel", "status");
CREATE INDEX "whatsapp_flows_updatedAt_idx" ON "whatsapp_flows"("updatedAt");
CREATE INDEX "whatsapp_flow_versions_flowId_createdAt_idx" ON "whatsapp_flow_versions"("flowId", "createdAt");
CREATE INDEX "whatsapp_flow_runs_flowId_status_idx" ON "whatsapp_flow_runs"("flowId", "status");
CREATE INDEX "whatsapp_flow_runs_tenantId_channel_status_idx" ON "whatsapp_flow_runs"("tenantId", "channel", "status");
CREATE INDEX "whatsapp_flow_runs_conversationId_idx" ON "whatsapp_flow_runs"("conversationId");
CREATE INDEX "whatsapp_flow_runs_updatedAt_idx" ON "whatsapp_flow_runs"("updatedAt");
CREATE INDEX "whatsapp_flow_events_flowRunId_createdAt_idx" ON "whatsapp_flow_events"("flowRunId", "createdAt");
CREATE INDEX "whatsapp_flow_events_flowId_createdAt_idx" ON "whatsapp_flow_events"("flowId", "createdAt");
CREATE INDEX "whatsapp_flow_events_tenantId_eventType_createdAt_idx" ON "whatsapp_flow_events"("tenantId", "eventType", "createdAt");
CREATE INDEX "whatsapp_flow_events_eventType_createdAt_idx" ON "whatsapp_flow_events"("eventType", "createdAt");
CREATE INDEX "whatsapp_webhook_message_events_phoneNumberId_createdAt_idx" ON "whatsapp_webhook_message_events"("phoneNumberId", "createdAt");
CREATE INDEX "whatsapp_webhook_message_events_tenantId_createdAt_idx" ON "whatsapp_webhook_message_events"("tenantId", "createdAt");

ALTER TABLE "whatsapp_flow_versions" ADD CONSTRAINT "whatsapp_flow_versions_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "whatsapp_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_flow_runs" ADD CONSTRAINT "whatsapp_flow_runs_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "whatsapp_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_flow_events" ADD CONSTRAINT "whatsapp_flow_events_flowRunId_fkey" FOREIGN KEY ("flowRunId") REFERENCES "whatsapp_flow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "whatsapp_flow_events" ADD CONSTRAINT "whatsapp_flow_events_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "whatsapp_flows"("id") ON DELETE SET NULL ON UPDATE CASCADE;
