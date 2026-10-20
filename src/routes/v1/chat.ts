import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody } from '../../middlewares/validate.js';
import { logger } from '../../lib/logger.js';

export const chatRouter = Router();

chatRouter.use(authenticate, enforceTenantIsolation);

// ==========================================
// 1. Conversations List & Retrieval
// ==========================================

// GET /conversations - List conversations with strict tenant isolation
chatRouter.get('/conversations', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);

  const conversations = await prisma.appConversation.findMany({
    where: { tenantId },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });

  const formatted = conversations.map((c) => {
    const payload = (c.payload as Record<string, any>) || {};
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

    return {
      id: c.id,
      tenantId: c.tenantId,
      customerName: c.customerName,
      customerPhone: c.customerPhone,
      serviceSlug: c.serviceSlug,
      status: c.status,
      leadStatusId: c.leadStatusId,
      assignedAgentId: c.assignedFreelancerId,
      assignedAgentName: c.assignedFreelancerName,
      lastMessageText: lastMessage?.body || lastMessage?.text || '',
      lastMessageAt: lastMessage?.timestamp || c.updatedAt,
      messageCount: messages.length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });

  res.json({
    success: true,
    data: formatted,
    conversations: formatted,
    count: formatted.length,
    error: null,
  });
});

// GET /conversations/:id - Retrieve single conversation
chatRouter.get('/conversations/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const conversation = await prisma.appConversation.findFirst({
    where: { id: String(id), tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const payload = (conversation.payload as Record<string, any>) || {};
  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  res.json({
    success: true,
    data: {
      ...conversation,
      messages,
    },
    conversation: {
      ...conversation,
      messages,
    },
    error: null,
  });
});

// POST /conversations - Create or find conversation
const createConversationSchema = z.object({
  customerName: z.string().min(1, 'Customer name is required'),
  customerPhone: z.string().min(5, 'Customer phone is required'),
  serviceSlug: z.string().optional(),
  initialMessage: z.string().optional(),
});

chatRouter.post('/conversations', validateBody(createConversationSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { customerName, customerPhone, serviceSlug, initialMessage } = req.body;

  const cleanPhone = String(customerPhone).replace(/\D/g, '');
  const e164Phone = cleanPhone.length === 10 ? `+91${cleanPhone}` : `+${cleanPhone}`;

  // Check if exists
  let conversation = await prisma.appConversation.findFirst({
    where: { tenantId, customerPhone: e164Phone },
  });

  if (!conversation) {
    const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const initialMessages = initialMessage ? [{
      id: `msg_${Date.now()}_1`,
      senderRole: 'customer',
      senderName: customerName,
      body: initialMessage,
      timestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      status: 'DELIVERED',
    }] : [];

    conversation = await prisma.appConversation.create({
      data: {
        id,
        tenantId,
        serviceId: 'general',
        serviceSlug: serviceSlug || 'b2b-closer',
        customerName,
        customerPhone: e164Phone,
        status: 'ACTIVE',
        leadStatusId: 'NEW',
        payload: {
          messages: initialMessages,
        },
      },
    });
  }

  res.status(201).json({
    success: true,
    data: conversation,
    conversation,
    error: null,
  });
});

// ==========================================
// 2. Chat Messages
// ==========================================

// GET /messages - List messages for conversation
chatRouter.get('/messages', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const conversationId = String(req.query.conversationId || req.query.id || '').trim();

  if (!conversationId) {
    res.status(400).json({ success: false, error: 'ConversationIdRequired', message: 'conversationId query param is required' });
    return;
  }

  const conversation = await prisma.appConversation.findFirst({
    where: { id: conversationId, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found in workspace' });
    return;
  }

  const payload = (conversation.payload as Record<string, any>) || {};
  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  res.json({
    success: true,
    data: messages,
    messages,
    count: messages.length,
    conversationId: conversation.id,
    error: null,
  });
});

// POST /messages - Send a new chat message
const sendMessageSchema = z.object({
  conversationId: z.string().min(1, 'conversationId is required'),
  messageText: z.string().min(1, 'messageText is required'),
  senderRole: z.string().optional(),
});

chatRouter.post('/messages', validateBody(sendMessageSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const { conversationId, messageText, senderRole } = req.body;

  const conversation = await prisma.appConversation.findFirst({
    where: { id: conversationId, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const payload = (conversation.payload as Record<string, any>) || {};
  const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];

  const newMessage = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    senderRole: senderRole || (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN' ? 'admin' : 'agent'),
    senderName: user.displayName || 'Closer',
    senderUserId: user.userId,
    body: messageText,
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    status: 'SENT',
  };

  messages.push(newMessage);

  const updated = await prisma.appConversation.update({
    where: { id: conversation.id },
    data: {
      payload: {
        ...payload,
        messages,
      },
      updatedAt: new Date(),
    },
  });

  // Write activity log
  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      actorUserId: user.userId,
      action: 'CHAT_MESSAGE_SENT',
      note: `Sent chat message to ${conversation.customerName}: "${messageText.slice(0, 60)}"`,
      metadata: {
        conversationId: conversation.id,
        customerPhone: conversation.customerPhone,
        messageId: newMessage.id,
      },
    },
  }).catch(() => null);

  res.status(201).json({
    success: true,
    message: newMessage,
    data: newMessage,
    conversationId: updated.id,
    error: null,
  });
});

// ==========================================
// 3. Realtime Chat Stream (SSE)
// ==========================================

chatRouter.get('/stream', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  res.status(200);
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', tenantId, userId: user.userId, timestamp: new Date().toISOString() })}\n\n`);

  let closed = false;
  let lastChecked = new Date();

  const pollInterval = setInterval(async () => {
    if (closed) return;
    try {
      const recent = await prisma.appConversation.findMany({
        where: {
          tenantId,
          updatedAt: { gt: lastChecked },
        },
        select: { id: true, customerName: true, updatedAt: true, payload: true },
        take: 10,
      });

      if (recent.length > 0) {
        lastChecked = new Date();
        for (const item of recent) {
          const payload = (item.payload as Record<string, any>) || {};
          const msgs = Array.isArray(payload.messages) ? payload.messages : [];
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg) {
            res.write(`event: message\ndata: ${JSON.stringify({ conversationId: item.id, customerName: item.customerName, message: lastMsg })}\n\n`);
          }
        }
      }
    } catch {
      // ignore
    }
  }, 2000);

  const heartbeat = setInterval(() => {
    if (!closed) {
      res.write(`event: ping\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
    }
  }, 25000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(pollInterval);
    clearInterval(heartbeat);
    res.end();
  };

  req.on('close', cleanup);
});
