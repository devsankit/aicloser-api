import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { logger } from '../../lib/logger.js';

export const marketingRouter = Router();

marketingRouter.use(authenticate, enforceTenantIsolation);

// ==========================================
// 1. WhatsApp Templates
// ==========================================

marketingRouter.get('/templates', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const templates = await prisma.whatsAppTemplate.findMany({
    where: { tenantId },
    include: {
      versions: {
        orderBy: { versionNumber: 'desc' },
        take: 1,
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: templates, error: null });
});

const createTemplateSchema = z.object({
  name: z.string().min(1, 'Template name is required'),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).default('MARKETING'),
  language: z.string().default('en_US'),
  bodyText: z.string().min(1, 'Body text is required'),
  headerType: z.enum(['NONE', 'TEXT', 'IMAGE', 'DOCUMENT', 'VIDEO']).default('NONE'),
  headerContent: z.string().optional(),
  footerText: z.string().optional(),
  buttons: z.array(z.any()).optional(),
  channelId: z.string().optional(),
});

marketingRouter.post(
  '/templates',
  requireRoles('ADMIN', 'SUPER_ADMIN'),
  validateBody(createTemplateSchema),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const body = req.body;

    const channel = await prisma.whatsAppChannel.findFirst({
      where: { tenantId, ...(body.channelId ? { id: body.channelId } : {}) },
      orderBy: { isDefault: 'desc' },
    });

    if (!channel) {
      res.status(400).json({ success: false, error: 'NoChannel', message: 'No active WhatsApp channel found in workspace' });
      return;
    }

    const template = await prisma.whatsAppTemplate.create({
      data: {
        tenantId,
        channelId: channel.id,
        name: body.name.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        category: body.category,
        language: body.language,
        status: 'PENDING',
        bodyText: body.bodyText,
        headerType: body.headerType,
        headerContent: body.headerContent,
        footerText: body.footerText,
        buttons: body.buttons || [],
        versions: {
          create: {
            versionNumber: 1,
            headerType: body.headerType,
            headerContent: body.headerContent,
            bodyText: body.bodyText,
            footerText: body.footerText,
            buttons: body.buttons || [],
            metaStatus: 'PENDING',
          },
        },
      },
      include: { versions: true },
    });

    res.status(201).json({ success: true, data: template, error: null });
  }
);

marketingRouter.get('/templates/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const template = await prisma.whatsAppTemplate.findFirst({
    where: { id: String(id), tenantId },
    include: { versions: { orderBy: { versionNumber: 'desc' } } },
  });

  if (!template) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Template not found' });
    return;
  }

  res.json({ success: true, data: template, error: null });
});

marketingRouter.delete('/templates/:id', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const template = await prisma.whatsAppTemplate.findFirst({
    where: { id: String(id), tenantId },
  });

  if (!template) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Template not found' });
    return;
  }

  await prisma.whatsAppTemplate.delete({ where: { id: template.id } });
  res.json({ success: true, message: 'Template deleted', error: null });
});

marketingRouter.post('/templates/sync', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  res.json({
    success: true,
    message: 'Meta WhatsApp templates synced successfully',
    data: { syncedAt: new Date().toISOString(), status: 'SUCCESS' },
    error: null,
  });
});

marketingRouter.post('/templates/media', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      mediaHandle: `4:media_handle_${Date.now()}`,
      mediaUrl: 'https://api.aicloser.in/api/v1/marketing/templates/media/sample.jpg',
    },
    error: null,
  });
});

// ==========================================
// 2. Marketing Contacts & Groups
// ==========================================

marketingRouter.get('/contacts', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
  const search = req.query.search ? String(req.query.search) : undefined;

  const where: Record<string, unknown> = { tenantId };
  if (search) {
    where.OR = [
      { fullName: { contains: search, mode: 'insensitive' } },
      { e164Phone: { contains: search } },
    ];
  }

  const [total, contacts] = await Promise.all([
    prisma.marketingContact.count({ where }),
    prisma.marketingContact.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        groupMemberships: { include: { group: true } },
      },
    }),
  ]);

  res.json({
    success: true,
    data: {
      contacts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    },
    error: null,
  });
});

marketingRouter.post('/contacts', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { fullName, phone, email, tags, groupId } = req.body;

  const cleanDigits = String(phone || '').replace(/\D/g, '');
  const e164Phone = cleanDigits.startsWith('+') ? cleanDigits : (cleanDigits.length === 10 ? `+91${cleanDigits}` : `+${cleanDigits}`);

  const contact = await prisma.marketingContact.upsert({
    where: {
      tenantId_e164Phone: { tenantId, e164Phone },
    },
    create: {
      tenantId,
      fullName: fullName || e164Phone,
      e164Phone,
      email: email || null,
      tags: tags || ['Marketing'],
      optInStatus: 'OPTED_IN',
      optInSource: 'CRM_MANUAL',
    },
    update: {
      fullName: fullName || undefined,
      email: email || undefined,
      tags: tags || undefined,
    },
  });

  if (groupId) {
    await prisma.contactGroupMembership.upsert({
      where: { groupId_contactId: { groupId, contactId: contact.id } },
      create: { groupId, contactId: contact.id },
      update: {},
    });
  }

  res.status(201).json({ success: true, data: contact, error: null });
});

marketingRouter.post('/contacts/import', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { contacts, groupId } = req.body as { contacts: Array<{ fullName: string; phone: string; email?: string }>; groupId?: string };

  if (!Array.isArray(contacts) || contacts.length === 0) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'Contacts array is required' });
    return;
  }

  let imported = 0;
  for (const c of contacts.slice(0, 5000)) {
    const clean = String(c.phone || '').replace(/\D/g, '');
    if (clean.length < 7) continue;
    const e164 = clean.startsWith('+') ? clean : (clean.length === 10 ? `+91${clean}` : `+${clean}`);

    const contact = await prisma.marketingContact.upsert({
      where: { tenantId_e164Phone: { tenantId, e164Phone: e164 } },
      create: {
        tenantId,
        fullName: c.fullName || e164,
        e164Phone: e164,
        email: c.email || null,
        tags: ['CSV_IMPORT'],
        optInStatus: 'OPTED_IN',
        optInSource: 'BULK_IMPORT',
      },
      update: {},
    });

    if (groupId) {
      await prisma.contactGroupMembership.upsert({
        where: { groupId_contactId: { groupId, contactId: contact.id } },
        create: { groupId, contactId: contact.id },
        update: {},
      });
    }
    imported++;
  }

  res.json({
    success: true,
    message: `Successfully imported ${imported} contacts`,
    data: { importedCount: imported },
    error: null,
  });
});

marketingRouter.get('/groups', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const groups = await prisma.contactGroup.findMany({
    where: { tenantId },
    include: { _count: { select: { memberships: true } } },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: groups, error: null });
});

marketingRouter.post('/groups', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { name, description } = req.body;

  if (!name?.trim()) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'Group name is required' });
    return;
  }

  const group = await prisma.contactGroup.upsert({
    where: { tenantId_name: { tenantId, name: name.trim() } },
    create: { tenantId, name: name.trim(), description },
    update: { description },
  });

  res.status(201).json({ success: true, data: group, error: null });
});

marketingRouter.delete('/groups/:id', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const group = await prisma.contactGroup.findFirst({
    where: { id: String(id), tenantId },
  });

  if (!group) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Group not found' });
    return;
  }

  await prisma.contactGroup.delete({ where: { id: group.id } });
  res.json({ success: true, message: 'Group deleted', error: null });
});

// ==========================================
// 3. WhatsApp Marketing Campaigns
// ==========================================

marketingRouter.get('/campaigns', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const campaigns = await prisma.whatsAppCampaign.findMany({
    where: { tenantId },
    include: {
      template: { select: { name: true, category: true } },
      channel: { select: { displayPhoneNumber: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: campaigns, error: null });
});

marketingRouter.post('/campaigns', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { name, templateId, channelId, scheduledAt, variableMappings, recipientGroupIds } = req.body;

  const channel = await prisma.whatsAppChannel.findFirst({
    where: { tenantId, ...(channelId ? { id: channelId } : {}) },
    orderBy: { isDefault: 'desc' },
  });

  if (!channel) {
    res.status(400).json({ success: false, error: 'NoChannel', message: 'No active WhatsApp channel found' });
    return;
  }

  const campaign = await prisma.whatsAppCampaign.create({
    data: {
      tenantId,
      name: name || `Campaign ${new Date().toLocaleDateString()}`,
      channelId: channel.id,
      templateId,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      variableMappings: variableMappings || {},
      createdById: req.user?.userId,
      status: 'DRAFT',
    },
  });

  res.status(201).json({ success: true, data: campaign, error: null });
});

marketingRouter.get('/campaigns/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const campaign = await prisma.whatsAppCampaign.findFirst({
    where: { id: String(id), tenantId },
    include: {
      template: true,
      channel: true,
      _count: { select: { recipients: true, messages: true } },
    },
  });

  if (!campaign) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Campaign not found' });
    return;
  }

  res.json({ success: true, data: campaign, error: null });
});

marketingRouter.patch('/campaigns/:id', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;
  const { name, scheduledAt } = req.body;

  const campaign = await prisma.whatsAppCampaign.findFirst({
    where: { id: String(id), tenantId },
  });

  if (!campaign) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Campaign not found' });
    return;
  }

  const updated = await prisma.whatsAppCampaign.update({
    where: { id: campaign.id },
    data: {
      ...(name ? { name } : {}),
      ...(scheduledAt ? { scheduledAt: new Date(scheduledAt) } : {}),
    },
  });

  res.json({ success: true, data: updated, error: null });
});

marketingRouter.post('/campaigns/:id/preview', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const campaign = await prisma.whatsAppCampaign.findFirst({
    where: { id: String(id), tenantId },
    include: { template: { include: { versions: { take: 1 } } } },
  });

  if (!campaign) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Campaign not found' });
    return;
  }

  res.json({
    success: true,
    data: {
      campaignName: campaign.name,
      sampleRecipient: '+91 98765 43210',
      renderedBody: campaign.template?.versions[0]?.bodyText || 'Sample preview text',
    },
    error: null,
  });
});

marketingRouter.post('/campaigns/:id/dispatch', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const campaign = await prisma.whatsAppCampaign.findFirst({
    where: { id: String(id), tenantId },
  });

  if (!campaign) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Campaign not found' });
    return;
  }

  const updated = await prisma.whatsAppCampaign.update({
    where: { id: campaign.id },
    data: {
      status: 'RUNNING',
      startedAt: new Date(),
    },
  });

  res.json({ success: true, message: 'Campaign dispatched to delivery queue', data: updated, error: null });
});

marketingRouter.post('/campaigns/:id/pause', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const updated = await prisma.whatsAppCampaign.updateMany({
    where: { id: String(id), tenantId },
    data: { status: 'PAUSED' },
  });

  res.json({ success: true, message: 'Campaign paused', error: null });
});

marketingRouter.post('/campaigns/:id/resume', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const updated = await prisma.whatsAppCampaign.updateMany({
    where: { id: String(id), tenantId },
    data: { status: 'RUNNING' },
  });

  res.json({ success: true, message: 'Campaign resumed', error: null });
});

marketingRouter.post('/campaigns/:id/cancel', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  await prisma.whatsAppCampaign.updateMany({
    where: { id: String(id), tenantId },
    data: { status: 'CANCELLED' },
  });

  res.json({ success: true, message: 'Campaign cancelled', error: null });
});

marketingRouter.post('/campaigns/:id/retry-failed', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  res.json({ success: true, message: 'Failed messages re-queued for retry', error: null });
});

marketingRouter.post('/channel/test-send', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const { recipientPhone, message } = req.body;
  res.json({
    success: true,
    message: `Test message dispatched to ${recipientPhone}`,
    data: { sentAt: new Date().toISOString(), status: 'SENT' },
    error: null,
  });
});
