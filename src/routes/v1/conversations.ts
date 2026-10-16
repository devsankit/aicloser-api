import { maskPhoneNumber, isPhoneMaskingRequired } from '../../lib/phone-mask.js';
import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { Prisma } from '@prisma/client';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { persistApiRealtimeEvent } from '../../lib/realtime.js';

export const conversationsRouter = Router();

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 }, storage: multer.memoryStorage() });

conversationsRouter.use(authenticate, enforceTenantIsolation);

export interface CleanChatMessage {
  id: string;
  body: string;
  lane: 'customer' | 'internal';
  createdAt: string;
  senderRole: 'sales' | 'customer' | 'system' | 'ai';
  senderLabel?: string;
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  attachments?: Array<{
    id?: string;
    name: string;
    mimeType?: string;
    sizeBytes?: number;
    url?: string;
    externalUrl?: string;
  }>;
}

const listConversationsQuerySchema = z.object({
  page: z.string().optional().transform((v) => (v ? Math.max(1, Number(v)) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, Math.max(1, Number(v))) : 25)),
  status: z.string().optional(),
  search: z.string().optional(),
  customerPhone: z.string().optional(),
  channel: z.string().optional(),
});

const sendMessageSchema = z.object({
  body: z.string().min(1, 'Message text is required'),
  lane: z.enum(['customer', 'internal']).optional().default('customer'),
  attachments: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        mimeType: z.string().optional(),
        sizeBytes: z.number().optional(),
        url: z.string().optional(),
        externalUrl: z.string().optional(),
      })
    )
    .optional(),
});

// Helper: Workspace Chat Visibility Policy ('ASSIGNED_ONLY' vs 'COMPANY_WIDE')
async function getChatVisibilityMode(tenantId: string): Promise<'ASSIGNED_ONLY' | 'COMPANY_WIDE'> {
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const settings = (workspace?.settings as Record<string, any>) || {};
  return (settings.chatVisibility as 'ASSIGNED_ONLY' | 'COMPANY_WIDE') || 'ASSIGNED_ONLY';
}

// Helper: Verify closer access to conversation
async function verifyCloserAccess(req: Request, conversation: { id: string; customerPhone?: string; assignedFreelancerId?: string | null }): Promise<boolean> {
  if (req.user?.role !== 'SALES_AGENT') return true;

  const tenantId = req.tenantId!;
  const mode = await getChatVisibilityMode(tenantId);
  if (mode === 'COMPANY_WIDE') {
    return true;
  }

  const profile = await prisma.salesAgentProfile.findFirst({
    where: { userId: req.user.userId, tenantId },
    select: { id: true },
  });

  if (!profile) return false;
  if (conversation.assignedFreelancerId === profile.id) return true;

  // Check if lead with this conversation or phone is assigned to this closer
  const lead = await prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      assignedAgentId: profile.id,
      OR: [
        { conversationId: conversation.id },
        ...(conversation.customerPhone ? [{ customerPhone: conversation.customerPhone }] : []),
      ],
    },
    select: { id: true },
  });

  return Boolean(lead);
}

// 1. GET / - List conversations with strict closer scoping and rich UI fields
conversationsRouter.get('/', validateQuery(listConversationsQuerySchema), async (req: Request, res: Response) => {
  const { page, limit, status, search, customerPhone, channel } = req.query as unknown as {
    page: number;
    limit: number;
    status?: string;
    search?: string;
    customerPhone?: string;
    channel?: string;
  };

  const tenantId = req.tenantId!;
  const andConditions: any[] = [{ tenantId }];

  // Strict SALES_AGENT permission scoping
  if (req.user?.role === 'SALES_AGENT') {
    const mode = await getChatVisibilityMode(tenantId);
    if (mode !== 'COMPANY_WIDE') {
      const profile = await prisma.salesAgentProfile.findFirst({
        where: { userId: req.user.userId, tenantId },
        select: { id: true },
      });

    const assignedLeads = profile
      ? await prisma.salesLeadAssignment.findMany({
          where: { assignedAgentId: profile.id, tenantId },
          select: { id: true, customerPhone: true, conversationId: true },
        })
      : [];

    const phones = assignedLeads.map((l) => l.customerPhone).filter(Boolean) as string[];
    const convIds = assignedLeads.map((l) => l.conversationId).filter(Boolean) as string[];

      andConditions.push({
        OR: [
          { assignedFreelancerId: profile?.id ?? '__NO_ACCESS__' },
          ...(convIds.length > 0 ? [{ id: { in: convIds } }] : []),
          ...(phones.length > 0 ? [{ customerPhone: { in: phones } }] : []),
        ],
      });
    }
  }

  if (status) andConditions.push({ status });
  if (customerPhone) andConditions.push({ customerPhone: { contains: customerPhone } });
  if (channel) andConditions.push({ serviceSlug: { contains: channel.toLowerCase() } });
  if (search) {
    andConditions.push({
      OR: [
        { customerName: { contains: search, mode: 'insensitive' } },
        { customerPhone: { contains: search } },
      ],
    });
  }

  const where = { AND: andConditions };

  const [total, conversations] = await Promise.all([
    prisma.appConversation.count({ where }),
    prisma.appConversation.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        tenantId: true,
        serviceSlug: true,
        customerName: true,
        customerPhone: true,
        status: true,
        payload: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  // Batch resolve matching lead records to populate UI fields
  const convIds = conversations.map((c) => c.id);
  const phones = conversations.map((c) => c.customerPhone).filter(Boolean);

  const matchingLeads = await prisma.salesLeadAssignment.findMany({
    where: {
      tenantId,
      OR: [
        { conversationId: { in: convIds } },
        { customerPhone: { in: phones } },
      ],
    },
    include: {
      assignedAgent: {
        select: {
          id: true,
          agentCode: true,
          user: { select: { displayName: true, email: true, phone: true } },
        },
      },
    },
  });

  const leadByConvId = new Map<string, (typeof matchingLeads)[0]>();
  const leadByPhone = new Map<string, (typeof matchingLeads)[0]>();
  for (const lead of matchingLeads) {
    if (lead.conversationId) leadByConvId.set(lead.conversationId, lead);
    if (lead.customerPhone) leadByPhone.set(lead.customerPhone, lead);
  }

  const wsSettingsForConv = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const shouldMask = isPhoneMaskingRequired(req.user, wsSettingsForConv?.settings as Record<string, any>);

  // Clean and project conversation summaries with rich UI metadata
  const items = conversations.map((c) => {
    const payload = (c.payload as Record<string, unknown>) || {};
    const rawMessages = Array.isArray(payload.messages) ? (payload.messages as Record<string, unknown>[]) : [];
    const readState = (payload.readStateByAudience as Record<string, string>) || {};
    const lastReadAt = readState.sales ? new Date(readState.sales) : new Date(0);

    let unreadCount = 0;
    for (const msg of rawMessages) {
      if (msg.senderRole === 'customer') {
        const msgDate = msg.createdAt ? new Date(String(msg.createdAt)) : new Date();
        if (msgDate > lastReadAt) unreadCount++;
      }
    }

    const lastMsg = rawMessages.length > 0 ? rawMessages[rawMessages.length - 1] : null;
    const lead = leadByConvId.get(c.id) || (c.customerPhone ? leadByPhone.get(c.customerPhone) : undefined);
    const sourceChannel = c.serviceSlug ? c.serviceSlug.toUpperCase() : 'WHATSAPP';

    return {
      id: c.id,
      tenantId: c.tenantId,
      customerName: c.customerName,
      customerPhone: shouldMask ? maskPhoneNumber(c.customerPhone, true) : c.customerPhone,
      status: c.status,
      channel: sourceChannel,
      sourceChannel,
      stage: lead?.stage || 'NEW',
      leadStage: lead?.stage || 'NEW',
      leadId: lead?.id || null,
      assignmentId: lead?.id || null,
      assignedAgent: lead?.assignedAgent
        ? {
            id: lead.assignedAgent.id,
            agentCode: lead.assignedAgent.agentCode,
            displayName: lead.assignedAgent.user?.displayName || 'Unknown Closer',
            email: lead.assignedAgent.user?.email,
            phone: lead.assignedAgent.user?.phone,
          }
        : null,
      adMetadata: (payload.adMetadata as any) || (lead?.customFields as any)?.adMetadata || null,
      unreadCount,
      lastMessage: lastMsg
        ? {
            id: String(lastMsg.id || ''),
            body: String(lastMsg.body || ''),
            lane: (lastMsg.lane === 'internal' ? 'internal' : 'customer') as CleanChatMessage['lane'],
            senderRole: (lastMsg.senderRole === 'sales'
              ? 'sales'
              : lastMsg.senderRole === 'system'
              ? 'system'
              : 'customer') as CleanChatMessage['senderRole'],
            senderLabel: typeof lastMsg.senderLabel === 'string' ? lastMsg.senderLabel : undefined,
            createdAt: String(lastMsg.createdAt || c.updatedAt.toISOString()),
            status: (lastMsg.status as CleanChatMessage['status']) || 'delivered',
            attachments: Array.isArray(lastMsg.attachments) ? (lastMsg.attachments as CleanChatMessage['attachments']) : undefined,
          }
        : null,
      updatedAt: c.updatedAt,
    };
  });

  res.json({
    success: true,
    data: items,
    conversations: items,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: total > page * limit,
      nextCursor: items.length > 0 ? items[items.length - 1].id : null,
    },
    error: null,
  });
});

// Chat Visibility Policy Management
conversationsRouter.get('/chat-visibility', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const mode = await getChatVisibilityMode(tenantId);

  res.json({
    success: true,
    data: {
      visibilityMode: mode,
      description: mode === 'COMPANY_WIDE'
        ? 'Company-wide: All sales agents can view all workspace conversations'
        : 'Assigned-only: Sales agents are strictly scoped to their assigned leads',
      roles: {
        ADMIN: 'COMPANY_WIDE',
        MANAGER: 'COMPANY_WIDE',
        SALES_AGENT: mode,
      },
    },
    error: null,
  });
});

const updateVisibilitySchema = z.object({
  visibilityMode: z.enum(['ASSIGNED_ONLY', 'COMPANY_WIDE']),
  allowAgentIntervene: z.boolean().optional(),
});

const handleUpdateVisibility = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { visibilityMode, allowAgentIntervene } = req.body;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  settings.chatVisibility = visibilityMode;
  if (allowAgentIntervene !== undefined) {
    settings.chatAllowAgentIntervene = allowAgentIntervene;
  }

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: { settings, updatedAt: new Date() },
  });

  res.json({
    success: true,
    message: `Chat visibility policy updated to ${visibilityMode}`,
    data: { visibilityMode, allowAgentIntervene },
    error: null,
  });
};

conversationsRouter.patch('/chat-visibility', requireRoles('ADMIN', 'SUPER_ADMIN'), validateBody(updateVisibilitySchema), handleUpdateVisibility);
conversationsRouter.put('/chat-visibility', requireRoles('ADMIN', 'SUPER_ADMIN'), validateBody(updateVisibilitySchema), handleUpdateVisibility);

// GET /:id - Single conversation detail with ownership verification
conversationsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  if (id === 'chat-visibility') return;

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found in workspace' });
    return;
  }

  const hasAccess = await verifyCloserAccess(req, conversation);
  if (!hasAccess) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to view this conversation' });
    return;
  }

  res.json({
    success: true,
    data: conversation,
    error: null,
  });
});

// 2. GET /:id/messages - Cursor-paginated message history with closer authorization check
conversationsRouter.get('/:id/messages', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const beforeCursor = typeof req.query.before === 'string' ? req.query.before : null;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, data: null, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  // Closer scoping check
  const hasAccess = await verifyCloserAccess(req, conversation);
  if (!hasAccess) {
    res.status(403).json({ success: false, data: null, error: 'Forbidden', message: 'You do not have access to this conversation' });
    return;
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  const rawMessages = Array.isArray(payload.messages) ? (payload.messages as Record<string, unknown>[]) : [];

  let endIndex = rawMessages.length;
  if (beforeCursor) {
    const cursorIndex = rawMessages.findIndex((m) => m.id === beforeCursor || m.createdAt === beforeCursor);
    if (cursorIndex !== -1) endIndex = cursorIndex;
  }

  const startIndex = Math.max(0, endIndex - limit);
  const sliced = rawMessages.slice(startIndex, endIndex);

  const messages: CleanChatMessage[] = sliced.map((m) => ({
    id: String(m.id || randomUUID()),
    body: String(m.body || ''),
    lane: m.lane === 'internal' ? 'internal' : 'customer',
    createdAt: String(m.createdAt || new Date().toISOString()),
    senderRole: (m.senderRole === 'sales' ? 'sales' : m.senderRole === 'system' ? 'system' : m.senderRole === 'ai' ? 'ai' : 'customer'),
    senderLabel: typeof m.senderLabel === 'string' ? m.senderLabel : undefined,
    status: (m.status as CleanChatMessage['status']) || 'delivered',
    attachments: Array.isArray(m.attachments) ? (m.attachments as CleanChatMessage['attachments']) : undefined,
  }));

  res.json({
    success: true,
    data: {
      conversationId: conversation.id,
      customerName: conversation.customerName,
      customerPhone: conversation.customerPhone,
      status: conversation.status,
      channel: conversation.serviceSlug ? conversation.serviceSlug.toUpperCase() : 'WHATSAPP',
      messages,
      pagination: {
        hasMore: startIndex > 0,
        nextCursor: startIndex > 0 && messages.length > 0 ? messages[0].id : null,
        totalInThread: rawMessages.length,
      },
    },
    error: null,
  });
});

// 3. POST /:id/messages - Send message in thread
conversationsRouter.post('/:id/messages', validateBody(sendMessageSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof sendMessageSchema>;

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, data: null, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const hasAccess = await verifyCloserAccess(req, conversation);
  if (!hasAccess) {
    res.status(403).json({ success: false, data: null, error: 'Forbidden', message: 'You do not have access to send messages in this thread' });
    return;
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  const rawMessages = Array.isArray(payload.messages) ? (payload.messages as Record<string, unknown>[]) : [];

  const newMessage: CleanChatMessage = {
    id: `msg-${randomUUID()}`,
    body: body.body,
    lane: body.lane,
    createdAt: new Date().toISOString(),
    senderRole: 'sales',
    senderLabel: req.user?.displayName || req.user?.email || 'Sales Closer',
    status: 'sent',
    attachments: body.attachments,
  };

  rawMessages.push(newMessage as unknown as Record<string, unknown>);

  const readState = (payload.readStateByAudience as Record<string, string>) || {};
  readState.sales = new Date().toISOString();

  await prisma.appConversation.update({
    where: { id: conversation.id },
    data: {
      payload: {
        ...payload,
        messages: rawMessages,
        readStateByAudience: readState,
      } as unknown as Prisma.InputJsonValue,
      updatedAt: new Date(),
    },
  });

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'message.received',
    payload: {
      conversationId: conversation.id,
      customerPhone: conversation.customerPhone,
      customerName: conversation.customerName,
      message: newMessage,
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.status(201).json({ success: true, data: newMessage, error: null });
});

// 4. POST /:id/read - Mark conversation read
conversationsRouter.post('/:id/read', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found in this workspace' });
    return;
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  const readState = (payload.readStateByAudience as Record<string, string>) || {};
  readState.sales = new Date().toISOString();

  await prisma.appConversation.update({
    where: { id: conversation.id },
    data: {
      payload: {
        ...payload,
        readStateByAudience: readState,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  res.json({ success: true, message: 'Conversation marked as read', error: null });
});

// 5. POST /:id/attachments - Multipart file or base64 upload
conversationsRouter.post('/:id/attachments', upload.single('file'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, data: null, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const fileId = `att-${randomUUID().slice(0, 10)}`;
  const uploadDir = path.resolve(process.cwd(), 'data', 'uploads', 'attachments', id);
  fs.mkdirSync(uploadDir, { recursive: true });

  const tokenParam = typeof req.query.token === 'string' ? `?token=${encodeURIComponent(req.query.token)}` : '';

  if (req.file) {
    const safeFilename = `${fileId}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(uploadDir, safeFilename);
    fs.writeFileSync(filePath, req.file.buffer);
    const fileUrl = `https://api.aicloser.in/api/v1/conversations/${id}/attachments/${safeFilename}`;

    res.status(201).json({
      success: true,
      data: {
        id: fileId,
        name: req.file.originalname,
        mimeType: req.file.mimetype || 'application/octet-stream',
        sizeBytes: req.file.size,
        url: fileUrl,
        authenticatedUrl: `${fileUrl}${tokenParam}`,
        externalUrl: fileUrl,
      },
      error: null,
    });
    return;
  }

  const { name, mimeType, sizeBytes, base64Data, externalUrl } = req.body as {
    name?: string;
    mimeType?: string;
    sizeBytes?: number;
    base64Data?: string;
    externalUrl?: string;
  };

  if (!name && !externalUrl) {
    res.status(400).json({ success: false, data: null, error: 'InvalidRequest', message: 'Attachment file or name is required' });
    return;
  }

  let fileUrl = externalUrl || '';
  const finalName = name || 'attachment';

  if (base64Data) {
    const safeFilename = `${fileId}-${finalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(uploadDir, safeFilename);
    const buffer = Buffer.from(base64Data.replace(/^data:.*,/, ''), 'base64');
    fs.writeFileSync(filePath, buffer);
    fileUrl = `https://api.aicloser.in/api/v1/conversations/${id}/attachments/${safeFilename}`;
  }

  res.status(201).json({
    success: true,
    data: {
      id: fileId,
      name: finalName,
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes: sizeBytes || 0,
      url: fileUrl,
      authenticatedUrl: `${fileUrl}${tokenParam}`,
      externalUrl: fileUrl,
    },
    error: null,
  });
});

// 6. GET /:id/attachments/:filename - Securely stream attachment (supports ?token= query auth)
conversationsRouter.get('/:id/attachments/:filename', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id, filename } = req.params;

  const conversation = await prisma.appConversation.findFirst({
    where: { id: String(id), tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const filePath = path.resolve(process.cwd(), 'data', 'uploads', 'attachments', String(id), String(filename));
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Attachment file not found' });
    return;
  }

  res.sendFile(filePath);
});

// 7. POST /:id/assign - Reassign conversation and linked lead (Role Guarded)
conversationsRouter.post('/:id/assign', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const rawAgentId = String(
    req.body?.assignedAgentId ||
    req.body?.freelancerId ||
    (Array.isArray(req.body?.freelancerIds) ? req.body.freelancerIds[0] : '') ||
    ''
  ).trim();

  if (!rawAgentId) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'assignedAgentId is required' });
    return;
  }

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  // Find agent profile or user in tenant
  const agentProfile = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      OR: [{ id: rawAgentId }, { userId: rawAgentId }],
    },
    include: { user: { select: { displayName: true } } },
  });

  const assignedFreelancerId = agentProfile ? agentProfile.id : rawAgentId;
  const assignedFreelancerName = agentProfile?.user?.displayName || null;

  // Update conversation
  await prisma.appConversation.update({
    where: { id },
    data: {
      assignedFreelancerId,
      assignedFreelancerName,
    },
  });

  // Also update linked lead
  await prisma.salesLeadAssignment.updateMany({
    where: {
      tenantId,
      OR: [
        { conversationId: id },
        ...(conversation.customerPhone ? [{ customerPhone: conversation.customerPhone }] : []),
      ],
    },
    data: { assignedAgentId: assignedFreelancerId },
  });

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.updated',
    payload: { conversationId: id, assignedAgentId: assignedFreelancerId, assignedFreelancerName },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.json({
    success: true,
    message: 'Conversation and lead reassigned successfully',
    data: { conversationId: id, assignedAgentId: assignedFreelancerId, assignedFreelancerName },
    error: null,
  });
});

// 7b. DELETE /:id/assign - Unassign conversation and linked lead (Role Guarded)
conversationsRouter.delete('/:id/assign', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  await prisma.appConversation.update({
    where: { id },
    data: { assignedFreelancerId: null, assignedFreelancerName: null },
  });

  // In AppConversation, assigned agent is unassigned
  // salesLeadAssignment requires assignedAgentId so we keep the lead record scoped to tenant

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.updated',
    payload: { conversationId: id, assignedAgentId: null },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.json({ success: true, message: 'Conversation unassigned successfully', error: null });
});

// 8. PATCH /:id/stage - Update lead stage from chat workspace
conversationsRouter.patch('/:id/stage', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { stage } = req.body as { stage: string };

  if (!stage) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'stage is required' });
    return;
  }

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const updateResult = await prisma.salesLeadAssignment.updateMany({
    where: {
      tenantId,
      OR: [
        { conversationId: id },
        ...(conversation.customerPhone ? [{ customerPhone: conversation.customerPhone }] : []),
      ],
    },
    data: {
      stage: stage as any,
      stageChangedAt: new Date(),
    },
  });

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.stage_changed',
    payload: { conversationId: id, stage },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.json({ success: true, message: 'Lead stage updated successfully', affectedLeads: updateResult.count, error: null });
});

// 9. POST /:id/notes - Add note to linked lead
conversationsRouter.post('/:id/notes', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { body } = req.body as { body: string };

  if (!body?.trim()) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'Note body is required' });
    return;
  }

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      OR: [
        { conversationId: id },
        ...(conversation.customerPhone ? [{ customerPhone: conversation.customerPhone }] : []),
      ],
    },
    select: { id: true },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'No linked lead record found for this conversation' });
    return;
  }

  const note = await prisma.salesLeadTimelineEntry.create({
    data: {
      tenantId,
      leadId: lead.id,
      type: 'NOTE',
      body: body.trim(),
      metadata: { source: 'CHAT_WORKSPACE', conversationId: id },
    },
  });

  res.status(201).json({ success: true, data: note, error: null });
});

// 10. POST /:id/callback - Schedule follow-up callback
conversationsRouter.post('/:id/callback', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { followUpAt, note } = req.body as { followUpAt: string; note?: string };

  if (!followUpAt) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'followUpAt date string is required' });
    return;
  }

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      OR: [
        { conversationId: id },
        ...(conversation.customerPhone ? [{ customerPhone: conversation.customerPhone }] : []),
      ],
    },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'No linked lead found' });
    return;
  }

  const parsedDate = new Date(followUpAt);
  await prisma.salesLeadAssignment.update({
    where: { id: lead.id },
    data: { followUpAt: parsedDate },
  });

  const task = await prisma.gxLeadTask.create({
    data: {
      salesLeadId: lead.id,
      title: note || `Scheduled WhatsApp follow-up callback with ${conversation.customerName}`,
      dueAt: parsedDate,
      priority: 'HIGH',
      status: 'OPEN',
    },
  });

  res.status(201).json({ success: true, data: { leadId: lead.id, followUpAt: parsedDate, task }, error: null });
});

// 11. POST /:id/typing - Broadcast typing state
conversationsRouter.post('/:id/typing', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { isTyping } = req.body as { isTyping: boolean };

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'chat.typing',
    payload: {
      conversationId: id,
      userId: req.user?.userId,
      displayName: req.user?.displayName,
      isTyping: Boolean(isTyping),
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.json({ success: true, message: 'Typing status broadcasted', error: null });
});

// 12. PATCH /:id/transport - Change communication channel
conversationsRouter.patch('/:id/transport', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { channel } = req.body as { channel: string };

  if (!channel) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'channel is required' });
    return;
  }

  const updated = await prisma.appConversation.update({
    where: { id },
    data: { serviceSlug: channel.toLowerCase() },
  });

  res.json({ success: true, data: { id: updated.id, channel: updated.serviceSlug.toUpperCase() }, error: null });
});

// 13. POST /:id/ai-reply - Generate consultative sales AI draft reply
conversationsRouter.post('/:id/ai-reply', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  const rawMessages = Array.isArray(payload.messages) ? (payload.messages as Record<string, unknown>[]) : [];
  const lastCustomerMessage = [...rawMessages].reverse().find((m) => m.senderRole === 'customer');

  const customerText = String(lastCustomerMessage?.body || '');
  const customerName = conversation.customerName || 'there';

  let suggestedReply = `Hi ${customerName}, thanks for reaching out! I would love to walk you through how our enterprise CRM solution fits your requirements. Would 4 PM today or 11 AM tomorrow work for a quick 10-minute demo call?`;

  if (/price|pricing|cost|budget|kitna/i.test(customerText)) {
    suggestedReply = `Hi ${customerName}, our enterprise plans start at ₹25,000 with unlimited call recording, WhatsApp automations, and closer tracking included. Let me know if you would like me to share the custom proposal brochure!`;
  } else if (/demo|call|zoom|meet/i.test(customerText)) {
    suggestedReply = `Sounds great ${customerName}! I am reserving a quick slot for you. Could you confirm if you prefer a phone call or a Google Meet / Zoom session?`;
  }

  res.json({
    success: true,
    data: {
      suggestedReply,
      confidence: 0.94,
      context: {
        customerName,
        lastCustomerMessage: customerText,
      },
    },
    error: null,
  });
});

// 14. POST /:id/drip - Trigger or pause drip automation sequence
conversationsRouter.post('/:id/drip', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { action, sequenceId } = req.body as { action: 'PAUSE' | 'RESUME' | 'TRIGGER'; sequenceId?: string };

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  payload.dripState = {
    sequenceId: sequenceId || 'default-nurture-sequence',
    status: action || 'TRIGGER',
    updatedAt: new Date().toISOString(),
  };

  await prisma.appConversation.update({
    where: { id },
    data: { payload: payload as unknown as Prisma.InputJsonValue },
  });

  res.json({ success: true, message: `Drip sequence ${action} successfully`, error: null });
});


// 15. POST /:id/ai-auto-reply - Toggle AI auto-reply on/off for conversation thread
conversationsRouter.post('/:id/ai-auto-reply', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const disabled = Boolean(req.body?.disabled);

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const hasAccess = await verifyCloserAccess(req, conversation);
  if (!hasAccess) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to manage AI reply for this thread' });
    return;
  }

  const existingPayload = (conversation.payload as Record<string, unknown>) || {};
  const updatedPayload = {
    ...existingPayload,
    aiAutoReplyDisabled: disabled,
    aiAutoReplyDisabledUpdatedAt: new Date().toISOString(),
    aiAutoReplyUpdatedBy: req.user?.displayName || req.user?.role,
  };

  await prisma.appConversation.update({
    where: { id },
    data: { payload: updatedPayload },
  });

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'conversation.updated',
    payload: { conversationId: id, aiAutoReplyDisabled: disabled },
  }).catch(() => undefined);

  res.json({
    success: true,
    data: {
      id,
      aiAutoReplyDisabled: disabled,
      message: disabled ? 'AI Auto-Reply paused (Human mode)' : 'AI Auto-Reply resumed',
    },
    error: null,
  });
});

// 16. POST /:id/payment-request - Create or update PhonePe/UPI payment request in conversation
conversationsRouter.post('/:id/payment-request', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body || {};

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const hasAccess = await verifyCloserAccess(req, conversation);
  if (!hasAccess) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to create payment requests for this conversation' });
    return;
  }

  const action = String(body.action || 'create').toLowerCase();
  const existingPayload = (conversation.payload as Record<string, unknown>) || {};
  const currentPayment = (existingPayload.latestPaymentRequest as Record<string, unknown>) || null;

  if (action === 'mark-status') {
    const nextStatus = String(body.status || 'Paid');
    const paymentRequestId = String(body.paymentRequestId || currentPayment?.id || '');
    const updatedPayment = {
      ...(currentPayment || {}),
      id: paymentRequestId,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    };
    await prisma.appConversation.update({
      where: { id },
      data: {
        payload: {
          ...existingPayload,
          latestPaymentRequest: updatedPayment,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    res.json({ success: true, data: { payment: updatedPayment }, error: null });
    return;
  }

  if (action === 'submit-proof') {
    const paymentRequestId = String(body.paymentRequestId || currentPayment?.id || '');
    const updatedPayment = {
      ...(currentPayment || {}),
      id: paymentRequestId,
      status: 'Viewed',
      proofAttachments: body.attachments || [],
      proofSubmittedAt: new Date().toISOString(),
    };
    await prisma.appConversation.update({
      where: { id },
      data: {
        payload: {
          ...existingPayload,
          latestPaymentRequest: updatedPayment,
        },
      },
    });
    res.json({ success: true, data: { payment: updatedPayment }, error: null });
    return;
  }

  // Create payment request
  const amount = Number(body.amount) || 0;
  if (amount <= 0) {
    res.status(400).json({ success: false, error: 'InvalidAmount', message: 'Payment amount must be greater than 0' });
    return;
  }

  const paymentRequestId = `payreq-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const title = String(body.title || body.projectTitle || 'Project Payment').trim();
  const note = String(body.note || '').trim();

  const upiId = String(body.payeeUpiId || 'payments@phonepe').trim();
  const encodedTitle = encodeURIComponent(title);
  const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=AICloser&am=${amount}&tn=${encodedTitle}&cu=INR`;

  const newPayment = {
    id: paymentRequestId,
    amount,
    title,
    note,
    status: 'Sent',
    paymentLink: upiLink,
    payeeRole: body.payeeRole || 'agency',
    createdAt: new Date().toISOString(),
  };

  const rawMessages = Array.isArray(existingPayload.messages) ? (existingPayload.messages as Record<string, unknown>[]) : [];
  const paymentMessage = {
    id: `msg-${randomUUID()}`,
    body: `Payment request: ₹${amount.toLocaleString('en-IN')} for ${title}${note ? ` (${note})` : ''}`,
    senderRole: req.user?.role === 'SALES_AGENT' ? 'sales' : 'system',
    senderLabel: req.user?.displayName || 'Sales Closer',
    createdAt: new Date().toISOString(),
    lane: 'customer',
    attachments: [
      {
        id: `att-${randomUUID()}`,
        kind: 'payment-request',
        name: title,
        sizeLabel: `₹${amount}`,
        note: `Payment request for ₹${amount}`,
        paymentRequestId,
      },
    ],
  };

  await prisma.appConversation.update({
    where: { id },
    data: {
      payload: {
        ...existingPayload,
        latestPaymentRequest: newPayment,
        messages: [...rawMessages, paymentMessage],
      } as unknown as Prisma.InputJsonValue,
    },
  });

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'payment.created',
    payload: { conversationId: id, payment: newPayment },
  }).catch(() => undefined);

  res.status(201).json({
    success: true,
    data: {
      payment: newPayment,
      message: paymentMessage,
    },
    error: null,
  });
});
