import fs from 'fs';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { Prisma } from '@prisma/client';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';

import path from 'path';
export const conversationsRouter = Router();

conversationsRouter.use(authenticate, enforceTenantIsolation);

export interface CleanChatMessage {
  id: string;
  body: string;
  lane: 'customer' | 'internal';
  createdAt: string;
  senderRole: 'sales' | 'customer' | 'system';
  senderLabel?: string;
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  attachments?: Array<{
    name: string;
    mimeType?: string;
    sizeBytes?: number;
    externalUrl?: string;
  }>;
}

const listConversationsQuerySchema = z.object({
  page: z.string().optional().transform((v) => (v ? Math.max(1, Number(v)) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, Math.max(1, Number(v))) : 25)),
  status: z.string().optional(),
  search: z.string().optional(),
  customerPhone: z.string().optional(),
});

const sendMessageSchema = z.object({
  body: z.string().min(1, 'Message text is required'),
  lane: z.enum(['customer', 'internal']).optional().default('customer'),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        mimeType: z.string().optional(),
        sizeBytes: z.number().optional(),
        externalUrl: z.string().optional(),
      })
    )
    .optional(),
});

const startConversationSchema = z.object({
  customerPhone: z.string().min(5, 'Valid phone number is required'),
  customerName: z.string().optional(),
  leadId: z.string().optional(),
  initialMessage: z.string().optional(),
});

// 1. GET / - List normalized chat conversations
conversationsRouter.get('/', validateQuery(listConversationsQuerySchema), async (req: Request, res: Response) => {
  const { page, limit, status, search, customerPhone } = req.query as unknown as {
    page: number;
    limit: number;
    status?: string;
    search?: string;
    customerPhone?: string;
  };

  const tenantId = req.tenantId!;
  const where: Record<string, unknown> = { tenantId };

  if (status) where.status = status;
  if (customerPhone) where.customerPhone = { contains: customerPhone };
  if (search) {
    where.OR = [
      { customerName: { contains: search, mode: 'insensitive' } },
      { customerPhone: { contains: search } },
    ];
  }

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
        customerName: true,
        customerPhone: true,
        status: true,
        payload: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  // Clean and project conversation summaries
  const items = conversations.map((c) => {
    const payload = (c.payload as Record<string, unknown>) || {};
    const rawMessages = (Array.isArray(payload.messages) ? payload.messages : []) as Array<Record<string, unknown>>;
    const lastRaw = rawMessages[rawMessages.length - 1];

    let lastMessage: CleanChatMessage | null = null;
    if (lastRaw) {
      lastMessage = {
        id: String(lastRaw.id || ''),
        body: String(lastRaw.body || ''),
        lane: (lastRaw.lane === 'internal' ? 'internal' : 'customer'),
        createdAt: String(lastRaw.createdAt || c.updatedAt.toISOString()),
        senderRole: (lastRaw.senderRole === 'sales' ? 'sales' : lastRaw.senderRole === 'system' ? 'system' : 'customer'),
        senderLabel: typeof lastRaw.senderLabel === 'string' ? lastRaw.senderLabel : undefined,
      };
    }

    // Compute unread count for customer messages
    const readState = (payload.readStateByAudience as Record<string, string>) || {};
    const lastReadAt = readState.sales || '';
    const unreadCount = rawMessages.filter(
      (m) => m.lane === 'customer' && m.senderRole !== 'sales' && (!lastReadAt || String(m.createdAt || '') > lastReadAt)
    ).length;

    return {
      id: c.id,
      customerName: c.customerName,
      customerPhone: c.customerPhone,
      status: c.status,
      unreadCount,
      lastMessage,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });

  res.json({
    success: true,
    data: items,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    error: null,
  });
});

// 2. POST /start - Find or create conversation by phone
conversationsRouter.post('/start', validateBody(startConversationSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body as z.infer<typeof startConversationSchema>;

  // Normalize phone
  const normalizedPhone = body.customerPhone.trim();
  const customerName = body.customerName?.trim() || normalizedPhone;

  let conversation = await prisma.appConversation.findFirst({
    where: { tenantId, customerPhone: normalizedPhone },
  });

  if (!conversation) {
    const initialMessages: CleanChatMessage[] = [];
    if (body.initialMessage) {
      initialMessages.push({
        id: `msg-${randomUUID().slice(0, 12)}`,
        body: body.initialMessage.trim(),
        lane: 'customer',
        createdAt: new Date().toISOString(),
        senderRole: 'sales',
        senderLabel: req.user?.displayName || req.user?.email || undefined,
      });
    }

    conversation = await prisma.appConversation.create({
      data: {
        id: `conv-${randomUUID().slice(0, 12)}`,
        tenantId,
        customerName,
        customerPhone: normalizedPhone,
        serviceId: 'sales-crm',
        serviceSlug: 'sales',
        status: 'Active',
        leadStatusId: 'lead-active',
        payload: {
          messages: initialMessages,
          leadId: body.leadId,
          sourceChannel: 'whatsapp',
          readStateByAudience: {
            sales: new Date().toISOString(),
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  res.status(201).json({ success: true, data: conversation });
});

const getMessagesQuerySchema = z.object({
  before: z.string().optional(),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, Math.max(1, Number(v))) : 50)),
});

// 3. GET /:id/messages - Get clean message stream for conversation with cursor pagination
conversationsRouter.get('/:id/messages', validateQuery(getMessagesQuerySchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
    select: {
      id: true,
      customerName: true,
      customerPhone: true,
      status: true,
      payload: true,
      updatedAt: true,
    },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found in this workspace' });
    return;
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  const rawMessages = (Array.isArray(payload.messages) ? payload.messages : []) as Array<Record<string, unknown>>;

  const { before, limit } = req.query as unknown as { before?: string; limit: number };

  let endIndex = rawMessages.length;
  if (before) {
    const foundIdx = rawMessages.findIndex((m) => String(m.id) === before);
    if (foundIdx !== -1) {
      endIndex = foundIdx;
    }
  }

  const startIndex = Math.max(0, endIndex - limit);
  const slicedRaw = rawMessages.slice(startIndex, endIndex);

  const messages: CleanChatMessage[] = slicedRaw.map((m) => ({
    id: String(m.id || ''),
    body: String(m.body || ''),
    lane: (m.lane === 'internal' ? 'internal' : 'customer'),
    createdAt: String(m.createdAt || new Date().toISOString()),
    senderRole: (m.senderRole === 'sales' ? 'sales' : m.senderRole === 'system' ? 'system' : 'customer'),
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

// 4. POST /:id/messages - Send a message in the thread
conversationsRouter.post('/:id/messages', validateBody(sendMessageSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof sendMessageSchema>;

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found in this workspace' });
    return;
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  const rawMessages = (Array.isArray(payload.messages) ? payload.messages : []) as Array<Record<string, unknown>>;

  const newMessage: CleanChatMessage = {
    id: `msg-${randomUUID().slice(0, 12)}`,
    body: body.body.trim(),
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

  res.status(201).json({ success: true, data: newMessage });
});

// 5. POST /:id/read - Mark conversation read
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

  res.json({ success: true, message: 'Conversation marked as read' });
});

// 6. GET /:id - Single conversation metadata
conversationsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found in this workspace' });
    return;
  }

  res.json({ success: true, data: conversation });
});

// 7. POST /:id/attachments - Upload chat attachment (Image, PDF, Document)
conversationsRouter.post('/:id/attachments', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { name, mimeType, sizeBytes, base64Data, externalUrl } = req.body as {
    name: string;
    mimeType?: string;
    sizeBytes?: number;
    base64Data?: string;
    externalUrl?: string;
  };

  if (!name) {
    res.status(400).json({ success: false, data: null, error: 'InvalidRequest', message: 'Attachment name is required' });
    return;
  }

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, data: null, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const fileId = `att-${randomUUID().slice(0, 10)}`;
  let fileUrl = externalUrl || '';

  if (base64Data) {
    const uploadDir = path.resolve(process.cwd(), 'data', 'uploads', 'attachments', id);
    fs.mkdirSync(uploadDir, { recursive: true });
    const safeFilename = `${fileId}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(uploadDir, safeFilename);
    const buffer = Buffer.from(base64Data.replace(/^data:.*,/, ''), 'base64');
    fs.writeFileSync(filePath, buffer);
    fileUrl = `https://api.aicloser.in/api/v1/conversations/${id}/attachments/${safeFilename}`;
  }

  res.status(201).json({
    success: true,
    data: {
      id: fileId,
      name,
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes: sizeBytes || 0,
      url: fileUrl,
    },
    error: null,
  });
});

// 8. GET /:id/attachments/:filename - Securely stream/preview chat attachment
conversationsRouter.get('/:id/attachments/:filename', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id, filename } = req.params;

  const conversation = await prisma.appConversation.findFirst({
    where: { id: String(id), tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, data: null, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const filePath = path.resolve(process.cwd(), 'data', 'uploads', 'attachments', String(id), String(filename));
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ success: false, data: null, error: 'NotFound', message: 'Attachment file not found' });
    return;
  }

  res.sendFile(filePath);
});
