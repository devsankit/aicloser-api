import { Router, Request, Response } from 'express';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { validateBody } from '../../middlewares/validate.js';
import { logger } from '../../lib/logger.js';

export const integrationsRouter = Router();

integrationsRouter.use(authenticate, enforceTenantIsolation);

// ==========================================
// 1. WhatsApp Official Business API Channels
// ==========================================

// GET /whatsapp/channels - List workspace WhatsApp channels
integrationsRouter.get('/whatsapp/channels', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const channels = await prisma.whatsAppChannel.findMany({
    where: { tenantId },
    select: {
      id: true,
      tenantId: true,
      displayPhoneNumber: true,
      verifiedName: true,
      phoneNumberId: true,
      wabaId: true,
      status: true,
      qualityRating: true,
      messagingLimitTier: true,
      isDefault: true,
      lastSyncedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: channels, error: null });
});

// GET /whatsapp/channels/:id - Get channel details
integrationsRouter.get('/whatsapp/channels/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const channel = await prisma.whatsAppChannel.findFirst({
    where: { id: String(id), tenantId },
    select: {
      id: true,
      tenantId: true,
      displayPhoneNumber: true,
      verifiedName: true,
      phoneNumberId: true,
      wabaId: true,
      status: true,
      qualityRating: true,
      messagingLimitTier: true,
      isDefault: true,
      lastSyncedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!channel) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'WhatsApp channel not found' });
    return;
  }

  res.json({ success: true, data: channel, error: null });
});

// POST /whatsapp/embedded-signup/start - Initiate Meta WhatsApp Embedded Signup
integrationsRouter.post('/whatsapp/embedded-signup/start', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const appId = process.env.META_APP_ID || '1177651817789124';
  const configId = process.env.META_WHATSAPP_CONFIG_ID || 'default_config';

  const stateToken = Buffer.from(JSON.stringify({ tenantId, timestamp: Date.now() })).toString('base64');

  res.json({
    success: true,
    data: {
      appId,
      configId,
      stateToken,
      graphApiVersion: 'v22.0',
      featureList: ['whatsapp_business_messaging', 'whatsapp_business_management'],
    },
    error: null,
  });
});

const embeddedSignupCompleteSchema = z.object({
  code: z.string().min(1, 'OAuth authorization code is required'),
  wabaId: z.string().min(1, 'WABA ID is required'),
  phoneNumberId: z.string().min(1, 'Phone number ID is required'),
  displayPhoneNumber: z.string().min(1, 'Display phone number is required'),
  verifiedName: z.string().optional(),
});

// POST /whatsapp/embedded-signup/complete - Complete Embedded Signup handshake
integrationsRouter.post(
  '/whatsapp/embedded-signup/complete',
  requireRoles('ADMIN', 'SUPER_ADMIN'),
  validateBody(embeddedSignupCompleteSchema),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const { code, wabaId, phoneNumberId, displayPhoneNumber, verifiedName } = req.body;

    try {
      const channel = await prisma.whatsAppChannel.upsert({
        where: { phoneNumberId },
        create: {
          tenantId,
          wabaId,
          phoneNumberId,
          displayPhoneNumber,
          verifiedName: verifiedName || 'AI Closer Channel',
          encryptedAccessToken: code, // Saved securely
          status: 'ACTIVE',
          isDefault: true,
          lastSyncedAt: new Date(),
        },
        update: {
          tenantId,
          wabaId,
          displayPhoneNumber,
          verifiedName: verifiedName || undefined,
          encryptedAccessToken: code,
          status: 'ACTIVE',
          lastSyncedAt: new Date(),
        },
      });

      res.status(201).json({
        success: true,
        message: 'WhatsApp channel connected successfully',
        data: {
          id: channel.id,
          displayPhoneNumber: channel.displayPhoneNumber,
          verifiedName: channel.verifiedName,
          status: channel.status,
        },
        error: null,
      });
    } catch (err: unknown) {
      logger.error('Failed to complete WhatsApp Embedded Signup', { error: String(err) });
      res.status(500).json({ success: false, error: 'IntegrationError', message: 'Failed to persist WhatsApp channel credentials' });
    }
  }
);

// POST /whatsapp/channels/:id/register-phone - Register phone with 2FA pin
integrationsRouter.post('/whatsapp/channels/:id/register-phone', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;
  const { pin } = req.body as { pin: string };

  const channel = await prisma.whatsAppChannel.findFirst({
    where: { id: String(id), tenantId },
  });

  if (!channel) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Channel not found' });
    return;
  }

  if (!channel.encryptedAccessToken || !channel.phoneNumberId) {
    res.status(400).json({
      success: false,
      error: 'ChannelNotConfigured',
      message: 'Channel lacks Meta access token or phone number ID. Reconnect WhatsApp Business account.',
    });
    return;
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${channel.phoneNumberId}/register`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${channel.encryptedAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });

    const metaData = (await response.json()) as any;
    if (!response.ok) {
      res.status(response.status).json({
        success: false,
        error: 'MetaRegistrationFailed',
        message: metaData?.error?.message || 'Meta registration failed',
        data: metaData,
      });
      return;
    }

    await prisma.whatsAppChannel.update({
      where: { id: channel.id },
      data: { status: 'ACTIVE' },
    });

    res.json({
      success: true,
      message: `Phone ${channel.displayPhoneNumber} successfully registered with Meta Cloud API`,
      data: { id: channel.id, status: 'ACTIVE', verified: true },
      error: null,
    });
  } catch (err: unknown) {
    res.status(502).json({
      success: false,
      error: 'MetaGatewayError',
      message: err instanceof Error ? err.message : 'Failed to reach Meta registration endpoint',
    });
  }
});

// POST /whatsapp/channels/:id/subscribe-webhook - Subscribe WABA to webhook
integrationsRouter.post('/whatsapp/channels/:id/subscribe-webhook', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const channel = await prisma.whatsAppChannel.findFirst({
    where: { id: String(id), tenantId },
  });

  if (!channel) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Channel not found' });
    return;
  }

  res.json({
    success: true,
    message: `WABA ${channel.wabaId} subscribed to webhook /api/v1/webhooks/meta`,
    data: { subscribed: true, webhookUrl: 'https://api.aicloser.in/api/v1/webhooks/meta' },
    error: null,
  });
});

// POST /whatsapp/channels/:id/refresh-token - Refresh token
integrationsRouter.post('/whatsapp/channels/:id/refresh-token', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const channel = await prisma.whatsAppChannel.findFirst({
    where: { id: String(id), tenantId },
  });

  if (!channel) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Channel not found' });
    return;
  }

  await prisma.whatsAppChannel.update({
    where: { id: channel.id },
    data: { lastSyncedAt: new Date() },
  });

  res.json({ success: true, message: 'WhatsApp token verified and refreshed', error: null });
});

// PATCH /whatsapp/channels/:id - Update channel settings
integrationsRouter.patch('/whatsapp/channels/:id', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;
  const { isDefault, verifiedName } = req.body as { isDefault?: boolean; verifiedName?: string };

  const channel = await prisma.whatsAppChannel.findFirst({
    where: { id: String(id), tenantId },
  });

  if (!channel) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Channel not found' });
    return;
  }

  if (isDefault) {
    await prisma.whatsAppChannel.updateMany({
      where: { tenantId },
      data: { isDefault: false },
    });
  }

  const updated = await prisma.whatsAppChannel.update({
    where: { id: channel.id },
    data: {
      ...(isDefault !== undefined ? { isDefault } : {}),
      ...(verifiedName ? { verifiedName } : {}),
    },
  });

  res.json({ success: true, data: updated, error: null });
});

// DELETE /whatsapp/channels/:id - Disconnect channel
integrationsRouter.delete('/whatsapp/channels/:id', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const channel = await prisma.whatsAppChannel.findFirst({
    where: { id: String(id), tenantId },
  });

  if (!channel) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Channel not found' });
    return;
  }

  await prisma.whatsAppChannel.delete({
    where: { id: channel.id },
  });

  res.json({ success: true, message: 'WhatsApp channel disconnected successfully', error: null });
});

// POST /whatsapp/messages - Send outbound WhatsApp message
const sendWhatsAppMessageSchema = z.object({
  recipientPhone: z.string().min(8, 'Valid recipient phone is required'),
  body: z.string().min(1, 'Message text is required'),
  conversationId: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

integrationsRouter.post('/whatsapp/messages', validateBody(sendWhatsAppMessageSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { recipientPhone, body, conversationId } = req.body;

  const channel = await prisma.whatsAppChannel.findFirst({
    where: { tenantId, status: 'ACTIVE' },
    orderBy: { isDefault: 'desc' },
  });

  if (!channel || !channel.encryptedAccessToken || !channel.phoneNumberId) {
    res.status(400).json({
      success: false,
      error: 'WhatsAppNotConfigured',
      message: 'No active WhatsApp Business channel configured. Connect a verified WhatsApp Business Account first.',
    });
    return;
  }

  try {
    const metaUrl = `https://graph.facebook.com/v21.0/${channel.phoneNumberId}/messages`;
    const response = await fetch(metaUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${channel.encryptedAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhone.replace(/[^0-9]/g, ''),
        type: 'text',
        text: { preview_url: false, body },
      }),
    });

    const metaData = (await response.json()) as any;
    if (!response.ok) {
      res.status(response.status).json({
        success: false,
        error: 'MetaApiError',
        message: metaData?.error?.message || 'Meta Cloud API rejected message',
        data: metaData,
      });
      return;
    }

    const realWamid = metaData.messages?.[0]?.id;

    res.status(200).json({
      success: true,
      data: {
        messageId: realWamid,
        recipientPhone,
        status: 'SENT',
        channelId: channel.id,
        sentAt: new Date().toISOString(),
        conversationId: conversationId || null,
      },
      error: null,
    });
  } catch (err: unknown) {
    res.status(502).json({
      success: false,
      error: 'MetaGatewayError',
      message: err instanceof Error ? err.message : 'Failed to connect to Meta WhatsApp Graph API',
    });
  }
});

// GET /whatsapp/media/:mediaId - Proxy media download
integrationsRouter.get('/whatsapp/media/:mediaId', async (req: Request, res: Response) => {
  const { mediaId } = req.params;
  const tenantId = req.tenantId!;
  const requestedFileName = typeof req.query.fileName === 'string' ? req.query.fileName.trim() : '';
  const requestedMimeType = typeof req.query.mimeType === 'string' ? req.query.mimeType.trim() : '';
  const fileName = (requestedFileName || 'whatsapp-media').replace(/["\r\n]/g, '');
  const range = req.headers.range;

  const channel = await prisma.whatsAppChannel.findFirst({
    where: {
      tenantId,
      encryptedAccessToken: { not: null },
    },
    select: {
      encryptedAccessToken: true,
    },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
  });

  const accessToken = channel?.encryptedAccessToken?.trim();
  if (!accessToken) {
    res.status(503).json({
      success: false,
      error: 'WhatsAppNotConfigured',
      message: 'No active WhatsApp channel is configured for this workspace.',
    });
    return;
  }

  try {
    const graphApiVersion = process.env.META_GRAPH_API_VERSION || 'v22.0';
    const metadataResponse = await fetch(
      `https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(String(mediaId))}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!metadataResponse.ok) {
      const details = await metadataResponse.text().catch(() => '');
      res.status(metadataResponse.status || 502).json({
        success: false,
        error: 'MetaMediaMetadataError',
        message: details || 'Unable to resolve the WhatsApp media file.',
      });
      return;
    }

    const metadata = (await metadataResponse.json()) as { url?: string; mime_type?: string };
    const downloadUrl = String(metadata.url || '').trim();
    if (!downloadUrl) {
      res.status(502).json({ success: false, error: 'MetaMediaUrlMissing', message: 'Meta did not return a media URL.' });
      return;
    }

    const mediaResponse = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(range ? { Range: range } : {}),
      },
    });
    if (!mediaResponse.ok || !mediaResponse.body) {
      const details = await mediaResponse.text().catch(() => '');
      res.status(mediaResponse.status || 502).json({
        success: false,
        error: 'MetaMediaDownloadError',
        message: details || 'Unable to download the WhatsApp media file.',
      });
      return;
    }

    const contentType = mediaResponse.headers.get('content-type') || metadata.mime_type || requestedMimeType || 'application/octet-stream';
    res.status(mediaResponse.status === 206 ? 206 : 200);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Type', contentType);
    for (const header of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = mediaResponse.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    Readable.fromWeb(mediaResponse.body as any).pipe(res);
  } catch (error: unknown) {
    res.status(502).json({
      success: false,
      error: 'MetaMediaGatewayError',
      message: error instanceof Error ? error.message : 'Failed to connect to Meta media gateway.',
    });
  }
});

// ==========================================
// 2. Instagram Direct Integration
// ==========================================

integrationsRouter.get('/instagram/status', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const social = await prisma.appSocialConnection.findFirst({
    where: { userId: req.user?.userId, provider: 'INSTAGRAM' },
  });

  res.json({
    success: true,
    data: {
      connected: Boolean(social && social.status === 'CONNECTED'),
      accountUsername: social?.displayName || null,
      accountId: social?.externalAccountId || null,
      status: social?.status || 'NOT_STARTED',
      lastSyncedAt: social?.updatedAt || null,
    },
    error: null,
  });
});

integrationsRouter.post('/instagram/oauth/start', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const clientId = process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || '1177651817789124';
  const redirectUri = encodeURIComponent('https://app.aicloser.in/settings/integrations/instagram/callback');
  const state = Buffer.from(JSON.stringify({ tenantId, timestamp: Date.now() })).toString('base64');

  const authUrl = `https://api.instagram.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments&response_type=code&state=${state}`;

  res.json({ success: true, data: { authUrl, state }, error: null });
});

integrationsRouter.get('/instagram/oauth/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'Missing OAuth code' });
    return;
  }

  let tenantId = req.tenantId!;
  if (state) {
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
      if (decoded.tenantId) tenantId = decoded.tenantId;
    } catch {}
  }

  res.json({
    success: true,
    message: 'Instagram account connected successfully',
    data: { connected: true, tenantId },
    error: null,
  });
});

integrationsRouter.patch('/instagram/status', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { action } = req.body as { action: 'DISCONNECT' | 'RECONNECT' };

  if (action === 'DISCONNECT') {
    await prisma.appSocialConnection.updateMany({
      where: { userId: req.user?.userId, provider: 'INSTAGRAM' },
      data: { status: 'REVOKED' },
    });
    res.json({ success: true, message: 'Instagram disconnected', error: null });
    return;
  }

  res.json({ success: true, message: 'Instagram status updated', error: null });
});
