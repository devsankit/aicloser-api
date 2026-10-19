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
import { requireRoles, hasPermission, PERM_LEADS_REASSIGN } from '../../middlewares/rbac.js';
import { persistApiRealtimeEvent } from '../../lib/realtime.js';
import { getWorkspaceScope } from '../../lib/workspace-scope.js';
import { syncMarketingContactForLead } from '../../lib/lead-contact-sync.js';
import { getLead360 } from './leads.js';

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
  senderType?: 'HUMAN' | 'AI' | 'CUSTOMER';
  senderUserId?: string | null;
  aiAgentId?: string | null;
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

export interface ConversationShareRecord {
  id: string;
  conversationId: string;
  userId: string;
  agentProfileId?: string | null;
  sharedByUserId: string;
  sharedByUserName?: string | null;
  permission: 'VIEW' | 'REPLY';
  createdAt: string;
  revokedAt?: string | null;
}

export interface ConversationAiSettings {
  enabled: boolean;
  mode: 'HUMAN_ONLY' | 'AI_ASSISTED' | 'AI_AUTO_REPLY';
  aiAgentId?: string | null;
  humanTakeover: boolean;
  lastHumanMessageAt?: string | null;
  updatedAt?: string;
  updatedByUserId?: string;
}

export interface ConversationAccessResult {
  hasAccess: boolean;
  isOwnerOrAssigned: boolean;
  isShared: boolean;
  permission: 'VIEW' | 'REPLY';
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

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function phoneMatchConditions(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter(Boolean).flatMap((value) => {
    const raw = String(value);
    const normalized = normalizePhone(raw);
    return normalized.length >= 10 && normalized !== raw
      ? [{ customerPhone: raw }, { customerPhone: { endsWith: normalized } }]
      : [{ customerPhone: raw }];
  })));
}

// Helper: Workspace Chat Visibility Policy ('ASSIGNED_ONLY' vs 'COMPANY_WIDE')
async function getChatVisibilityMode(tenantId: string): Promise<'ASSIGNED_ONLY' | 'COMPANY_WIDE'> {
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const settings = (workspace?.settings as Record<string, any>) || {};
  if (settings.chatVisibility === 'ASSIGNED_ONLY' || settings.chatVisibility === 'COMPANY_WIDE') {
    return settings.chatVisibility;
  }

  // Keep the old workspace setting as a read fallback while all callers move
  // to the central chat-visibility API. This prevents an existing tenant from
  // silently reverting to ASSIGNED_ONLY after the API migration.
  const legacySettings = await prisma.salesSettings.findUnique({
    where: { tenantId },
    select: { showOnlyAssignedChats: true },
  });
  return legacySettings?.showOnlyAssignedChats === false ? 'COMPANY_WIDE' : 'ASSIGNED_ONLY';
}

// Helper: Check detailed user access and permission (VIEW vs REPLY, Assigned vs Shared)
async function checkConversationAccess(
  req: Request,
  conversation: { id: string; customerPhone?: string; assignedFreelancerId?: string | null; payload?: any }
): Promise<ConversationAccessResult> {
  const user = req.user;
  if (!user) return { hasAccess: false, isOwnerOrAssigned: false, isShared: false, permission: 'VIEW' };

  // Super Admin and Admin have unconditional permanent REPLY access
  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
    return { hasAccess: true, isOwnerOrAssigned: true, isShared: false, permission: 'REPLY' };
  }

  const tenantId = req.tenantId!;
  const mode = user.role === 'SALES_AGENT' ? await getChatVisibilityMode(tenantId) : 'ASSIGNED_ONLY';
  if (mode === 'COMPANY_WIDE') {
    return { hasAccess: true, isOwnerOrAssigned: true, isShared: false, permission: 'REPLY' };
  }

  const scope = await getWorkspaceScope(tenantId, user);

  // 1. Check if directly assigned to current user's profile
  if (conversation.assignedFreelancerId && scope.profileIds.includes(conversation.assignedFreelancerId)) {
    return { hasAccess: true, isOwnerOrAssigned: true, isShared: false, permission: 'REPLY' };
  }

  // 2. Check if linked lead is assigned to current user's profile
  const lead = await prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      assignedAgentId: { in: scope.profileIds },
      OR: [
        { conversationId: conversation.id },
        ...phoneMatchConditions([conversation.customerPhone]),
      ],
    },
    select: { id: true },
  });
  if (lead) {
    return { hasAccess: true, isOwnerOrAssigned: true, isShared: false, permission: 'REPLY' };
  }

  // 3. Check if explicitly shared with this user (active share with no revokedAt)
  const payload = (conversation.payload as Record<string, unknown>) || {};
  const shares = Array.isArray(payload.shares) ? (payload.shares as ConversationShareRecord[]) : [];
  const activeShare = shares.find((s) => {
    if (s.revokedAt) return false;
    return s.userId === user.userId || (s.agentProfileId && scope.profileIds.includes(s.agentProfileId));
  });

  if (activeShare) {
    return {
      hasAccess: true,
      isOwnerOrAssigned: false,
      isShared: true,
      permission: activeShare.permission || 'REPLY',
    };
  }

  return { hasAccess: false, isOwnerOrAssigned: false, isShared: false, permission: 'VIEW' };
}

// Helper: Backward-compatible boolean wrapper for closer access
async function verifyCloserAccess(
  req: Request,
  conversation: { id: string; customerPhone?: string; assignedFreelancerId?: string | null; payload?: any }
): Promise<boolean> {
  const result = await checkConversationAccess(req, conversation);
  return result.hasAccess && (req.method === 'GET' || req.method === 'HEAD' || result.permission === 'REPLY');
}

conversationsRouter.get('/:id/360', async (req: Request, res: Response) => {
  const conversation = await prisma.appConversation.findFirst({ where: { id: String(req.params.id), tenantId: req.tenantId! } });
  if (!conversation) return void res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
  if (!(await verifyCloserAccess(req, conversation))) return void res.status(403).json({ success: false, error: 'Forbidden', message: 'Conversation access denied' });
  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { tenantId: req.tenantId!, OR: [{ conversationId: conversation.id }, ...phoneMatchConditions([conversation.customerPhone])] },
    select: { id: true },
  });
  if (!lead) return void res.json({ success: true, data: { lead: null, notes: [], timeline: [], history: [], tasks: [], calls: [], payments: [] }, error: null });
  req.params.id = lead.id;
  await getLead360(req, res);
});

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

  // Closers see their assigned conversations. Managers see their reporting
  // team. Admins retain the tenant-wide inbox.
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
          ...phoneMatchConditions(phones),
          { payload: { path: ['sharedUserIds'], array_contains: req.user.userId } },
          ...(profile ? [{ payload: { path: ['sharedUserIds'], array_contains: profile.id } }] : []),
        ],
      });
    }
  } else if (req.user?.role === 'MANAGER') {
    const scope = await getWorkspaceScope(tenantId, req.user);
    const assignedLeads = scope.profileIds.length
      ? await prisma.salesLeadAssignment.findMany({
          where: { tenantId, assignedAgentId: { in: scope.profileIds } },
          select: { customerPhone: true, conversationId: true },
        })
      : [];
    const phones = assignedLeads.map((lead) => lead.customerPhone).filter(Boolean) as string[];
    const convIds = assignedLeads.map((lead) => lead.conversationId).filter(Boolean) as string[];
    andConditions.push({
      OR: [
        ...(scope.profileIds.length ? [{ assignedFreelancerId: { in: scope.profileIds } }] : []),
        ...(convIds.length ? [{ id: { in: convIds } }] : []),
        ...phoneMatchConditions(phones),
        { payload: { path: ['sharedUserIds'], array_contains: req.user.userId } },
        ...(scope.userIds.length > 0 ? scope.userIds.map((uid) => ({ payload: { path: ['sharedUserIds'], array_contains: uid } })) : []),
      ],
    });
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
        assignedFreelancerId: true,
        assignedFreelancerName: true,
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
        ...phoneMatchConditions(phones),
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
    if (lead.customerPhone) leadByPhone.set(normalizePhone(lead.customerPhone), lead);
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
    const lead = leadByConvId.get(c.id) || (c.customerPhone ? leadByPhone.get(normalizePhone(c.customerPhone)) : undefined);
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
        : c.assignedFreelancerId
          ? {
              id: c.assignedFreelancerId,
              displayName: c.assignedFreelancerName || 'Assigned team member',
            }
          : null,
      adMetadata: (payload.adMetadata as any) || (lead?.customFields as any)?.adMetadata || null,
      isSharedWithMe: Boolean(
        Array.isArray(payload.shares) &&
        (payload.shares as any[]).some((s: any) => !s.revokedAt && s.userId === req.user?.userId)
      ),
      sharesCount: Array.isArray(payload.shares) ? (payload.shares as any[]).filter((s: any) => !s.revokedAt).length : 0,
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

  const showOnlyAssignedChats = visibilityMode === 'ASSIGNED_ONLY';
  await prisma.$transaction([
    prisma.aicloserWorkspace.update({
      where: { id: tenantId },
      data: { settings, updatedAt: new Date() },
    }),
    prisma.salesSettings.upsert({
      where: { tenantId },
      update: { showOnlyAssignedChats },
      create: {
        id: `sales-settings-${tenantId}`,
        tenantId,
        showOnlyAssignedChats,
      },
    }),
  ]);

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

  const messages: CleanChatMessage[] = sliced.map((m) => {
    const isOutbound =
      m.fromMe === true ||
      m.direction === 'OUTBOUND' ||
      m.senderRole === 'sales' ||
      m.senderRole === 'admin' ||
      m.senderRole === 'closer' ||
      m.senderRole === 'agent' ||
      m.senderRole === 'ai' ||
      (typeof m.senderLabel === 'string' &&
        (m.senderLabel.toLowerCase() === 'admin' ||
          m.senderLabel.toLowerCase() === 'sales closer'));

    return {
      id: String(m.id || randomUUID()),
      body: String(m.body || ''),
      lane: m.lane === 'internal' ? 'internal' : 'customer',
      createdAt: String(m.createdAt || new Date().toISOString()),
      senderRole: isOutbound
        ? 'sales'
        : m.senderRole === 'system'
        ? 'system'
        : 'customer',
      senderLabel: typeof m.senderLabel === 'string' ? m.senderLabel : undefined,
      senderType: (m.senderType === 'AI' ? 'AI' : isOutbound ? 'HUMAN' : 'CUSTOMER') as CleanChatMessage['senderType'],
      status: (m.status as CleanChatMessage['status']) || (m.deliveryStatus as CleanChatMessage['status']) || 'delivered',
      attachments: Array.isArray(m.attachments) ? (m.attachments as CleanChatMessage['attachments']) : undefined,
    };
  });

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

  const access = await checkConversationAccess(req, conversation);
  if (!access.hasAccess) {
    res.status(403).json({ success: false, data: null, error: 'Forbidden', message: 'You do not have access to send messages in this thread' });
    return;
  }

  // Shared users with VIEW permission cannot reply
  if (access.permission === 'VIEW') {
    res.status(403).json({
      success: false,
      data: null,
      error: 'ViewOnlyAccess',
      message: 'You have view-only access to this shared conversation and cannot send replies',
    });
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
    senderType: 'HUMAN',
    senderUserId: req.user?.userId || null,
    status: 'sent',
    attachments: body.attachments,
  };

  // Flag human activity in aiSettings for human takeover tracking
  if (payload.aiSettings && typeof payload.aiSettings === 'object') {
    (payload.aiSettings as any).lastHumanMessageAt = new Date().toISOString();
  }

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

  if (!(await verifyCloserAccess(req, conversation))) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to mark this conversation as read' });
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

  if (!(await verifyCloserAccess(req, conversation))) {
    res.status(403).json({ success: false, data: null, error: 'Forbidden', message: 'You do not have access to upload attachments in this conversation' });
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

  if (!(await verifyCloserAccess(req, conversation))) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to this attachment' });
    return;
  }

  const filePath = path.resolve(process.cwd(), 'data', 'uploads', 'attachments', String(id), String(filename));
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Attachment file not found' });
    return;
  }

  res.sendFile(filePath);
});

// 7. POST /:id/assign - Reassign conversation and linked lead (Role Guarded & Tenant Isolated)
const handleAssignConversation = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const id = String(req.params.id);
  const rawAgentId = String(
    req.body?.assignedAgentId ||
    req.body?.freelancerId ||
    (Array.isArray(req.body?.freelancerIds) ? req.body.freelancerIds[0] : '') ||
    ''
  ).trim();

  // 1. Check user permission (leads:reassign or admin/manager role)
  const canReassign = await hasPermission(user.userId, tenantId, user.role, PERM_LEADS_REASSIGN);
  if (!canReassign) {
    res.status(403).json({
      success: false,
      code: 'PERMISSION_DENIED',
      error: 'PermissionDenied',
      message: 'You lack permission to reassign leads/conversations (leads:reassign required)',
    });
    return;
  }

  if (!rawAgentId) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'assignedAgentId is required' });
    return;
  }

  // 2. Check conversation and tenant isolation
  const conversation = await prisma.appConversation.findUnique({
    where: { id },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  if (conversation.tenantId !== tenantId) {
    res.status(403).json({
      success: false,
      code: 'TENANT_ISOLATION_VIOLATION',
      error: 'TenantIsolationViolation',
      message: 'Cross-tenant assignment is strictly prohibited: conversation belongs to another workspace',
    });
    return;
  }

  // 3. Resolve target agent profile
  const agentProfile = await prisma.salesAgentProfile.findFirst({
    where: {
      OR: [{ id: rawAgentId }, { userId: rawAgentId }],
    },
    include: { user: { select: { id: true, displayName: true, role: true, email: true } } },
  });

  if (!agentProfile) {
    res.status(404).json({
      success: false,
      code: 'AGENT_NOT_IN_WORKSPACE',
      error: 'AgentNotInWorkspace',
      message: 'Target team member not found in workspace',
    });
    return;
  }

  if (agentProfile.tenantId !== tenantId) {
    res.status(403).json({
      success: false,
      code: 'TENANT_ISOLATION_VIOLATION',
      error: 'TenantIsolationViolation',
      message: 'Target team member belongs to a different workspace',
    });
    return;
  }

  // 4. Verify agent status is ACTIVE (reject INACTIVE / SUSPENDED / ON_LEAVE)
  if (agentProfile.status !== 'ACTIVE') {
    res.status(400).json({
      success: false,
      code: 'AGENT_NOT_ACTIVE',
      error: 'AgentNotActive',
      message: `Target team member is not active (current status: ${agentProfile.status}). Only ACTIVE members can be assigned.`,
    });
    return;
  }

  // 5. Allowed role: Administrators cannot be assigned leads
  if (agentProfile.user.role === 'ADMIN' || agentProfile.user.role === 'SUPER_ADMIN') {
    res.status(400).json({
      success: false,
      code: 'AGENT_NOT_ACTIVE',
      error: 'InvalidTargetRole',
      message: 'Administrators and Super Admins cannot be assigned leads. Target must be a sales agent or closer.',
    });
    return;
  }

  // 6. Duplicate assignment handled idempotently
  if (conversation.assignedFreelancerId === agentProfile.id) {
    res.status(200).json({
      success: true,
      code: 'DUPLICATE_ASSIGNMENT',
      message: 'Conversation is already assigned to this agent (idempotent)',
      data: {
        conversationId: id,
        assignedAgentId: agentProfile.id,
        assignedFreelancerName: agentProfile.user.displayName,
        idempotent: true,
      },
      error: null,
    });
    return;
  }

  const assignedFreelancerId = agentProfile.id;
  const assignedFreelancerName = agentProfile.user?.displayName || null;

  // Update conversation
  await prisma.appConversation.update({
    where: { id },
    data: {
      assignedFreelancerId,
      assignedFreelancerName,
    },
  });

  // Also update linked lead
  const linkedLead = await prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      OR: [
        { conversationId: id },
        ...phoneMatchConditions([conversation.customerPhone]),
      ],
    },
    select: { id: true, assignedAgentId: true },
  });

  await prisma.salesLeadAssignment.updateMany({
    where: {
      tenantId,
      OR: [
        { conversationId: id },
        ...phoneMatchConditions([conversation.customerPhone]),
      ],
    },
    data: { assignedAgentId: assignedFreelancerId },
  });

  if (linkedLead) {
    await prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: linkedLead.id,
        actorUserId: user.userId,
        action: 'LEAD_REASSIGNED',
        note: `Lead assigned to ${assignedFreelancerName || 'team member'}`,
        metadata: { previousAgentId: linkedLead.assignedAgentId, newAgentId: assignedFreelancerId, conversationId: id },
      },
    }).catch(() => undefined);
  }

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.updated',
    payload: { conversationId: id, assignedAgentId: assignedFreelancerId, assignedFreelancerName },
    actorUserId: user.userId,
  }).catch(() => undefined);

  // Symmetrically update mirrored MarketingContact
  if (conversation.customerPhone) {
    await prisma.marketingContact.updateMany({
      where: {
        tenantId,
        e164Phone: conversation.customerPhone,
      },
      data: { assignedAgentId: assignedFreelancerId, updatedAt: new Date() },
    }).catch(() => undefined);
  }

  res.json({
    success: true,
    message: 'Conversation and lead reassigned successfully',
    data: { conversationId: id, assignedAgentId: assignedFreelancerId, assignedFreelancerName },
    error: null,
  });
};

// 7. PATCH /:id/assignment & POST /:id/assign - Reassign conversation and linked lead
conversationsRouter.patch('/:id/assignment', handleAssignConversation);
conversationsRouter.post('/:id/assign', handleAssignConversation);

// Handler: Unassign conversation and linked lead
const handleUnassignConversation = async (req: Request, res: Response) => {
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

  const linkedLead = await prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      OR: [
        { conversationId: id },
        ...phoneMatchConditions([conversation.customerPhone]),
      ],
    },
    select: { id: true, assignedAgentId: true },
  });

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.updated',
    payload: { conversationId: id, assignedAgentId: null },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  if (linkedLead) {
    await prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: linkedLead.id,
        actorUserId: req.user?.userId,
        action: 'LEAD_UNASSIGNED',
        note: 'Lead removed from the assigned team member',
        metadata: { previousAgentId: linkedLead.assignedAgentId, conversationId: id },
      },
    }).catch(() => undefined);
  }

  if (conversation.customerPhone) {
    await prisma.marketingContact.updateMany({
      where: { tenantId, e164Phone: conversation.customerPhone },
      data: { assignedAgentId: null, updatedAt: new Date() },
    }).catch(() => undefined);
  }

  res.json({ success: true, message: 'Conversation unassigned successfully', error: null });
};

// DELETE /:id/assignment & DELETE /:id/assign
conversationsRouter.delete('/:id/assignment', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), handleUnassignConversation);
conversationsRouter.delete('/:id/assign', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), handleUnassignConversation);

// ==========================================
// SHARE CHAT ENDPOINTS
// ==========================================

// GET /:id/shares - List active shares for this conversation
conversationsRouter.get('/:id/shares', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const access = await checkConversationAccess(req, conversation);
  if (!access.hasAccess) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to view shares for this conversation' });
    return;
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  const rawShares = Array.isArray(payload.shares) ? (payload.shares as ConversationShareRecord[]) : [];
  const activeShares = rawShares.filter((s) => !s.revokedAt);

  // Enrich with user information
  const userIds = Array.from(new Set(activeShares.map((s) => s.userId).filter(Boolean)));
  const users = userIds.length
    ? await prisma.appAuthUser.findMany({
        where: { id: { in: userIds }, tenantId },
        select: { id: true, displayName: true, email: true, phone: true, role: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  const enrichedShares = activeShares.map((s) => {
    const user = userMap.get(s.userId);
    return {
      id: s.id,
      conversationId: s.conversationId,
      userId: s.userId,
      agentProfileId: s.agentProfileId || null,
      displayName: user?.displayName || s.userId,
      email: user?.email || null,
      phone: user?.phone || null,
      role: user?.role || null,
      permission: s.permission || 'REPLY',
      sharedByUserId: s.sharedByUserId,
      sharedByUserName: s.sharedByUserName || null,
      createdAt: s.createdAt,
    };
  });

  res.json({
    success: true,
    data: {
      conversationId: conversation.id,
      assignedAgentId: conversation.assignedFreelancerId,
      assignedAgentName: conversation.assignedFreelancerName,
      companyAdminAccess: {
        hasAccess: true,
        role: 'ADMIN',
        permission: 'REPLY',
        isPermanent: true,
        description: 'Company administrators have permanent visibility and reply access to all company conversations',
      },
      sharesCount: enrichedShares.length,
      shares: enrichedShares,
    },
    error: null,
  });
});

const createShareSchema = z.object({
  userId: z.string().min(1, 'Target userId or agentProfileId is required'),
  permission: z.enum(['VIEW', 'REPLY']).default('REPLY'),
});

// POST /:id/shares - Share conversation with another agent/user
conversationsRouter.post('/:id/shares', validateBody(createShareSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { userId: targetUserParam, permission } = req.body as z.infer<typeof createShareSchema>;

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  // Only admin, manager, or currently assigned closer can share a chat
  const access = await checkConversationAccess(req, conversation);
  if (!access.hasAccess || (!access.isOwnerOrAssigned && req.user?.role !== 'ADMIN' && req.user?.role !== 'SUPER_ADMIN' && req.user?.role !== 'MANAGER')) {
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Only workspace administrators or the assigned agent can share this conversation',
    });
    return;
  }

  // Resolve target user in this tenant (can be profile ID or user ID)
  const targetAgentProfile = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      OR: [{ id: targetUserParam }, { userId: targetUserParam }],
    },
    include: {
      user: { select: { id: true, displayName: true, email: true, role: true } },
    },
  });

  let targetUserId = targetAgentProfile?.userId;
  let targetDisplayName = targetAgentProfile?.user?.displayName;
  let targetProfileId = targetAgentProfile?.id;
  let targetUserRole = targetAgentProfile?.user?.role;

  if (!targetUserId) {
    const targetUser = await prisma.appAuthUser.findFirst({
      where: { id: targetUserParam, tenantId },
      select: { id: true, displayName: true, email: true, role: true },
    });
    if (!targetUser) {
      res.status(404).json({
        success: false,
        error: 'TargetUserNotFound',
        message: 'Target user does not exist in this workspace',
      });
      return;
    }
    targetUserId = targetUser.id;
    targetDisplayName = targetUser.displayName;
    targetUserRole = targetUser.role;
  }

  // Company Administrators already have permanent access to all conversations
  if (targetUserRole === 'ADMIN' || targetUserRole === 'SUPER_ADMIN') {
    res.status(200).json({
      success: true,
      code: 'ADMIN_PERMANENT_ACCESS',
      message: `${targetDisplayName || 'Admin'} is a Company Administrator and already has permanent full access to all company conversations`,
      data: {
        userId: targetUserId,
        displayName: targetDisplayName,
        role: targetUserRole,
        permission: 'REPLY',
        isPermanent: true,
      },
      error: null,
    });
    return;
  }

  // Prevent sharing with the currently assigned agent (they already have primary access)
  if (targetProfileId && targetProfileId === conversation.assignedFreelancerId) {
    res.status(400).json({
      success: false,
      error: 'AlreadyAssigned',
      message: 'This user is already the primary assigned agent for this conversation',
    });
    return;
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  const shares = Array.isArray(payload.shares) ? (payload.shares as ConversationShareRecord[]) : [];

  // Update existing active share or create new one
  const existingIndex = shares.findIndex((s) => s.userId === targetUserId && !s.revokedAt);
  let shareRecord: ConversationShareRecord;

  if (existingIndex !== -1) {
    shares[existingIndex] = {
      ...shares[existingIndex],
      permission,
      sharedByUserId: req.user!.userId,
      sharedByUserName: req.user!.displayName || req.user!.email,
      agentProfileId: targetProfileId || shares[existingIndex].agentProfileId,
    };
    shareRecord = shares[existingIndex];
  } else {
    shareRecord = {
      id: `share-${randomUUID()}`,
      conversationId: conversation.id,
      userId: targetUserId,
      agentProfileId: targetProfileId || null,
      sharedByUserId: req.user!.userId,
      sharedByUserName: req.user!.displayName || req.user!.email,
      permission,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    shares.push(shareRecord);
  }

  // Update sharedUserIds array on payload for fast indexed Prisma querying
  const activeShares = shares.filter((s) => !s.revokedAt);
  const sharedUserIds = Array.from(new Set(activeShares.flatMap((s) => [s.userId, s.agentProfileId]).filter(Boolean))) as string[];

  payload.shares = shares;
  payload.sharedUserIds = sharedUserIds;

  await prisma.appConversation.update({
    where: { id: conversation.id },
    data: {
      payload: payload as unknown as Prisma.InputJsonValue,
      updatedAt: new Date(),
    },
  });

  // Log activity on linked lead
  const lead = await prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      OR: [
        { conversationId: conversation.id },
        ...phoneMatchConditions([conversation.customerPhone]),
      ],
    },
    select: { id: true },
  });

  if (lead) {
    await prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: lead.id,
        actorUserId: req.user?.userId,
        action: 'CHAT_SHARED',
        note: `Conversation shared with ${targetDisplayName || targetUserId} (${permission} access)`,
        metadata: { targetUserId, permission, shareId: shareRecord.id },
      },
    }).catch(() => undefined);
  }

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'conversation.shared',
    payload: {
      conversationId: conversation.id,
      share: shareRecord,
      sharedWith: {
        userId: targetUserId,
        displayName: targetDisplayName,
        permission,
      },
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.status(200).json({
    success: true,
    message: `Conversation shared with ${targetDisplayName || targetUserId} successfully`,
    data: {
      ...shareRecord,
      displayName: targetDisplayName,
    },
    error: null,
  });
});

// DELETE /:id/shares/:userId - Revoke a shared user's access
conversationsRouter.delete('/:id/shares/:userId', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const targetUserParam = String(req.params.userId).trim();

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  // Only admin, manager, or currently assigned closer can remove a share
  const access = await checkConversationAccess(req, conversation);
  if (!access.hasAccess || (!access.isOwnerOrAssigned && req.user?.role !== 'ADMIN' && req.user?.role !== 'SUPER_ADMIN' && req.user?.role !== 'MANAGER')) {
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Only workspace administrators or the assigned agent can revoke chat shares',
    });
    return;
  }

  // Administrators have permanent company access and cannot be unshared
  const targetProfile = await prisma.salesAgentProfile.findFirst({
    where: { tenantId, OR: [{ id: targetUserParam }, { userId: targetUserParam }] },
    select: { userId: true, user: { select: { role: true } } },
  });
  const targetUserCheck = targetProfile
    ? { id: targetProfile.userId, role: targetProfile.user.role }
    : await prisma.appAuthUser.findFirst({
        where: { tenantId, id: targetUserParam },
        select: { id: true, role: true },
      });

  if (targetUserCheck?.role === 'ADMIN' || targetUserCheck?.role === 'SUPER_ADMIN') {
    res.status(400).json({
      success: false,
      error: 'CannotRevokeAdminAccess',
      message: 'Company administrators have permanent company access to all conversations and cannot be revoked',
    });
    return;
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  const shares = Array.isArray(payload.shares) ? (payload.shares as ConversationShareRecord[]) : [];

  const shareIndex = shares.findIndex(
    (s) => !s.revokedAt && (s.userId === targetUserParam || s.agentProfileId === targetUserParam || s.id === targetUserParam)
  );

  if (shareIndex === -1) {
    res.status(404).json({
      success: false,
      error: 'ShareNotFound',
      message: 'No active share found for this user on this conversation',
    });
    return;
  }

  const revokedShare = {
    ...shares[shareIndex],
    revokedAt: new Date().toISOString(),
  };
  shares[shareIndex] = revokedShare;

  const activeShares = shares.filter((s) => !s.revokedAt);
  const sharedUserIds = Array.from(new Set(activeShares.flatMap((s) => [s.userId, s.agentProfileId]).filter(Boolean))) as string[];

  payload.shares = shares;
  payload.sharedUserIds = sharedUserIds;

  await prisma.appConversation.update({
    where: { id: conversation.id },
    data: {
      payload: payload as unknown as Prisma.InputJsonValue,
      updatedAt: new Date(),
    },
  });

  // Log activity on linked lead
  const lead = await prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      OR: [
        { conversationId: conversation.id },
        ...phoneMatchConditions([conversation.customerPhone]),
      ],
    },
    select: { id: true },
  });

  if (lead) {
    await prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: lead.id,
        actorUserId: req.user?.userId,
        action: 'CHAT_SHARE_REVOKED',
        note: `Conversation share revoked for ${revokedShare.userId}`,
        metadata: { revokedUserId: revokedShare.userId, shareId: revokedShare.id },
      },
    }).catch(() => undefined);
  }

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'conversation.unshared',
    payload: {
      conversationId: conversation.id,
      revokedShareId: revokedShare.id,
      userId: revokedShare.userId,
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.json({
    success: true,
    message: 'Conversation share revoked successfully',
    data: {
      conversationId: conversation.id,
      revokedUserId: revokedShare.userId,
      revokedAt: revokedShare.revokedAt,
    },
    error: null,
  });
});

// ==========================================
// CONVERSATION AI SETTINGS ENDPOINTS
// ==========================================

const aiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['HUMAN_ONLY', 'AI_ASSISTED', 'AI_AUTO_REPLY']).optional(),
  aiAgentId: z.string().nullable().optional(),
  humanTakeover: z.boolean().optional(),
});

// GET /:id/ai-settings - Get conversation-level AI settings
conversationsRouter.get('/:id/ai-settings', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const access = await checkConversationAccess(req, conversation);
  if (!access.hasAccess) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to view AI settings for this conversation' });
    return;
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  const aiSettings: ConversationAiSettings = (payload.aiSettings as ConversationAiSettings) || {
    enabled: true,
    mode: 'AI_ASSISTED',
    aiAgentId: 'default-ai',
    humanTakeover: true,
  };

  res.json({
    success: true,
    data: aiSettings,
    error: null,
  });
});

// PATCH /:id/ai-settings - Update conversation-level AI settings
conversationsRouter.patch('/:id/ai-settings', validateBody(aiSettingsSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof aiSettingsSchema>;

  const conversation = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }

  const access = await checkConversationAccess(req, conversation);
  if (!access.hasAccess) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to configure AI settings for this conversation' });
    return;
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  const currentAiSettings: ConversationAiSettings = (payload.aiSettings as ConversationAiSettings) || {
    enabled: true,
    mode: 'AI_ASSISTED',
    aiAgentId: 'default-ai',
    humanTakeover: true,
  };

  const updatedAiSettings: ConversationAiSettings = {
    enabled: body.enabled !== undefined ? body.enabled : currentAiSettings.enabled,
    mode: body.mode || currentAiSettings.mode,
    aiAgentId: body.aiAgentId !== undefined ? body.aiAgentId : currentAiSettings.aiAgentId,
    humanTakeover: body.humanTakeover !== undefined ? body.humanTakeover : currentAiSettings.humanTakeover,
    lastHumanMessageAt: currentAiSettings.lastHumanMessageAt || null,
    updatedAt: new Date().toISOString(),
    updatedByUserId: req.user?.userId,
  };

  payload.aiSettings = updatedAiSettings;

  await prisma.appConversation.update({
    where: { id: conversation.id },
    data: {
      payload: payload as unknown as Prisma.InputJsonValue,
      updatedAt: new Date(),
    },
  });

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'conversation.ai_settings_updated',
    payload: {
      conversationId: conversation.id,
      aiSettings: updatedAiSettings,
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.json({
    success: true,
    message: 'Conversation AI settings updated successfully',
    data: updatedAiSettings,
    error: null,
  });
});

// 8. PATCH /:id/stage - Update lead stage from chat workspace
conversationsRouter.patch('/:id/stage', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { stage } = req.body as { stage: string };
  const requestedStage = String(stage || '').trim().toUpperCase();

  if (!requestedStage) {
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

  if (!(await verifyCloserAccess(req, conversation))) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to change this lead stage' });
    return;
  }

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const workspaceSettings = (workspace?.settings as Record<string, any>) || {};
  const configuredStages = Array.isArray(workspaceSettings.pipelineStages) ? workspaceSettings.pipelineStages : [];
  const supportedStages = new Set([
    'NEW', 'CONTACTED', 'QUALIFIED', 'QUOTE_SENT', 'PAYMENT_PENDING', 'PAID',
    'HANDOFF', 'CLOSED', 'LOST', 'CONVERTED_FREE', 'ASSIGNED', 'INTERESTED',
    'WEBINAR_INVITED', 'WEBINAR_ATTENDED', 'FOLLOW_UP', 'NEGOTIATION',
    'CLOSED_WON', 'CLOSED_LOST', 'NOT_REACHABLE', 'RECYCLED',
  ]);
  const isConfiguredCustomStage = configuredStages.some((configured: any) =>
    String(configured?.key ?? configured?.id ?? '').trim().toUpperCase() === requestedStage,
  );
  if (!supportedStages.has(requestedStage) && !isConfiguredCustomStage) {
    res.status(400).json({ success: false, error: 'InvalidStage', message: 'Choose a live workspace stage.' });
    return;
  }

  const phoneDigits = String(conversation.customerPhone || '').replace(/\D/g, '');
  const phoneSuffix = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : '';

  const linkedLeads = await prisma.salesLeadAssignment.findMany({
    where: {
      tenantId,
      OR: [
        { conversationId: id },
        ...phoneMatchConditions([conversation.customerPhone]),
        ...(phoneSuffix ? [{ customerPhone: { endsWith: phoneSuffix } }] : []),
      ],
    },
    select: { id: true, stage: true, customFields: true },
  });

  if (!linkedLeads.length) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'No linked lead record found for this conversation' });
    return;
  }

  if (supportedStages.has(requestedStage)) {
    await prisma.salesLeadAssignment.updateMany({
      where: { id: { in: linkedLeads.map((linkedLead) => linkedLead.id) } },
      data: { stage: requestedStage as any, stageChangedAt: new Date(), conversationId: id },
    });
  } else {
    await Promise.all(linkedLeads.map((linkedLead) => {
      const currentCustomFields = linkedLead.customFields && typeof linkedLead.customFields === 'object' && !Array.isArray(linkedLead.customFields)
        ? linkedLead.customFields as Record<string, unknown>
        : {};
      return prisma.salesLeadAssignment.update({
        where: { id: linkedLead.id },
        data: {
          customFields: { ...currentCustomFields, customStage: requestedStage },
          stageChangedAt: new Date(),
          conversationId: id,
        },
      });
    }));
  }

  const currentPayload = conversation.payload && typeof conversation.payload === 'object' && !Array.isArray(conversation.payload)
    ? conversation.payload as Record<string, unknown>
    : {};
  await prisma.appConversation.update({
    where: { id },
    data: {
      leadStatusId: requestedStage,
      payload: { ...currentPayload, leadStatusId: requestedStage, updatedAt: new Date().toISOString() },
      updatedAt: new Date(),
    },
  });

  await Promise.all(linkedLeads.map((linkedLead) => prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: linkedLead.id,
      actorUserId: req.user?.userId,
      action: 'LEAD_STAGE_CHANGED',
      note: `Lead stage changed from ${linkedLead.stage} to ${requestedStage}`,
      metadata: { previousStage: linkedLead.stage, newStage: requestedStage, conversationId: id },
    },
  }).catch(() => undefined)));

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.stage_changed',
    payload: { conversationId: id, stage: requestedStage },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  // Sync mirrored marketing contact with updated lead stage
  const updatedStageLeads = await prisma.salesLeadAssignment.findMany({
    where: { id: { in: linkedLeads.map((linkedLead) => linkedLead.id) }, tenantId },
  });
  await Promise.all(updatedStageLeads.map((l) => syncMarketingContactForLead(l))).catch(() => undefined);

  res.json({ success: true, message: 'Lead stage updated successfully', affectedLeads: linkedLeads.length, error: null });
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

  if (!(await verifyCloserAccess(req, conversation))) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to add notes to this conversation' });
    return;
  }

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      OR: [
        { conversationId: id },
        ...phoneMatchConditions([conversation.customerPhone]),
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

  if (!(await verifyCloserAccess(req, conversation))) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to schedule a follow-up for this conversation' });
    return;
  }

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      OR: [
        { conversationId: id },
        ...phoneMatchConditions([conversation.customerPhone]),
      ],
    },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'No linked lead found' });
    return;
  }

  const parsedDate = new Date(followUpAt);
  if (Number.isNaN(parsedDate.getTime())) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'followUpAt must be a valid date string' });
    return;
  }
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

  const scheduledAt = parsedDate.toISOString();
  const reminderAt = new Date(parsedDate.getTime() - 5 * 60_000).toISOString();
  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: lead.id,
      actorUserId: req.user?.userId,
      action: 'CALLBACK_SCHEDULED',
      note: note?.trim() || `Callback scheduled for ${scheduledAt}`,
      metadata: { followUpAt: scheduledAt, reminderAt, conversationId: id },
    },
  }).catch(() => undefined);
  res.status(201).json({
    success: true,
    data: {
      leadId: lead.id,
      conversationId: id,
      followUpAt: scheduledAt,
      task,
      mobileReminder: {
        type: 'CALLBACK_REMINDER',
        triggerAt: reminderAt,
        title: 'Callback in 5 minutes',
        message: `${conversation.customerName || conversation.customerPhone || 'Lead'} callback is scheduled for ${scheduledAt}.`,
        deepLinkUrl: `aicloser://conversations/${encodeURIComponent(id)}`,
      },
    },
    error: null,
  });
});

// 11. POST /:id/typing - Broadcast typing state
conversationsRouter.post('/:id/typing', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { isTyping } = req.body as { isTyping: boolean };

  const conversation = await prisma.appConversation.findFirst({ where: { id, tenantId } });
  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }
  if (!(await verifyCloserAccess(req, conversation))) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to this conversation' });
    return;
  }

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

  const conversation = await prisma.appConversation.findFirst({ where: { id, tenantId } });
  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
    return;
  }
  if (!(await verifyCloserAccess(req, conversation))) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to this conversation' });
    return;
  }

  if (!channel) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'channel is required' });
    return;
  }

  const updated = await prisma.appConversation.update({
    where: { id: conversation.id },
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

  if (!(await verifyCloserAccess(req, conversation))) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to this conversation' });
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

  if (!(await verifyCloserAccess(req, conversation))) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to this conversation' });
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
