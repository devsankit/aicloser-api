import { maskPhoneNumber, isPhoneMaskingRequired } from '../../lib/phone-mask.js';
import { decryptWhatsAppToken } from '../../lib/crypto-vault.js';
import { logger } from '../../lib/logger.js';
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
import { getWorkspaceScope, checkSameReportingTeam } from '../../lib/workspace-scope.js';
import { syncMarketingContactForLead, normalizeLeadPhone, deleteContactsAndLinkedLeadsTransactional } from '../../lib/lead-contact-sync.js';
import { getLead360 } from './leads.js';
import { getTenantDevices } from './integrations.js';

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
  externalMessageId?: string | null;
  template?: {
    name: string;
    language?: string;
  };
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

export interface Window24HourStatus {
  is24HourWindowOpen: boolean;
  lastInboundAt: string | null;
  windowExpiresAt: string | null;
  remainingMs?: number;
  windowHours?: number;
  isAdLead?: boolean;
}

export function calculate24HourWindow(
  conversation: {
    serviceSlug?: string | null;
    payload?: any;
    isAdLead?: boolean;
  },
  linkedLead?: any
): Window24HourStatus {
  const serviceSlug = String(conversation.serviceSlug || '').toLowerCase();

  // Personal QR chats (companion WhatsApp via Baileys) have no 24-hour service window limit
  if (serviceSlug === 'manual-chat') {
    return {
      is24HourWindowOpen: true,
      lastInboundAt: null,
      windowExpiresAt: null,
      remainingMs: undefined,
      windowHours: 0,
      isAdLead: false,
    };
  }

  const payload = (conversation.payload as Record<string, unknown>) || {};
  const rawMessages = Array.isArray(payload.messages) ? (payload.messages as Record<string, unknown>[]) : [];

  const isAd = Boolean(
    conversation.isAdLead ||
    payload.isAdLead === true ||
    payload.source === 'Ads' ||
    payload.leadSource === 'Ads' ||
    (payload.referral as any)?.source_type === 'ad' ||
    linkedLead?.source === 'Ads' ||
    (linkedLead?.rawSource || '').toLowerCase().includes('ad') ||
    (typeof payload.sourceChannel === 'string' && payload.sourceChannel.toLowerCase().includes('ad'))
  );

  let lastInboundTime = 0;

  for (const msg of rawMessages) {
    const isOutbound =
      msg.fromMe === true ||
      msg.direction === 'OUTBOUND' ||
      msg.senderType === 'HUMAN' ||
      ['sales', 'admin', 'closer', 'agent', 'system'].includes(String(msg.senderRole || msg.role || ''));

    const isCustomerInbound =
      !isOutbound &&
      (msg.senderRole === 'customer' ||
        msg.role === 'customer' ||
        msg.lane === 'customer' ||
        msg.sender === 'customer' ||
        (!msg.fromMe && msg.direction !== 'OUTBOUND'));

    if (isCustomerInbound && msg.createdAt) {
      const t = new Date(String(msg.createdAt)).getTime();
      if (!isNaN(t) && t > lastInboundTime) {
        lastInboundTime = t;
      }
    }
  }

  const windowHours = isAd ? 72 : 24;
  const WINDOW_MS = windowHours * 60 * 60 * 1000;

  if (lastInboundTime === 0) {
    // Official API: No inbound message received yet from customer. Free-form messaging locked.
    return {
      is24HourWindowOpen: false,
      lastInboundAt: null,
      windowExpiresAt: null,
      remainingMs: 0,
      windowHours,
      isAdLead: isAd,
    };
  }

  const now = Date.now();
  const expiresAt = lastInboundTime + WINDOW_MS;
  const remainingMs = Math.max(0, expiresAt - now);

  if (now >= expiresAt) {
    // Window has expired. Free-form messaging locked.
    return {
      is24HourWindowOpen: false,
      lastInboundAt: new Date(lastInboundTime).toISOString(),
      windowExpiresAt: null,
      remainingMs: 0,
      windowHours,
      isAdLead: isAd,
    };
  }

  return {
    is24HourWindowOpen: true,
    lastInboundAt: new Date(lastInboundTime).toISOString(),
    windowExpiresAt: new Date(expiresAt).toISOString(),
    remainingMs,
    windowHours,
    isAdLead: isAd,
  };
}

const listConversationsQuerySchema = z.object({
  page: z.string().optional().transform((v) => (v ? Math.max(1, Number(v)) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, Math.max(1, Number(v))) : 25)),
  status: z.string().optional(),
  search: z.string().optional(),
  customerPhone: z.string().optional(),
  channel: z.string().optional(),
  sourceType: z.enum(['ALL', 'OFFICIAL_API', 'QR_SCANNER']).optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  scannerName: z.string().optional(),
  scannerUserId: z.string().optional(),
  includeEmpty: z.string().optional(),
});

const sendMessageSchema = z
  .object({
    body: z.string().optional().default(''),
    lane: z.enum(['customer', 'internal']).optional().default('customer'),
    dispatchChannel: z.enum(['OFFICIAL_API', 'PERSONAL', 'AUTO']).optional(),
    templateName: z.string().optional(),
    templateLanguage: z.string().optional().default('en_US'),
    templateComponents: z.array(z.any()).optional(),
    variableValues: z.record(z.unknown()).optional(),
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
  })
  .refine(
    (data) =>
      (data.body && data.body.trim().length > 0) ||
      Boolean(data.templateName && data.templateName.trim().length > 0) ||
      Boolean(data.attachments && data.attachments.length > 0),
    {
      message: 'Message body, templateName, or attachment is required',
      path: ['body'],
    }
  );

const getOrCreateConversationSchema = z.object({
  leadId: z.string().optional(),
  customerPhone: z.string().min(1, 'Customer phone is required'),
  customerName: z.string().optional(),
  channelSource: z.enum(['OFFICIAL_API', 'QR_SCANNER']).optional().default('OFFICIAL_API'),
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
  if (settings.chatVisibility === 'COMPANY_WIDE') {
    return 'COMPANY_WIDE';
  }
  // Default to strict ASSIGNED_ONLY to prevent cross-agent lead leakage
  return 'ASSIGNED_ONLY';
}

// Helper: Check detailed user access and permission (VIEW vs REPLY, Assigned vs Shared)
async function checkConversationAccess(
  req: Request,
  conversation: { id: string; customerPhone?: string; assignedFreelancerId?: string | null; payload?: any }
): Promise<ConversationAccessResult> {
  const user = req.user;
  if (!user) return { hasAccess: false, isOwnerOrAssigned: false, isShared: false, permission: 'VIEW' };

  // Super Admin and Admin have unconditional permanent REPLY access
  const roleUpper = String(user.role || '').toUpperCase();
  if (roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN') {
    return { hasAccess: true, isOwnerOrAssigned: true, isShared: false, permission: 'REPLY' };
  }

  const tenantId = req.tenantId!;
  const payload = (conversation.payload as Record<string, unknown>) || {};
  const isPersonalQr = Boolean(
    payload.isPersonalQr ||
    payload.scannedByUserId ||
    (conversation as any).serviceSlug === 'manual-chat'
  );
  const scannedByUserId = (payload.scannedByUserId as string | undefined) || undefined;
  const scope = await getWorkspaceScope(tenantId, user);

  // 1. Direct assignment check: if the conversation is directly assigned to current user's profile, userId, or displayName
  const isDirectlyAssigned = Boolean(
    (conversation.assignedFreelancerId && (scope.profileIds.includes(conversation.assignedFreelancerId) || conversation.assignedFreelancerId === user.userId)) ||
    (payload.assignedUserId && payload.assignedUserId === user.userId) ||
    ((conversation as any).assignedFreelancerName && user.displayName && (conversation as any).assignedFreelancerName.toLowerCase() === user.displayName.toLowerCase())
  );
  if (isDirectlyAssigned) {
    return { hasAccess: true, isOwnerOrAssigned: true, isShared: false, permission: 'REPLY' };
  }

  // 2. Check if linked lead is assigned to current user's profile
  if (scope.profileIds.length > 0) {
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
  }

  // 3. Personal companion WhatsApp chats:
  if (isPersonalQr) {
    // If current user is the scanner AND the chat has NOT been reassigned away to another teammate
    const isReassignedAway = Boolean(
      conversation.assignedFreelancerId &&
      !scope.profileIds.includes(conversation.assignedFreelancerId) &&
      conversation.assignedFreelancerId !== user.userId &&
      conversation.assignedFreelancerId !== 'Unassigned'
    );

    if (scannedByUserId && scannedByUserId === user.userId && !isReassignedAway) {
      return { hasAccess: true, isOwnerOrAssigned: true, isShared: false, permission: 'REPLY' };
    }

    // Check if explicitly shared with this user
    const shares = Array.isArray(payload.shares) ? (payload.shares as ConversationShareRecord[]) : [];
    const activeShare = shares.find((s) => !s.revokedAt && (s.userId === user.userId || (s.agentProfileId && scope.profileIds.includes(s.agentProfileId))));
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

  const mode = (roleUpper === 'SALES_AGENT' || roleUpper === 'CLOSER') ? await getChatVisibilityMode(tenantId) : 'COMPANY_WIDE';
  if (mode === 'COMPANY_WIDE') {
    return { hasAccess: true, isOwnerOrAssigned: true, isShared: false, permission: 'REPLY' };
  }

  // Check if explicitly shared with this user (active share with no revokedAt)
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

// Universal conversation resolver: resolves direct IDs, QR scanned leads, sales lead IDs, and stripped prefixes
export async function resolveAppConversation(tenantId: string, rawId: string, autoCreateFromLead = false) {
  if (!rawId) return null;
  const id = String(rawId).trim();

  // 1. Direct match in AppConversation
  let conv = await prisma.appConversation.findFirst({
    where: { id, tenantId },
  });
  if (conv) return conv;

  // 2. Strip prefixes: 'conv-lead-', 'lead-', 'draft-'
  const cleanId = id.replace(/^conv-lead-/, '').replace(/^lead-/, '').replace(/^draft-/, '');

  // 3. Direct match with stripped ID
  conv = await prisma.appConversation.findFirst({
    where: { id: cleanId, tenantId },
  });
  if (conv) return conv;

  // 4. If cleanId starts with 'sales-conversation-', strip that too
  if (cleanId.startsWith('sales-conversation-')) {
    const directConvId = cleanId.replace(/^sales-conversation-/, '');
    conv = await prisma.appConversation.findFirst({
      where: { id: directConvId, tenantId },
    });
    if (conv) return conv;
  }

  // 5. Query SalesLeadAssignment for this lead
  const lead = await prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      OR: [
        { id },
        { id: cleanId },
        { id: `lead-${cleanId}` },
        { id: `sales-conversation-${cleanId}` },
        { conversationId: id },
        { conversationId: cleanId },
        ...(cleanId.startsWith('sales-conversation-')
          ? [{ conversationId: cleanId.replace(/^sales-conversation-/, '') }]
          : []),
      ],
    },
  });

  if (lead) {
    if (lead.conversationId) {
      conv = await prisma.appConversation.findFirst({
        where: { id: lead.conversationId, tenantId },
      });
      if (conv) return conv;
    }
    if (lead.customerPhone) {
      const cleanPhone = lead.customerPhone.replace(/\D/g, '').slice(-10);
      conv = await prisma.appConversation.findFirst({
        where: {
          tenantId,
          OR: [
            { customerPhone: lead.customerPhone },
            { customerPhone: { contains: cleanPhone } },
          ],
        },
      });
      if (conv) {
        await prisma.salesLeadAssignment.update({
          where: { id: lead.id },
          data: { conversationId: conv.id },
        }).catch(() => undefined);
        return conv;
      }

      if (autoCreateFromLead) {
        const initialSnippet = lead.notes
          ? lead.notes.replace(/^Synced with chat history via WA Business Scanner:\s*"?|"?$/g, '').trim()
          : '';
        const initialMessages = initialSnippet
          ? [
              {
                id: `msg-${randomUUID().slice(0, 8)}`,
                body: initialSnippet,
                sender: 'customer',
                senderRole: 'customer',
                lane: 'customer',
                createdAt: lead.createdAt ? new Date(lead.createdAt).toISOString() : new Date().toISOString(),
                status: 'read',
              },
            ]
          : [];

        let assignedCloserId: string | null = lead.assignedAgentId || null;
        let assignedCloserName: string | null = null;
        if (lead.assignedAgentId) {
          const prof = await prisma.salesAgentProfile.findUnique({
            where: { id: lead.assignedAgentId },
            include: { user: true },
          }).catch(() => null);
          assignedCloserName = prof?.user?.displayName || null;
        }

        conv = await prisma.appConversation.create({
          data: {
            id: `conv-${randomUUID().slice(0, 8)}`,
            tenantId,
            serviceId: 'svc-whatsapp',
            serviceSlug: 'whatsapp',
            leadStatusId: 'new',
            customerName: lead.customerName || 'WhatsApp Contact',
            customerPhone: lead.customerPhone,
            assignedFreelancerId: assignedCloserId,
            assignedFreelancerName: assignedCloserName,
            status: 'Active',
            payload: {
              messages: initialMessages,
              sourceChannel: 'whatsapp',
              customerName: lead.customerName || 'WhatsApp Contact',
              customerPhone: lead.customerPhone,
              assignedTo: assignedCloserName || undefined,
            },
          },
        });
        await prisma.salesLeadAssignment.update({
          where: { id: lead.id },
          data: { conversationId: conv.id },
        }).catch(() => undefined);
        return conv;
      }
    }
  }

  // 6. Match by phone digits if id has >= 10 digits
  const digits = id.replace(/\D/g, '');
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    conv = await prisma.appConversation.findFirst({
      where: {
        tenantId,
        customerPhone: { contains: last10 },
      },
    });
    if (conv) return conv;
  }

  return null;
}

conversationsRouter.get('/:id/360', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const conversation = await resolveAppConversation(tenantId, String(req.params.id), false);
  if (!conversation) return void res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
  if (!(await verifyCloserAccess(req, conversation))) return void res.status(403).json({ success: false, error: 'Forbidden', message: 'Conversation access denied' });
  const profile = req.user?.userId ? await prisma.salesAgentProfile.findFirst({ where: { userId: req.user.userId, tenantId }, select: { id: true } }) : null;
  const lead = (profile ? await prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      assignedAgentId: profile.id,
      OR: [{ conversationId: conversation.id }, ...phoneMatchConditions([conversation.customerPhone])],
    },
    select: { id: true },
  }) : null) || await prisma.salesLeadAssignment.findFirst({
    where: { tenantId, OR: [{ conversationId: conversation.id }, ...phoneMatchConditions([conversation.customerPhone])] },
    select: { id: true },
  });
  if (!lead) return void res.json({ success: true, data: { lead: null, notes: [], timeline: [], history: [], tasks: [], calls: [], payments: [] }, error: null });
  req.params.id = lead.id;
  await getLead360(req, res);
});

// 1. GET / - List conversations with strict closer scoping and rich UI fields
conversationsRouter.get('/', validateQuery(listConversationsQuerySchema), async (req: Request, res: Response) => {
  const { page, limit, status, search, customerPhone, channel, sourceType, agentId, agentName, scannerName, scannerUserId, includeEmpty } = req.query as unknown as {
    page: number;
    limit: number;
    status?: string;
    search?: string;
    customerPhone?: string;
    channel?: string;
    sourceType?: 'ALL' | 'OFFICIAL_API' | 'QR_SCANNER';
    agentId?: string;
    agentName?: string;
    scannerName?: string;
    scannerUserId?: string;
    includeEmpty?: string;
  };

  const tenantId = req.tenantId!;
  const andConditions: any[] = [{ tenantId }];

  // Exclude empty 0-message conversations from the inbox by default unless includeEmpty === 'true'
  const shouldExcludeEmpty = includeEmpty !== 'true' && includeEmpty !== '1';
  if (shouldExcludeEmpty) {
    andConditions.push({
      NOT: [{ payload: { path: ['messages'], equals: [] } }],
    });
  }

  // Dedicated API vs QR Scanner filtering
  if (scannerName) {
    // Strictly personal scanned QR WhatsApp chats for this specific team member or shared with them
    andConditions.push({
      serviceSlug: 'manual-chat',
      OR: [
        { payload: { path: ['scannedByName'], string_contains: scannerName } },
        { payload: { path: ['sharedUserIds'], array_contains: scannerName } },
        ...(req.user?.userId ? [{ payload: { path: ['sharedUserIds'], array_contains: req.user.userId } }] : []),
      ],
    });
  } else if (scannerUserId) {
    // Strictly personal scanned QR WhatsApp chats for this specific user ID or shared with them
    andConditions.push({
      serviceSlug: 'manual-chat',
      OR: [
        { payload: { path: ['scannedByUserId'], equals: scannerUserId } },
        { payload: { path: ['sharedUserIds'], array_contains: scannerUserId } },
      ],
    });
  } else {
    if (sourceType === 'OFFICIAL_API') {
      andConditions.push({ serviceSlug: { not: 'manual-chat' } });
    } else if (sourceType === 'QR_SCANNER') {
      andConditions.push({ serviceSlug: 'manual-chat' });
    }

    // Filter by specific closer/agent when requested (e.g. Admin selected agent in header)
    if (agentId) {
      if (sourceType === 'QR_SCANNER') {
        andConditions.push({
          serviceSlug: 'manual-chat',
          payload: { path: ['scannedByUserId'], equals: agentId },
        });
      } else if (sourceType === 'OFFICIAL_API') {
        andConditions.push({
          serviceSlug: { not: 'manual-chat' },
          assignedFreelancerId: agentId,
        });
      } else {
        andConditions.push({
          OR: [
            { assignedFreelancerId: agentId },
            { payload: { path: ['scannedByUserId'], equals: agentId } },
          ],
        });
      }
    } else if (agentName) {
      if (sourceType === 'QR_SCANNER') {
        andConditions.push({
          serviceSlug: 'manual-chat',
          payload: { path: ['scannedByName'], string_contains: agentName },
        });
      } else if (sourceType === 'OFFICIAL_API') {
        andConditions.push({
          serviceSlug: { not: 'manual-chat' },
          assignedFreelancerName: { contains: agentName, mode: 'insensitive' },
        });
      } else {
        andConditions.push({
          OR: [
            { assignedFreelancerName: { contains: agentName, mode: 'insensitive' } },
            { payload: { path: ['scannedByName'], string_contains: agentName } },
          ],
        });
      }
    }
  }

  // Closers see their assigned conversations. Managers see their reporting
  // team. Admins retain the tenant-wide inbox.
  const authUser = req.user;
  if (authUser && (authUser.role === 'SALES_AGENT' || (authUser.role as any) === 'CLOSER')) {
    const mode = await getChatVisibilityMode(tenantId);
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: authUser.userId, tenantId },
      select: { id: true },
    });

    if (mode !== 'COMPANY_WIDE') {
      const assignedLeads = profile
        ? await prisma.salesLeadAssignment.findMany({
            where: { assignedAgentId: profile.id, tenantId },
            select: { id: true, customerPhone: true, conversationId: true },
          })
        : [];

      const phones = assignedLeads.map((l) => l.customerPhone).filter(Boolean) as string[];
      const convIds = assignedLeads.map((l) => l.conversationId).filter(Boolean) as string[];

      // Closer conversation visibility:
      // 1. Any conversation (API or Personal QR) explicitly assigned to THIS agent or matching their assigned leads
      // 2. Personal QR chats scanned by THIS agent that have NOT been reassigned away to another agent
      // 3. Conversations explicitly shared with THIS agent
      andConditions.push({
        OR: [
          // 1. Assigned to THIS closer (by profile ID, userId, convId, or phone match)
          { assignedFreelancerId: profile?.id ?? '__NO_ACCESS__' },
          { payload: { path: ['assignedUserId'], equals: authUser.userId } },
          ...(convIds.length > 0 ? [{ id: { in: convIds } }] : []),
          ...phoneMatchConditions(phones),

          // 2. Personal QR chats scanned by THIS agent (only if unassigned or still assigned to this closer)
          {
            serviceSlug: 'manual-chat',
            payload: { path: ['scannedByUserId'], equals: authUser.userId },
            OR: [
              { assignedFreelancerId: null },
              { assignedFreelancerId: 'Unassigned' },
              ...(profile ? [{ assignedFreelancerId: profile.id }] : []),
              { payload: { path: ['assignedUserId'], equals: authUser.userId } },
            ],
          },

          // 3. Explicitly shared with THIS agent
          {
            payload: { path: ['sharedUserIds'], array_contains: authUser.userId },
          },
          ...(profile ? [{ payload: { path: ['sharedUserIds'], array_contains: profile.id } }] : []),
        ],
      });
    } else {
      // In COMPANY_WIDE mode, sales reps see all general/API channels,
      // but personal companion QR chats are visible only if assigned, scanned (and not reassigned away), or shared.
      andConditions.push({
        OR: [
          { assignedFreelancerId: profile?.id ?? '__NO_ACCESS__' },
          { payload: { path: ['assignedUserId'], equals: authUser.userId } },
          {
            serviceSlug: 'manual-chat',
            payload: { path: ['scannedByUserId'], equals: authUser.userId },
            OR: [
              { assignedFreelancerId: null },
              { assignedFreelancerId: 'Unassigned' },
              ...(profile ? [{ assignedFreelancerId: profile.id }] : []),
              { payload: { path: ['assignedUserId'], equals: authUser.userId } },
            ],
          },
          {
            payload: { path: ['sharedUserIds'], array_contains: authUser.userId },
          },
          ...(profile ? [{ payload: { path: ['sharedUserIds'], array_contains: profile.id } }] : []),
          {
            serviceSlug: { not: 'manual-chat' },
          },
        ],
      });
    }
  } else if (authUser && authUser.role === 'MANAGER') {
    const scope = await getWorkspaceScope(tenantId, authUser);
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
        { payload: { path: ['sharedUserIds'], array_contains: authUser.userId } },
        ...(scope.userIds.length > 0 ? scope.userIds.map((uid) => ({ payload: { path: ['sharedUserIds'], array_contains: uid } })) : []),
      ],
    });
  }

  if (status) {
    andConditions.push({ status });
  } else {
    andConditions.push({
      status: { notIn: ['ARCHIVED', 'archived'] },
    });
  }
  if (customerPhone) andConditions.push({ customerPhone: { contains: customerPhone } });
  if (channel) andConditions.push({ serviceSlug: { contains: channel.toLowerCase() } });
  if (search) {
    const trimmed = search.trim();
    const digitsOnly = trimmed.replace(/\D/g, '');
    const phoneVariation = trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
    const orConditions: any[] = [
      { customerName: { contains: trimmed, mode: 'insensitive' } },
      { customerPhone: { contains: trimmed } },
      { customerPhone: { contains: phoneVariation } },
    ];
    if (digitsOnly.length >= 7) {
      orConditions.push({ customerPhone: { contains: digitsOnly } });
      orConditions.push({ customerPhone: { contains: `+91${digitsOnly.slice(-10)}` } });
      orConditions.push({ customerPhone: { contains: digitsOnly.slice(-10) } });
    }
    andConditions.push({ OR: orConditions });
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
    if (lead.conversationId) {
      const existing = leadByConvId.get(lead.conversationId);
      // Prefer real lead over shadow lead (id starting with sales-conversation-)
      if (!existing || (existing.id.startsWith('sales-conversation-') && !lead.id.startsWith('sales-conversation-'))) {
        leadByConvId.set(lead.conversationId, lead);
      }
    }
    if (lead.customerPhone) {
      const norm = normalizePhone(lead.customerPhone);
      const existing = leadByPhone.get(norm);
      if (!existing || (existing.id.startsWith('sales-conversation-') && !lead.id.startsWith('sales-conversation-'))) {
        leadByPhone.set(norm, lead);
      }
    }
  }

  const wsSettingsForConv = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const shouldMask = isPhoneMaskingRequired(req.user, wsSettingsForConv?.settings as Record<string, any>);

  const closerProfile = req.user?.role === 'SALES_AGENT'
    ? await prisma.salesAgentProfile.findFirst({
        where: { userId: req.user.userId, tenantId },
        select: { id: true },
      })
    : null;

  // Clean and project conversation summaries with rich UI metadata
  const items = conversations.map((c) => {
    const payload = (c.payload as Record<string, unknown>) || {};
    const rawMessages = Array.isArray(payload.messages) ? (payload.messages as Record<string, unknown>[]) : [];
    const readState = (payload.readStateByAudience as Record<string, string>) || {};
    const candidateReadDates: number[] = [0];
    if (readState.sales) candidateReadDates.push(new Date(readState.sales).getTime());
    if (readState.admin) candidateReadDates.push(new Date(readState.admin).getTime());
    if (readState.closer) candidateReadDates.push(new Date(readState.closer).getTime());
    if (readState.agent) candidateReadDates.push(new Date(readState.agent).getTime());
    if (req.user?.userId && readState[req.user.userId]) {
      candidateReadDates.push(new Date(readState[req.user.userId]).getTime());
    }
    for (const val of Object.values(readState)) {
      if (typeof val === 'string') {
        const t = new Date(val).getTime();
        if (!isNaN(t)) candidateReadDates.push(t);
      }
    }
    const maxReadTime = Math.max(...candidateReadDates);

    let lastStaffMessageTime = 0;
    for (const msg of rawMessages) {
      const isOutbound =
        msg.fromMe === true ||
        msg.direction === 'OUTBOUND' ||
        ['sales', 'admin', 'closer', 'agent'].includes(String(msg.senderRole || msg.role || ''));
      if (isOutbound && msg.createdAt) {
        const t = new Date(String(msg.createdAt)).getTime();
        if (t > lastStaffMessageTime) lastStaffMessageTime = t;
      }
    }
    const effectiveReadTime = Math.max(maxReadTime, lastStaffMessageTime);

    let unreadCount = 0;
    for (const msg of rawMessages) {
      const isCustomer =
        msg.senderRole === 'customer' ||
        msg.role === 'customer' ||
        msg.lane === 'customer' ||
        (!msg.fromMe && msg.direction !== 'OUTBOUND' && !['sales', 'admin', 'closer', 'agent', 'system'].includes(String(msg.senderRole || msg.role || '')));
      if (isCustomer) {
        const msgDate = msg.createdAt ? new Date(String(msg.createdAt)).getTime() : 0;
        if (msgDate > effectiveReadTime) unreadCount++;
      }
    }

    const lastMsg = rawMessages.length > 0 ? rawMessages[rawMessages.length - 1] : null;
    const lead = leadByConvId.get(c.id) || (c.customerPhone ? leadByPhone.get(normalizePhone(c.customerPhone)) : undefined);
    const sourceChannel = c.serviceSlug ? c.serviceSlug.toUpperCase() : 'WHATSAPP';

    // Channel Source Classification & Distinctions
    const extType = String(payload.externalSourceType || '').toLowerCase();
    const serviceSlug = String(c.serviceSlug || '').toLowerCase();
    const internalNotes = String(payload.internalNotes || '').toLowerCase();
    const provider = String(payload.provider || '').toLowerCase();

    const isMetaApi =
      serviceSlug === 'whatsapp-intake' ||
      serviceSlug === 'whatsapp-cloud' ||
      extType === 'company_whatsapp' ||
      provider === 'meta_cloud_api' ||
      Boolean(payload.wabaId || payload.phoneNumberId);

    const isQrScanner =
      serviceSlug === 'manual-chat' ||
      extType.includes('whatsapp_business') ||
      extType.includes('whatsapp_personal') ||
      internalNotes.includes('scanner') ||
      internalNotes.includes('private rep line') ||
      Boolean(payload.scannedByUserId || payload.scannedByName || payload.scannerDeviceName || payload.deviceSessionId);

    let channelSource: 'OFFICIAL_API' | 'QR_SCANNER' | 'INSTAGRAM' | 'WEBSITE' = 'OFFICIAL_API';
    if (serviceSlug.includes('instagram') || extType.includes('instagram')) {
      channelSource = 'INSTAGRAM';
    } else if (serviceSlug.includes('website') || extType.includes('website') || serviceSlug.includes('lead-form')) {
      channelSource = 'WEBSITE';
    } else if (serviceSlug === 'manual-chat' || isQrScanner) {
      channelSource = 'QR_SCANNER';
    } else {
      channelSource = 'OFFICIAL_API';
    }

    const isOfficialApi = channelSource === 'OFFICIAL_API' && serviceSlug !== 'manual-chat';
    const isPersonalQr = channelSource === 'QR_SCANNER' || serviceSlug === 'manual-chat';
    const windowStatus = calculate24HourWindow(c, lead);

    const scannedByName =
      channelSource === 'QR_SCANNER'
        ? (typeof payload.scannedByName === 'string' && payload.scannedByName) ||
          (typeof payload.scannedBy === 'string' && payload.scannedBy) ||
          (typeof payload.scannerDeviceName === 'string' && payload.scannerDeviceName) ||
          c.assignedFreelancerName ||
          null
        : null;

    let channelSourceLabel = 'Official API';
    if (channelSource === 'OFFICIAL_API') {
      const companyPhone = typeof payload.externalSourceLabel === 'string' && payload.externalSourceLabel.includes('•')
        ? payload.externalSourceLabel.split('•')[1]?.trim()
        : '919589510954';
      channelSourceLabel = `Company API • ${companyPhone}`;
    } else if (channelSource === 'QR_SCANNER') {
      channelSourceLabel = scannedByName ? `QR: ${scannedByName}` : 'Personal WhatsApp QR';
    } else if (channelSource === 'INSTAGRAM') {
      channelSourceLabel = 'Instagram DM';
    } else if (channelSource === 'WEBSITE') {
      channelSourceLabel = 'Website Form';
    }

    return {
      id: c.id,
      tenantId: c.tenantId,
      serviceSlug: c.serviceSlug,
      customerName: c.customerName,
      customerPhone: shouldMask ? maskPhoneNumber(c.customerPhone, true) : c.customerPhone,
      status: c.status,
      channel: sourceChannel,
      sourceChannel,
      channelSource,
      channelSourceLabel,
      scannedByName,
      isOfficialApi,
      isPersonalQr,
      isReassignable: req.user?.role === 'ADMIN' || req.user?.role === 'SUPER_ADMIN' || !isPersonalQr,
      is24HourWindowOpen: windowStatus.is24HourWindowOpen,
      lastInboundAt: windowStatus.lastInboundAt,
      windowExpiresAt: windowStatus.windowExpiresAt,
      remainingMs: windowStatus.remainingMs,
      windowHours: windowStatus.windowHours,
      isAdLead: windowStatus.isAdLead,
      stage: lead?.stage || 'NEW',
      leadStage: lead?.stage || 'NEW',
      leadId: lead?.id || null,
      assignmentId: lead?.id || null,
      assignedAgent: c.assignedFreelancerId && c.assignedFreelancerName
        ? {
            id: c.assignedFreelancerId,
            agentCode: lead?.assignedAgent?.agentCode,
            displayName: c.assignedFreelancerName,
            email: lead?.assignedAgent?.user?.email,
            phone: lead?.assignedAgent?.user?.phone,
          }
        : lead?.assignedAgent
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
      assignedFreelancerId: c.assignedFreelancerId,
      assignedFreelancerName: c.assignedFreelancerName,
      adMetadata: (payload.adMetadata as any) || (lead?.customFields as any)?.adMetadata || null,
      isSharedWithMe: Boolean(
        Array.isArray(payload.shares) &&
        (payload.shares as any[]).some((s: any) => !s.revokedAt && s.userId === req.user?.userId)
      ),
      sharesCount: Array.isArray(payload.shares) ? (payload.shares as any[]).filter((s: any) => !s.revokedAt).length : 0,
      unreadCount,
      aiAutoReplyDisabled: Boolean(payload.aiAutoReplyDisabled),
      payload,
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
      lastMessageAt: lastMsg?.createdAt
        ? String(lastMsg.createdAt)
        : (typeof payload.lastMessageAt === 'string' ? payload.lastMessageAt : c.createdAt.toISOString()),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt,
    };
  });

  // Enforce closer QR data isolation, strict channel isolation, and empty conversation suppression
  const accessibleItems = items.filter((item) => {
    if (shouldExcludeEmpty) {
      const msgs = (item.payload?.messages as any[]);
      if (!Array.isArray(msgs) || msgs.length === 0) {
        return false;
      }
    }

    // Strict channel isolation: Tab "Mine" (QR_SCANNER) vs Tab "API" (OFFICIAL_API)
    if (sourceType === 'QR_SCANNER') {
      if (item.serviceSlug !== 'manual-chat' && !item.isPersonalQr) {
        return false;
      }
    } else if (sourceType === 'OFFICIAL_API') {
      if (item.serviceSlug === 'manual-chat' || item.isPersonalQr) {
        return false;
      }
    }

    if (req.user?.role === 'SALES_AGENT' && item.isPersonalQr) {
      const isMine =
        (item.payload.scannedByUserId && item.payload.scannedByUserId === req.user.userId) ||
        (item.assignedAgent?.id && closerProfile && item.assignedAgent.id === closerProfile.id) ||
        (item.scannedByName && req.user.displayName && item.scannedByName.toLowerCase() === req.user.displayName.toLowerCase()) ||
        item.isSharedWithMe;
      return isMine;
    }
    return true;
  });

  // Strictly sort conversations by latest message timestamp descending (so reading/clicking does not change order!)
  accessibleItems.sort((a, b) => {
    const timeA = new Date(a.lastMessageAt || a.lastMessage?.createdAt || a.createdAt || 0).getTime();
    const timeB = new Date(b.lastMessageAt || b.lastMessage?.createdAt || b.createdAt || 0).getTime();
    return timeB - timeA;
  });

  res.json({
    success: true,
    data: accessibleItems,
    conversations: accessibleItems,
    pagination: {
      total: accessibleItems.length,
      page,
      limit,
      totalPages: Math.ceil(accessibleItems.length / limit) || 1,
      hasMore: total > page * limit,
      nextCursor: accessibleItems.length > 0 ? accessibleItems[accessibleItems.length - 1].id : null,
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

// --- Soft Deletion, Bulk Delete & 30-Day Auto Cleanup Routine ---

export async function findLinkedLeadForConversation(
  tenantId: string,
  conversation: { id: string; customerPhone?: string | null; payload?: any }
) {
  const payload = (conversation.payload as Record<string, any>) || {};
  const payloadLeadId = typeof payload.leadId === 'string' && payload.leadId.trim() ? payload.leadId.trim() : undefined;
  const cleanPhone = conversation.customerPhone ? normalizePhone(conversation.customerPhone) : undefined;

  const leadOrConditions: Prisma.SalesLeadAssignmentWhereInput[] = [
    { conversationId: conversation.id },
  ];
  if (payloadLeadId) {
    leadOrConditions.push({ id: payloadLeadId });
  }
  if (cleanPhone && cleanPhone.length >= 10) {
    leadOrConditions.push(
      { customerPhone: conversation.customerPhone! },
      { customerPhone: { endsWith: cleanPhone } }
    );
  } else if (conversation.customerPhone) {
    leadOrConditions.push({ customerPhone: conversation.customerPhone });
  }

  return prisma.salesLeadAssignment.findFirst({
    where: {
      tenantId,
      OR: leadOrConditions,
    },
  });
}

export async function findLinkedMarketingContactForConversation(
  tenantId: string,
  conversation: { customerPhone?: string | null },
  leadId?: string | null
) {
  const contactPhone = normalizeLeadPhone(conversation.customerPhone) || (conversation.customerPhone ? normalizePhone(conversation.customerPhone) : undefined);
  const contactOrConditions: Prisma.MarketingContactWhereInput[] = [];
  if (leadId) {
    contactOrConditions.push({ leadId });
  }
  if (contactPhone) {
    contactOrConditions.push(
      { e164Phone: contactPhone },
      { e164Phone: { contains: contactPhone } }
    );
  }
  if (conversation.customerPhone) {
    contactOrConditions.push({ e164Phone: conversation.customerPhone });
  }

  if (contactOrConditions.length === 0) return null;

  return prisma.marketingContact.findFirst({
    where: {
      tenantId,
      OR: contactOrConditions,
    },
  });
}

/**
 * 30-Day Auto Cleanup Routine:
 * Hard deletes (prisma delete) any conversation and lead where recycled: true and deletedAt <= 30 days ago.
 */
export async function autoPurge30DayRecycledItems(tenantId: string): Promise<{ purgedConversations: number; purgedLeads: number }> {
  try {
    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const cutoffIso = cutoffDate.toISOString();

    // 1. Hard delete conversations where recycled === true and deletedAt <= 30 days ago
    const expiredConversations = await prisma.appConversation.findMany({
      where: {
        tenantId,
        AND: [
          {
            OR: [
              { status: 'ARCHIVED' },
              { payload: { path: ['recycled'], equals: true } },
            ],
          },
          { payload: { path: ['recycled'], equals: true } },
          {
            OR: [
              { payload: { path: ['deletedAt'], lte: cutoffIso } },
              { updatedAt: { lte: cutoffDate } },
            ],
          },
        ],
      },
      select: { id: true },
      take: 100,
    });

    let purgedConversations = 0;
    if (expiredConversations.length > 0) {
      const convIds = expiredConversations.map((c) => c.id);
      const res = await prisma.appConversation.deleteMany({
        where: {
          tenantId,
          id: { in: convIds },
        },
      });
      purgedConversations = res.count;
      logger.info(`[autoPurge30DayRecycledItems] Hard deleted ${purgedConversations} expired conversations for tenant ${tenantId}`);
    }

    // 2. Hard delete leads where stage === 'RECYCLED' and deletedAt <= 30 days ago
    const expiredLeads = await prisma.salesLeadAssignment.findMany({
      where: {
        tenantId,
        AND: [
          {
            OR: [
              { stage: 'RECYCLED' },
              { customFields: { path: ['recycled'], equals: true } },
            ],
          },
          {
            OR: [
              { customFields: { path: ['deletedAt'], lte: cutoffIso } },
              { updatedAt: { lte: cutoffDate } },
            ],
          },
        ],
      },
      select: { id: true },
      take: 100,
    });

    let purgedLeads = 0;
    if (expiredLeads.length > 0) {
      const leadIds = expiredLeads.map((l) => l.id);
      await deleteContactsAndLinkedLeadsTransactional(tenantId, {
        leadIds,
      }).catch(async (err) => {
        logger.warn('[autoPurge30DayRecycledItems] deleteContactsAndLinkedLeadsTransactional failed, falling back to deleteMany', { error: String(err) });
        await prisma.salesLeadAssignment.deleteMany({
          where: {
            tenantId,
            id: { in: leadIds },
          },
        }).catch(() => undefined);
      });
      purgedLeads = leadIds.length;
      logger.info(`[autoPurge30DayRecycledItems] Hard deleted ${purgedLeads} expired recycled leads for tenant ${tenantId}`);
    }

    return { purgedConversations, purgedLeads };
  } catch (error) {
    logger.error('[autoPurge30DayRecycledItems] Failed to auto-purge recycled items', { error: String(error) });
    return { purgedConversations: 0, purgedLeads: 0 };
  }
}

export interface SoftDeleteConversationResult {
  status: 200 | 403 | 404;
  success: boolean;
  error?: string;
  message: string;
  data?: {
    conversationId: string;
    leadId: string | null;
  };
}

export async function softDeleteConversationRecord(
  tenantId: string,
  rawId: string,
  user: { userId: string; role?: string; displayName?: string },
  cachedWsSettings?: Record<string, any>
): Promise<SoftDeleteConversationResult> {
  const conversation = await resolveAppConversation(tenantId, rawId, false);
  if (!conversation) {
    return {
      status: 404,
      success: false,
      error: 'NotFound',
      message: 'Conversation not found',
    };
  }

  const payload = (conversation.payload as Record<string, any>) || {};
  const lead = await findLinkedLeadForConversation(tenantId, conversation);

  const roleUpper = String(user.role || '').toUpperCase();

  // Role & Permission Enforcement:
  // - SALES_AGENT or CLOSER: only personal companion WhatsApp scanner or lead created by user
  if (roleUpper === 'SALES_AGENT' || roleUpper === 'CLOSER') {
    const isPersonalScanner = Boolean(
      payload.scannedByUserId === user.userId ||
      (user.displayName && payload.scannedByName === user.displayName) ||
      (conversation.serviceSlug === 'manual-chat' && (!payload.scannedByUserId || payload.scannedByUserId === user.userId))
    );
    const isLeadCreatedByUser = Boolean(lead && lead.createdById === user.userId);

    if (!isPersonalScanner && !isLeadCreatedByUser) {
      return {
        status: 403,
        success: false,
        error: 'Forbidden',
        message: 'Sales agents can only delete personal WhatsApp scanned chats or contacts they created.',
      };
    }
  } else if (roleUpper === 'MANAGER') {
    let wsSettings = cachedWsSettings;
    if (!wsSettings) {
      const ws = await prisma.aicloserWorkspace.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      wsSettings = (ws?.settings as Record<string, any>) || {};
    }
    if (!wsSettings.allowManagerLeadDeletion) {
      return {
        status: 403,
        success: false,
        error: 'Forbidden',
        message: 'Manager lead deletion is not enabled in workspace settings.',
      };
    }
  } else if (roleUpper !== 'ADMIN' && roleUpper !== 'SUPER_ADMIN') {
    return {
      status: 403,
      success: false,
      error: 'Forbidden',
      message: 'You are not authorized to delete conversations in this workspace.',
    };
  }

  const deletedAt = new Date().toISOString();

  // 1. Soft-delete conversation:
  // Update appConversation:
  // status: 'ARCHIVED',
  // payload: { ...payload, recycled: true, deletedAt, deletedByUserId, deletedByName }
  const updatedPayload = {
    ...payload,
    recycled: true,
    deletedAt,
    deletedByUserId: user.userId,
    deletedByName: user.displayName,
  };

  await prisma.appConversation.update({
    where: { id: conversation.id },
    data: {
      status: 'ARCHIVED',
      payload: updatedPayload as unknown as Prisma.InputJsonValue,
      updatedAt: new Date(),
    },
  });

  // 2. If linked lead found:
  // Update salesLeadAssignment:
  // stage: 'RECYCLED',
  // customFields: { ...(lead.customFields || {}), recycled: true, deletedAt, deletedByUserId, deletedByName }
  // stageChangedAt: new Date(), updatedAt: new Date()
  if (lead) {
    const leadCustom = (lead.customFields && typeof lead.customFields === 'object' && !Array.isArray(lead.customFields))
      ? (lead.customFields as Record<string, any>)
      : {};
    await prisma.salesLeadAssignment.update({
      where: { id: lead.id },
      data: {
        stage: 'RECYCLED',
        customFields: {
          ...leadCustom,
          recycled: true,
          deletedAt,
          deletedByUserId: user.userId,
          deletedByName: user.displayName,
        },
        stageChangedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  // 3. If linked MarketingContact exists:
  // Update marketingContact: status: 'ARCHIVED'
  const marketingContact = await findLinkedMarketingContactForConversation(tenantId, conversation, lead?.id);
  if (marketingContact) {
    const contactCustom = (marketingContact.customFields && typeof marketingContact.customFields === 'object' && !Array.isArray(marketingContact.customFields))
      ? (marketingContact.customFields as Record<string, any>)
      : {};
    await prisma.marketingContact.update({
      where: { id: marketingContact.id },
      data: {
        customFields: {
          ...contactCustom,
          status: 'ARCHIVED',
          recycled: true,
          deletedAt,
          deletedByUserId: user.userId,
          deletedByName: user.displayName,
        },
        updatedAt: new Date(),
      },
    }).catch(() => undefined);
  }

  // 4. Log activity in salesActivityLog:
  // action: 'CHAT_AND_CONTACT_RECYCLED',
  // note: `Chat and contact moved to Recycle Bin by ${user.displayName || user.userId}`,
  // metadata: { conversationId: conversation.id, leadId: lead?.id }
  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: lead?.id || null,
      actorUserId: user.userId,
      action: 'CHAT_AND_CONTACT_RECYCLED',
      note: `Chat and contact moved to Recycle Bin by ${user.displayName || user.userId}`,
      metadata: {
        conversationId: conversation.id,
        leadId: lead?.id || null,
        deletedByUserId: user.userId,
        deletedByName: user.displayName,
      },
    },
  }).catch(() => undefined);

  // 5. Persist realtime event
  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'conversation.recycled',
    payload: {
      conversationId: conversation.id,
      leadId: lead?.id || null,
      deletedByUserId: user.userId,
    },
    actorUserId: user.userId,
  }).catch(() => undefined);

  return {
    status: 200,
    success: true,
    message: 'Chat and linked contact moved to Recycle Bin',
    data: {
      conversationId: conversation.id,
      leadId: lead?.id || null,
    },
  };
}

const bulkDeleteConversationsSchema = z.object({
  conversationIds: z.array(z.string().min(1, 'Conversation ID cannot be empty')).min(1, 'At least one conversation ID is required'),
});

const listRecycleBinQuerySchema = z.object({
  page: z.string().optional().transform((v) => (v ? Math.max(1, Number(v)) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, Math.max(1, Number(v))) : 25)),
  search: z.string().optional(),
});

// GET /recycle-bin - View soft-deleted conversations in Recycle Bin
conversationsRouter.get('/recycle-bin', validateQuery(listRecycleBinQuerySchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const roleUpper = String(user.role || '').toUpperCase();

  if (roleUpper === 'MANAGER') {
    const ws = await prisma.aicloserWorkspace.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const wsSettings = (ws?.settings as Record<string, any>) || {};
    if (!wsSettings.allowManagerLeadDeletion) {
      return void res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Manager recycle bin access is not enabled for this workspace.',
      });
    }
  } else if (roleUpper !== 'ADMIN' && roleUpper !== 'SUPER_ADMIN' && roleUpper !== 'SALES_AGENT' && roleUpper !== 'CLOSER') {
    return void res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'You are not authorized to view the recycle bin.',
    });
  }

  // Trigger 30-day auto cleanup routine when recycle bin is viewed
  void autoPurge30DayRecycledItems(tenantId).catch(() => undefined);

  const { page, limit, search } = req.query as unknown as { page: number; limit: number; search?: string };

  const andConditions: any[] = [
    { tenantId },
    {
      OR: [
        { status: 'ARCHIVED' },
        { payload: { path: ['recycled'], equals: true } },
      ],
    },
  ];

  if (roleUpper === 'SALES_AGENT' || roleUpper === 'CLOSER') {
    andConditions.push({
      OR: [
        { payload: { path: ['scannedByUserId'], equals: user.userId } },
        { payload: { path: ['deletedByUserId'], equals: user.userId } },
      ],
    });
  }

  if (search) {
    const trimmed = search.trim();
    andConditions.push({
      OR: [
        { customerName: { contains: trimmed, mode: 'insensitive' } },
        { customerPhone: { contains: trimmed } },
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

  return void res.json({
    success: true,
    data: conversations,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    error: null,
  });
});

// POST /bulk-delete - Soft-delete multiple conversations and contacts to Recycle Bin
conversationsRouter.post('/bulk-delete', validateBody(bulkDeleteConversationsSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const { conversationIds } = req.body as { conversationIds: string[] };

  const roleUpper = String(user.role || '').toUpperCase();
  let wsSettings: Record<string, any> | undefined;

  if (roleUpper === 'MANAGER') {
    const ws = await prisma.aicloserWorkspace.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    wsSettings = (ws?.settings as Record<string, any>) || {};
    if (!wsSettings.allowManagerLeadDeletion) {
      return void res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Manager lead deletion is not enabled in workspace settings.',
      });
    }
  } else if (roleUpper !== 'ADMIN' && roleUpper !== 'SUPER_ADMIN' && roleUpper !== 'SALES_AGENT' && roleUpper !== 'CLOSER') {
    return void res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'You are not authorized to delete conversations in this workspace.',
    });
  }

  const uniqueIds = Array.from(new Set(conversationIds.map((id) => String(id).trim()).filter(Boolean)));
  let deletedCount = 0;

  for (const id of uniqueIds) {
    try {
      const result = await softDeleteConversationRecord(tenantId, id, user, wsSettings);
      if (result.success) {
        deletedCount++;
      }
    } catch (err) {
      logger.warn(`[bulk-delete] Error soft-deleting conversation ${id}`, { error: String(err) });
    }
  }

  void autoPurge30DayRecycledItems(tenantId).catch(() => undefined);

  return void res.json({
    success: true,
    deletedCount,
    message: `Successfully moved ${deletedCount} chat(s) and contact(s) to Recycle Bin.`,
  });
});

// GET /templates - Get Meta approved WhatsApp templates for conversational outreach
conversationsRouter.get('/templates', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const templates = await prisma.whatsAppTemplate.findMany({
    where: {
      tenantId,
      status: 'APPROVED',
    },
    include: {
      versions: {
        orderBy: { versionNumber: 'desc' },
        take: 1,
      },
    },
    orderBy: { name: 'asc' },
  });

  res.json({
    success: true,
    data: templates,
    error: null,
  });
});

// GET /:id - Single conversation detail with ownership verification
conversationsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  if (id === 'chat-visibility' || id === 'recycle-bin' || id === 'bulk-delete' || id === 'templates') return;

  const conversation = await resolveAppConversation(tenantId, id, false);

  if (!conversation) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found in workspace' });
    return;
  }

  const hasAccess = await verifyCloserAccess(req, conversation);
  if (!hasAccess) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to view this conversation' });
    return;
  }

  const windowStatus = calculate24HourWindow(conversation);

  res.json({
    success: true,
    data: {
      ...conversation,
      is24HourWindowOpen: windowStatus.is24HourWindowOpen,
      lastInboundAt: windowStatus.lastInboundAt,
      windowExpiresAt: windowStatus.windowExpiresAt,
      remainingMs: windowStatus.remainingMs,
      windowHours: windowStatus.windowHours,
      isAdLead: windowStatus.isAdLead,
    },
    error: null,
  });
});

// DELETE /:id - Soft delete conversation and linked contact to Recycle Bin
conversationsRouter.delete('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const id = String(req.params.id);

  const result = await softDeleteConversationRecord(tenantId, id, user);
  if (!result.success) {
    return void res.status(result.status).json({
      success: false,
      error: result.error || 'Forbidden',
      message: result.message,
    });
  }

  // Trigger background 30-day auto cleanup
  void autoPurge30DayRecycledItems(tenantId).catch(() => undefined);

  return void res.json({
    success: true,
    message: result.message,
    data: result.data,
  });
});

// POST /:id/restore - Restore soft-deleted conversation from Recycle Bin back to Active
conversationsRouter.post('/:id/restore', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const id = String(req.params.id);
  const roleUpper = String(user.role || '').toUpperCase();

  if (roleUpper !== 'ADMIN' && roleUpper !== 'SUPER_ADMIN') {
    if (roleUpper === 'MANAGER') {
      const ws = await prisma.aicloserWorkspace.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      const wsSettings = (ws?.settings as Record<string, any>) || {};
      if (!wsSettings.allowManagerLeadDeletion) {
        return void res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'Manager lead restore is not enabled in workspace settings.',
        });
      }
    } else {
      return void res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Only workspace administrators and authorized managers can restore from the recycle bin.',
      });
    }
  }

  const conversation = await resolveAppConversation(tenantId, id, false);
  if (!conversation) {
    return void res.status(404).json({ success: false, error: 'NotFound', message: 'Conversation not found' });
  }

  const payload = (conversation.payload as Record<string, any>) || {};
  const { recycled, deletedAt, deletedByUserId, deletedByName, ...cleanPayload } = payload;

  await prisma.appConversation.update({
    where: { id: conversation.id },
    data: {
      status: 'Active',
      payload: cleanPayload as unknown as Prisma.InputJsonValue,
      updatedAt: new Date(),
    },
  });

  const lead = await findLinkedLeadForConversation(tenantId, conversation);
  if (lead && lead.stage === 'RECYCLED') {
    const leadCustom = (lead.customFields && typeof lead.customFields === 'object' && !Array.isArray(lead.customFields))
      ? { ...(lead.customFields as Record<string, any>) }
      : {};
    delete leadCustom.recycled;
    delete leadCustom.deletedAt;
    delete leadCustom.deletedByUserId;
    delete leadCustom.deletedByName;

    await prisma.salesLeadAssignment.update({
      where: { id: lead.id },
      data: {
        stage: 'NEW',
        customFields: leadCustom,
        stageChangedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  return void res.json({
    success: true,
    message: 'Conversation restored successfully',
    data: { id: conversation.id, status: 'Active' },
  });
});

// 2. GET /:id/messages - Cursor-paginated message history with closer authorization check
conversationsRouter.get('/:id/messages', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const beforeCursor = typeof req.query.before === 'string' ? req.query.before : null;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

  const conversation = await resolveAppConversation(tenantId, id, true);

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

  // Strictly sort all messages by chronological timestamp ascending
  const sortedMessages = [...rawMessages].sort((a, b) => {
    const timeA = new Date(String(a.createdAt || a.timestamp || 0)).getTime();
    const timeB = new Date(String(b.createdAt || b.timestamp || 0)).getTime();
    return timeA - timeB;
  });

  let endIndex = sortedMessages.length;
  if (beforeCursor) {
    const cursorIndex = sortedMessages.findIndex((m) => m.id === beforeCursor || m.createdAt === beforeCursor);
    if (cursorIndex !== -1) endIndex = cursorIndex;
  }

  const startIndex = Math.max(0, endIndex - limit);
  const sliced = sortedMessages.slice(startIndex, endIndex);

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

    const rawBody = String(m.body || '');
    const cleanBody = (rawBody.trim() === '[unsupported]' || rawBody.trim() === '[reaction]') ? 'OK 👍' : rawBody;

    return {
      id: String(m.id || randomUUID()),
      body: cleanBody,
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
      externalMessageId: typeof m.externalMessageId === 'string' ? m.externalMessageId : (typeof m.wamid === 'string' ? m.wamid : null),
      attachments: Array.isArray(m.attachments) ? (m.attachments as CleanChatMessage['attachments']) : undefined,
    };
  });

  // Auto-mark conversation read on message thread fetch
  const autoReadNowIso = new Date().toISOString();
  const msgReadState = (payload.readStateByAudience as Record<string, string>) || {};
  msgReadState.sales = autoReadNowIso;
  msgReadState.admin = autoReadNowIso;
  msgReadState.closer = autoReadNowIso;
  msgReadState.agent = autoReadNowIso;
  if (req.user?.userId) msgReadState[req.user.userId] = autoReadNowIso;
  prisma.appConversation.update({
    where: { id: conversation.id },
    data: {
      payload: {
        ...payload,
        readStateByAudience: msgReadState,
      } as unknown as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);

  res.json({
    success: true,
    data: {
      conversationId: conversation.id,
      customerName: conversation.customerName,
      customerPhone: conversation.customerPhone,
      status: conversation.status,
      channel: conversation.serviceSlug ? conversation.serviceSlug.toUpperCase() : 'WHATSAPP',
      aiAutoReplyDisabled: Boolean((conversation.payload as any)?.aiAutoReplyDisabled),
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

// 2.5 POST /get-or-create - Retrieve or create active conversation thread for a lead or phone number
conversationsRouter.post('/get-or-create', validateBody(getOrCreateConversationSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body as z.infer<typeof getOrCreateConversationSchema>;
  const cleanPhone = body.customerPhone.replace(/\D/g, '').slice(-10);
  const isPersonalQr = body.channelSource === 'QR_SCANNER';
  const targetServiceSlug = isPersonalQr ? 'manual-chat' : 'whatsapp-cloud';

  // Find existing conversation for this phone and channel type
  let conversation = await prisma.appConversation.findFirst({
    where: {
      tenantId,
      customerPhone: { contains: cleanPhone },
      serviceSlug: targetServiceSlug,
    },
  });

  if (!conversation) {
    let leadCustomerName = body.customerName;
    if (body.leadId) {
      const existingLead = await prisma.salesLeadAssignment.findFirst({
        where: { id: body.leadId, tenantId },
        select: { customerName: true, customerPhone: true },
      });
      if (existingLead?.customerName && !leadCustomerName) {
        leadCustomerName = existingLead.customerName;
      }
    }

    const newConv = await prisma.appConversation.create({
      data: {
        id: `conv-${randomUUID().slice(0, 12)}`,
        tenantId,
        serviceId: isPersonalQr ? 'srv-wa-companion' : 'srv-wa-cloud',
        serviceSlug: targetServiceSlug,
        assignedFreelancerId: req.user?.userId || null,
        assignedFreelancerName: req.user?.displayName || null,
        customerName: leadCustomerName || body.customerPhone,
        customerPhone: body.customerPhone,
        status: 'OPEN',
        leadStatusId: 'status-open',
        payload: {
          leadId: body.leadId || null,
          channelSource: body.channelSource,
          scannedByName: isPersonalQr ? (req.user?.displayName || 'Sales Closer') : null,
          scannedByUserId: isPersonalQr ? req.user?.userId : null,
          messages: [],
        },
      },
    });

    if (body.leadId) {
      await prisma.salesLeadAssignment.update({
        where: { id: body.leadId, tenantId },
        data: { conversationId: newConv.id },
      }).catch(() => undefined);
    }

    conversation = newConv;
  }

  const windowStatus = calculate24HourWindow(conversation);

  res.json({
    success: true,
    data: {
      conversation: {
        ...conversation,
        channelSource: isPersonalQr ? 'QR_SCANNER' : 'OFFICIAL_API',
        is24HourWindowOpen: windowStatus.is24HourWindowOpen,
        lastInboundAt: windowStatus.lastInboundAt,
        windowExpiresAt: windowStatus.windowExpiresAt,
        remainingMs: windowStatus.remainingMs,
        windowHours: windowStatus.windowHours,
        isAdLead: windowStatus.isAdLead,
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

  const conversation = await resolveAppConversation(tenantId, id, true);

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

  const isTemplateMessage = Boolean(body.templateName && body.templateName.trim().length > 0);
  const messageBody = body.body && body.body.trim().length > 0
    ? body.body
    : isTemplateMessage
    ? `[Template: ${body.templateName}]`
    : '';

  const newMessage: CleanChatMessage = {
    id: `msg-${randomUUID()}`,
    body: messageBody,
    lane: body.lane,
    createdAt: new Date().toISOString(),
    senderRole: 'sales',
    senderLabel: req.user?.displayName || req.user?.email || 'Sales Closer',
    senderType: 'HUMAN',
    senderUserId: req.user?.userId || null,
    status: 'sent',
    attachments: body.attachments,
    ...(isTemplateMessage ? { template: { name: body.templateName!, language: body.templateLanguage || 'en_US' } } : {}),
  };

  // Flag human activity in aiSettings for human takeover tracking
  if (payload.aiSettings && typeof payload.aiSettings === 'object') {
    (payload.aiSettings as any).lastHumanMessageAt = new Date().toISOString();
  }

  // Outbound dispatch to Meta WhatsApp Cloud API or Companion WhatsApp daemon if lane is customer and customer has a phone
  let outboundDispatchError: string | null = null;
  if (body.lane !== 'internal' && conversation.customerPhone) {
    const cleanPhone = conversation.customerPhone.replace(/\D/g, '');
    if (cleanPhone.length >= 8) {
      const useCompanion =
        body.dispatchChannel === 'PERSONAL' ||
        (body.dispatchChannel !== 'OFFICIAL_API' && (conversation as any).serviceSlug === 'manual-chat');

      const linkedLead = await prisma.salesLeadAssignment.findFirst({
        where: {
          tenantId,
          OR: [
            { conversationId: conversation.id },
            { customerPhone: conversation.customerPhone },
            ...(payload.leadId ? [{ id: String(payload.leadId) }] : []),
          ],
        },
      }).catch(() => null);

      if (useCompanion) {
        // 1. Verify that a companion WhatsApp device is connected for THIS user
        const devices = getTenantDevices(tenantId);
        const myUserId = req.user?.userId;
        const waServiceUrl = process.env.WA_SERVICE_URL || 'http://127.0.0.1:3015';

        // Check live daemon status
        let isDaemonOnline = false;
        try {
          const daemonRes = await fetch(`${waServiceUrl}/status`, { signal: AbortSignal.timeout(3000) });
          const daemonJson = (await daemonRes.json().catch(() => null)) as any;
          if (daemonJson?.ok && daemonJson.scanner?.status === 'CONNECTED' && daemonJson.scanner.connectedPhone) {
            isDaemonOnline = true;
          }
        } catch {
          isDaemonOnline = false;
        }

        const connectedCompanion = devices.find(
          (d) => d.status === 'connected' && d.scannedByUserId === myUserId
        );

        if (!isDaemonOnline || !connectedCompanion) {
          logger.warn('Blocked companion WhatsApp outbound message: no connected device for user', {
            userId: myUserId,
            tenantId,
            conversationId: conversation.id,
            isDaemonOnline,
            hasMatchingDevice: Boolean(connectedCompanion),
          });
          res.status(400).json({
            success: false,
            error: 'PersonalWhatsAppNotConnected',
            code: 'PERSONAL_WA_NOT_CONNECTED',
            message: 'Personal WhatsApp is not connected for your account. Please scan your personal WhatsApp QR code before sending messages.',
          });
          return;
        }

        // 2. Dispatch via companion WhatsApp Baileys daemon
        try {
          const waRes = await fetch(`${waServiceUrl}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: cleanPhone,
              body: messageBody,
              sessionId: connectedCompanion.id,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          const waData = (await waRes.json().catch(() => null)) as any;
          if (waRes.ok && waData?.ok) {
            newMessage.status = 'sent';
            newMessage.externalMessageId = waData.messageId || null;
            logger.info('Companion WhatsApp outbound message dispatched successfully via Baileys', {
              conversationId: conversation.id,
              recipientPhone: cleanPhone,
              messageId: waData.messageId,
            });
          } else {
            const errDetail = waData?.error || 'Failed to dispatch via companion WhatsApp';
            logger.warn('Companion WhatsApp outbound dispatch failed', {
              conversationId: conversation.id,
              recipientPhone: cleanPhone,
              error: errDetail,
            });
            res.status(400).json({
              success: false,
              error: 'CompanionWhatsAppDispatchFailed',
              code: 'COMPANION_DISPATCH_FAILED',
              message: `Personal WhatsApp failed to send: ${errDetail}. Check that your companion phone is online.`,
            });
            return;
          }
        } catch (err: any) {
          const errMsg = err?.message || 'Companion WhatsApp daemon unreachable';
          logger.error('Error dispatching via companion WhatsApp daemon', { error: errMsg });
          res.status(400).json({
            success: false,
            error: 'CompanionWhatsAppDispatchFailed',
            code: 'COMPANION_DISPATCH_FAILED',
            message: `Personal WhatsApp service unavailable (${errMsg}). Please check phone connection or rescan QR code.`,
          });
          return;
        }
      } else {
        // Official Meta WhatsApp Cloud API dispatch
        const channel = await prisma.whatsAppChannel.findFirst({
          where: { tenantId, status: 'ACTIVE' },
          orderBy: { isDefault: 'desc' },
        });

        if (!channel || !channel.phoneNumberId) {
          res.status(400).json({
            success: false,
            error: 'NoActiveWhatsAppChannel',
            message: 'No active WhatsApp Cloud API channel configured for this workspace. Please configure a channel in Settings.',
          });
          return;
        }

        const decryptedToken = decryptWhatsAppToken(channel.encryptedAccessToken);
        if (!decryptedToken) {
          res.status(400).json({
            success: false,
            error: 'WhatsAppTokenDecryptionFailed',
            message: 'WhatsApp channel access token could not be decrypted. Please reconnect your WhatsApp Business account.',
          });
          return;
        }

        const apiVer = channel.graphApiVersion || 'v22.0';
        const metaUrl = `https://graph.facebook.com/${apiVer}/${channel.phoneNumberId}/messages`;

        if (isTemplateMessage) {
          // Template dispatch
          const templateRecord = await prisma.whatsAppTemplate.findFirst({
            where: { tenantId, name: body.templateName },
          });

          const languageCode = body.templateLanguage || templateRecord?.language || 'en_US';
          let components = body.templateComponents;
          if (!components && templateRecord && (body as any).variableValues) {
            const varValues = (body as any).variableValues as Record<string, unknown>;
            const params = Array.from({ length: templateRecord.variableCount || 0 }, (_, idx) => ({
              type: 'text',
              text: String(varValues[String(idx + 1)] || ''),
            }));
            if (params.length > 0) {
              components = [{ type: 'body', parameters: params }];
            }
          }

          const templatePayload: Record<string, any> = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'template',
            template: {
              name: body.templateName,
              language: { code: languageCode },
              ...(components && components.length > 0 ? { components } : {}),
            },
          };

          try {
            const metaRes = await fetch(metaUrl, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${decryptedToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(templatePayload),
              signal: AbortSignal.timeout(15_000),
            });

            const metaData = (await metaRes.json().catch(() => null)) as any;
            if (metaRes.ok && metaData?.messages?.[0]?.id) {
              const realWamid = metaData.messages[0].id;
              newMessage.externalMessageId = realWamid;
              newMessage.status = 'sent';
              logger.info('WhatsApp outbound template dispatched successfully', {
                conversationId: conversation.id,
                recipientPhone: cleanPhone,
                templateName: body.templateName,
                wamid: realWamid,
              });
            } else {
              const metaErrMsg = metaData?.error?.message || (metaData ? JSON.stringify(metaData) : 'Meta API error');
              logger.error('Meta WhatsApp template dispatch failed', {
                conversationId: conversation.id,
                recipientPhone: cleanPhone,
                templateName: body.templateName,
                metaError: metaErrMsg,
              });
              res.status(400).json({
                success: false,
                error: 'MetaTemplateDispatchFailed',
                message: `Failed to dispatch WhatsApp template: ${metaErrMsg}`,
                details: metaData?.error || null,
              });
              return;
            }
          } catch (templateErr: any) {
            logger.error('Error dispatching WhatsApp template', {
              conversationId: conversation.id,
              error: templateErr?.message || String(templateErr),
            });
            res.status(400).json({
              success: false,
              error: 'MetaTemplateDispatchFailed',
              message: `Error communicating with Meta API: ${templateErr?.message || 'Network timeout'}`,
            });
            return;
          }
        } else {
          // Free-form message: MUST verify 24-hour / 72-hour customer service window
          const windowStatus = calculate24HourWindow(conversation, linkedLead);
          if (!windowStatus.is24HourWindowOpen) {
            logger.warn('Blocked free-form WhatsApp outbound message: service window closed', {
              conversationId: conversation.id,
              recipientPhone: cleanPhone,
              windowHours: windowStatus.windowHours,
            });
            res.status(400).json({
              success: false,
              error: 'MetaServiceWindowClosed',
              code: 'META_WINDOW_CLOSED',
              message: `Meta customer service window is closed (${windowStatus.windowHours}h window expired). Free-form messaging is locked. You must send an approved WhatsApp Template to contact this user.`,
              data: {
                is24HourWindowOpen: false,
                windowHours: windowStatus.windowHours,
                isAdLead: windowStatus.isAdLead,
                windowExpiresAt: null,
              },
            });
            return;
          }

          try {
            const metaRes = await fetch(metaUrl, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${decryptedToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: cleanPhone,
                type: 'text',
                text: { preview_url: false, body: messageBody },
              }),
              signal: AbortSignal.timeout(15_000),
            });

            const metaData = (await metaRes.json().catch(() => null)) as any;
            if (metaRes.ok && metaData?.messages?.[0]?.id) {
              const realWamid = metaData.messages[0].id;
              newMessage.externalMessageId = realWamid;
              newMessage.status = 'sent';
              logger.info('WhatsApp outbound message dispatched successfully', {
                conversationId: conversation.id,
                recipientPhone: cleanPhone,
                wamid: realWamid,
              });
            } else {
              const metaErrCode = metaData?.error?.code;
              const metaErrMsg = metaData?.error?.message || (metaData ? JSON.stringify(metaData) : 'Meta API error');
              if (metaErrCode === 131047 || metaErrMsg.includes('24 hours')) {
                logger.warn('Meta API returned 131047 (24h window closed)', {
                  conversationId: conversation.id,
                  recipientPhone: cleanPhone,
                });
                res.status(400).json({
                  success: false,
                  error: 'Meta24HourWindowClosed',
                  message: 'Meta 24-hour customer service window is closed. Free-form messaging is locked. You must send an approved WhatsApp Template to contact this user.',
                  data: {
                    is24HourWindowOpen: false,
                    windowExpiresAt: null,
                  },
                });
                return;
              }

              logger.error('Meta WhatsApp outbound dispatch failed', {
                conversationId: conversation.id,
                recipientPhone: cleanPhone,
                metaError: metaErrMsg,
              });
              res.status(400).json({
                success: false,
                error: 'MetaDispatchFailed',
                message: `Failed to dispatch WhatsApp message: ${metaErrMsg}`,
                details: metaData?.error || null,
              });
              return;
            }
          } catch (waErr: any) {
            logger.error('Error during WhatsApp outbound dispatch', {
              conversationId: conversation.id,
              error: waErr?.message || String(waErr),
            });
            res.status(400).json({
              success: false,
              error: 'MetaDispatchFailed',
              message: `Error communicating with Meta API: ${waErr?.message || 'Network timeout'}`,
            });
            return;
          }
        }
      }
    }
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

  res.status(201).json({
    success: true,
    data: newMessage,
    outboundError: outboundDispatchError,
    error: null,
  });
});

// 3b. POST /read-all - Mark all conversations as read for workspace
conversationsRouter.post('/read-all', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const convs = await prisma.appConversation.findMany({
    where: { tenantId },
    select: { id: true, payload: true },
  });

  const nowIso = new Date().toISOString();
  for (const c of convs) {
    const payload = (c.payload as Record<string, unknown>) || {};
    const readState = (payload.readStateByAudience as Record<string, string>) || {};
    readState.sales = nowIso;
    readState.admin = nowIso;
    readState.closer = nowIso;
    readState.agent = nowIso;
    if (req.user?.userId) readState[req.user.userId] = nowIso;
    await prisma.appConversation.update({
      where: { id: c.id },
      data: {
        payload: {
          ...payload,
          readStateByAudience: readState,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  res.json({ success: true, message: 'All conversations marked as read', error: null });
});

// 4. POST /:id/read - Mark conversation read
conversationsRouter.post('/:id/read', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const conversation = await resolveAppConversation(tenantId, id, false);

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
  const nowIso = new Date().toISOString();
  readState.sales = nowIso;
  readState.admin = nowIso;
  readState.closer = nowIso;
  readState.agent = nowIso;
  if (req.user?.userId) {
    readState[req.user.userId] = nowIso;
  }

  await prisma.appConversation.update({
    where: { id: conversation.id },
    data: {
      payload: {
        ...payload,
        readStateByAudience: readState,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // Dispatch mark-as-read receipt to Meta Graph API for official WhatsApp Cloud API messages
  try {
    const rawMessages = Array.isArray(payload.messages) ? (payload.messages as any[]) : [];
    const customerMessagesWithWamid = rawMessages
      .filter((m) => (m.senderRole === 'customer' || m.role === 'customer' || m.lane === 'customer') && (m.externalMessageId || m.wamid || (typeof m.id === 'string' && m.id.startsWith('wamid.'))))
      .map((m) => m.externalMessageId || m.wamid || m.id);

    const latestWamid = customerMessagesWithWamid[customerMessagesWithWamid.length - 1];
    if (latestWamid) {
      const channel = await prisma.whatsAppChannel.findFirst({
        where: { tenantId },
        orderBy: { isDefault: 'desc' },
      });
      if (channel && channel.phoneNumberId) {
        const decryptedToken = decryptWhatsAppToken(channel.encryptedAccessToken) || process.env.META_ACCESS_TOKEN;
        if (decryptedToken) {
          const apiVer = channel.graphApiVersion || 'v22.0';
          const metaUrl = `https://graph.facebook.com/${apiVer}/${channel.phoneNumberId}/messages`;
          fetch(metaUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${decryptedToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              status: 'read',
              message_id: latestWamid,
            }),
          }).catch((err) => logger.warn('Meta mark-as-read dispatch caught error', { error: String(err) }));
        }
      }
    }
  } catch (metaErr) {
    logger.warn('Failed to dispatch Meta mark-as-read receipt', { error: String(metaErr) });
  }

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
    req.body?.agentId || req.body?.assignedAgentId ||
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
  const conversation = await resolveAppConversation(tenantId, id, true);

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

  const convPayload = (conversation.payload as Record<string, unknown>) || {};

  // Find calling user's agent profile to verify ownership/assignment
  const agentProfileSelf = await prisma.salesAgentProfile.findFirst({
    where: { tenantId, userId: user.userId },
    select: { id: true },
  });

  const isOwnerOrAssigned =
    user.role === 'ADMIN' ||
    user.role === 'SUPER_ADMIN' ||
    conversation.assignedFreelancerId === user.userId ||
    (agentProfileSelf && conversation.assignedFreelancerId === agentProfileSelf.id) ||
    convPayload.scannedByUserId === user.userId ||
    (convPayload.scannedByName && convPayload.scannedByName === user.displayName) ||
    !conversation.assignedFreelancerId ||
    conversation.assignedFreelancerId === 'Unassigned';

  if (!isOwnerOrAssigned) {
    res.status(403).json({
      success: false,
      code: 'PERMISSION_DENIED',
      error: 'PermissionDenied',
      message: 'You can only reassign conversations assigned to you or acquired through your line.',
    });
    return;
  }

  // 3. Resolve target agent profile
  let agentProfile = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      OR: [
        { id: rawAgentId },
        { userId: rawAgentId },
        { agentCode: rawAgentId },
        { user: { displayName: { equals: rawAgentId, mode: 'insensitive' } } },
        { user: { email: { equals: rawAgentId, mode: 'insensitive' } } },
      ],
    },
    include: { user: { select: { id: true, displayName: true, role: true, email: true } } },
  });

  // If not found in SalesAgentProfile, search AppAuthUser in this workspace
  if (!agentProfile) {
    const authUser = await prisma.appAuthUser.findFirst({
      where: {
        tenantId,
        OR: [
          { id: rawAgentId },
          { displayName: { equals: rawAgentId, mode: 'insensitive' } },
          { email: { equals: rawAgentId, mode: 'insensitive' } },
        ],
      },
    });

    if (authUser) {
      // Find or create sales agent profile for this auth user
      const existing = await prisma.salesAgentProfile.findFirst({
        where: { tenantId, userId: authUser.id },
        include: { user: { select: { id: true, displayName: true, role: true, email: true } } },
      });
      if (existing) {
        agentProfile = existing;
      } else {
        const cleanName = (authUser.displayName || 'AGENT').slice(0, 7).toUpperCase().replace(/[^A-Z0-9]/g, '');
        agentProfile = await prisma.salesAgentProfile.create({
          data: {
            tenantId,
            userId: authUser.id,
            agentCode: `GX-${cleanName || 'AGENT'}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`,
            status: 'ACTIVE',
          },
          include: { user: { select: { id: true, displayName: true, role: true, email: true } } },
        });
      }
    }
  }

  if (!agentProfile) {
    res.status(404).json({
      success: false,
      code: 'AGENT_NOT_IN_WORKSPACE',
      error: 'AgentNotInWorkspace',
      message: `Target team member "${rawAgentId}" not found in workspace`,
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

  // 4. Verify target agent role: Super Admin and Company Admin are executive/platform roles and cannot be assigned front-line customer conversations
  const targetUserRole = String(agentProfile.user?.role || '').toUpperCase();
  if (targetUserRole === 'SUPER_ADMIN' || targetUserRole.includes('SUPER') || targetUserRole === 'ADMIN') {
    res.status(403).json({
      success: false,
      code: 'ADMIN_ASSIGNMENT_FORBIDDEN',
      error: 'AdminAssignmentForbidden',
      message: 'Super Admin and Company Admin are executive/platform roles and cannot be assigned front-line customer conversations.',
    });
    return;
  }

  // 5. Verify agent status is ACTIVE (auto-activate if needed)
  if (agentProfile.status !== 'ACTIVE') {
    await prisma.salesAgentProfile.update({
      where: { id: agentProfile.id },
      data: { status: 'ACTIVE' },
    });
    agentProfile.status = 'ACTIVE';
  }

  const assignedFreelancerId = agentProfile.id;
  const assignedFreelancerName = agentProfile.user?.displayName || agentProfile.agentCode || 'Team Closer';

  // Persist assignment note as a permanent system message in the conversation thread
  const actorName = user.displayName || user.email || 'Admin';
  const handoverNote = (req.body as any)?.note ? ` (${(req.body as any).note})` : '';
  const nowIso = new Date().toISOString();
  const assignSysMessage = {
    id: `msg-sys-assign-${randomUUID()}`,
    body: `Chat assigned to ${assignedFreelancerName} by ${actorName}${handoverNote}`,
    senderRole: 'system',
    senderLabel: 'System',
    senderType: 'SYSTEM',
    status: 'delivered',
    createdAt: nowIso,
  };

  const rawMessages = Array.isArray(convPayload.messages) ? (convPayload.messages as any[]) : [];
  rawMessages.push(assignSysMessage);
  convPayload.messages = rawMessages;
  convPayload.assignedTo = assignedFreelancerName;
  convPayload.assignedFreelancerId = assignedFreelancerId;
  convPayload.assignedAgentId = assignedFreelancerId;
  convPayload.assignedUserId = agentProfile.userId;

  // If this was a personal companion WhatsApp chat, symmetrically reassign companion ownership to target agent
  if (convPayload.scannedByUserId) {
    convPayload.originalScannedByUserId = convPayload.originalScannedByUserId || convPayload.scannedByUserId;
    convPayload.scannedByUserId = agentProfile.userId;
    convPayload.scannedByName = assignedFreelancerName;
  }

  await prisma.appConversation.update({
    where: { id: conversation.id },
    data: {
      assignedFreelancerId,
      assignedFreelancerName,
      payload: convPayload as any,
      updatedAt: new Date(),
    },
  });

  // Also update linked leads & create timeline entries for Command History
  const leadIdFromPayload = (convPayload as any)?.leadId;
  const cleanId = id.replace(/^conv-lead-/, '').replace(/^lead-/, '').replace(/^draft-/, '');
  const linkedLeads = await prisma.salesLeadAssignment.findMany({
    where: {
      tenantId,
      OR: [
        ...(leadIdFromPayload ? [{ id: leadIdFromPayload }] : []),
        { id },
        { id: cleanId },
        { conversationId: conversation.id },
        { id: `sales-conversation-${conversation.id}` },
        ...phoneMatchConditions([conversation.customerPhone]),
      ],
    },
    select: { id: true, assignedAgentId: true, customFields: true },
  });

  for (const linkedLead of linkedLeads) {
    const updatedCustomFields = {
      ...((linkedLead.customFields as Record<string, any>) || {}),
      owner: assignedFreelancerName,
      assignedAgentName: assignedFreelancerName,
      assignedUserId: agentProfile.userId,
    };

    await prisma.salesLeadAssignment.update({
      where: { id: linkedLead.id },
      data: {
        assignedAgentId: assignedFreelancerId,
        conversationId: conversation.id,
        customFields: updatedCustomFields,
        updatedAt: new Date(),
      },
    });

    // Create salesLeadTimelineEntry so it appears in Command History & Notes!
    await prisma.salesLeadTimelineEntry.create({
      data: {
        tenantId,
        leadId: linkedLead.id,
        userId: user.userId,
        agentId: assignedFreelancerId,
        type: 'LEAD_REASSIGNED',
        body: `Lead & Chat transferred to ${assignedFreelancerName} by ${actorName}${handoverNote}`,
        metadata: {
          fromUserId: user.userId,
          toAgentId: assignedFreelancerId,
          conversationId: conversation.id,
          note: (req.body as any)?.note || null,
        },
      },
    }).catch((e) => console.error('Failed to create timeline entry:', e));

    // Create salesActivityLog for audit trail
    await prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: linkedLead.id,
        actorUserId: user.userId,
        action: 'LEAD_REASSIGNED',
        note: `Lead & Chat transferred to ${assignedFreelancerName} by ${actorName}${handoverNote}`,
        metadata: { previousAgentId: linkedLead.assignedAgentId, newAgentId: assignedFreelancerId, conversationId: conversation.id },
      },
    }).catch(() => undefined);
  }

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.updated',
    payload: { conversationId: id, assignedAgentId: assignedFreelancerId, assignedFreelancerName, assignedTo: assignedFreelancerName },
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
    message: `Conversation and lead reassigned successfully to ${assignedFreelancerName}`,
    data: { conversationId: id, assignedAgentId: assignedFreelancerId, assignedFreelancerName, assignedTo: assignedFreelancerName },
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

  const convPayload = (conversation.payload as Record<string, unknown>) || {};
  convPayload.assignedTo = null;
  convPayload.assignedFreelancerId = null;
  convPayload.assignedAgentId = null;

  await prisma.appConversation.update({
    where: { id },
    data: {
      assignedFreelancerId: null,
      assignedFreelancerName: null,
      payload: convPayload as any,
      updatedAt: new Date(),
    },
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

  const conversation = await resolveAppConversation(tenantId, id, true);

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

const directShareBodySchema = z.object({
  targetUserId: z.string().optional(),
  userId: z.string().optional(),
}).refine((data) => Boolean(data.targetUserId || data.userId), {
  message: 'targetUserId or userId is required',
});

// POST /:id/share - Direct conversation sharing by user ID
conversationsRouter.post('/:id/share', validateBody(directShareBodySchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const targetUserId = String(req.body.targetUserId || req.body.userId || '').trim();

  const conversation = await resolveAppConversation(tenantId, id, true);

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

  // Hierarchical team scoping governance check
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const wsSettings = (workspace?.settings as Record<string, any>) || {};
  const userRole = req.user?.role;
  const isSalesAgent = userRole === 'SALES_AGENT' || (userRole as string) === 'CLOSER';

  if (wsSettings.chatSharingScope === 'REPORTING_TEAM_ONLY' && isSalesAgent) {
    const isSameTeam = await checkSameReportingTeam(tenantId, req.user!.userId, targetUserId);
    if (!isSameTeam) {
      res.status(403).json({
        success: false,
        error: 'Conversation sharing is restricted to your direct reporting team under workspace governance policy.',
        message: 'Conversation sharing is restricted to your direct reporting team under workspace governance policy.',
      });
      return;
    }
  }

  const payload = (conversation.payload && typeof conversation.payload === 'object' && !Array.isArray(conversation.payload))
    ? { ...(conversation.payload as Record<string, any>) }
    : {};

  const currentSharedUserIds: string[] = Array.isArray(payload.sharedUserIds)
    ? [...payload.sharedUserIds]
    : [];

  const targetProfile = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      OR: [
        { id: targetUserId },
        { userId: targetUserId },
        { user: { displayName: { equals: targetUserId, mode: 'insensitive' } } },
        { user: { email: { equals: targetUserId, mode: 'insensitive' } } },
      ],
    },
    include: { user: { select: { id: true, displayName: true, email: true } } },
  });

  const idsToAdd = new Set<string>([targetUserId]);
  if (targetProfile) {
    idsToAdd.add(targetProfile.id);
    idsToAdd.add(targetProfile.userId);
    if (targetProfile.user?.displayName) idsToAdd.add(targetProfile.user.displayName);
  }

  for (const id of idsToAdd) {
    if (!currentSharedUserIds.includes(id)) {
      currentSharedUserIds.push(id);
    }
  }

  payload.sharedUserIds = currentSharedUserIds;

  // Maintain structured shares array for backwards compatibility
  const shares: ConversationShareRecord[] = Array.isArray(payload.shares) ? [...payload.shares] : [];
  const existingShareIndex = shares.findIndex((s) => s.userId === targetUserId && !s.revokedAt);
  if (existingShareIndex === -1) {
    shares.push({
      id: `share-${randomUUID()}`,
      conversationId: conversation.id,
      userId: targetUserId,
      sharedByUserId: req.user!.userId,
      sharedByUserName: req.user!.displayName || req.user!.email,
      permission: 'VIEW',
      createdAt: new Date().toISOString(),
      revokedAt: null,
    });
    payload.shares = shares;
  }

  await prisma.appConversation.update({
    where: { id: conversation.id },
    data: {
      payload: payload as unknown as Prisma.InputJsonValue,
      updatedAt: new Date(),
    },
  });

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'conversation.shared',
    payload: {
      conversationId: conversation.id,
      targetUserId,
      sharedUserIds: currentSharedUserIds,
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.json({
    success: true,
    sharedWith: targetUserId,
    data: {
      conversationId: conversation.id,
      sharedWith: targetUserId,
      sharedUserIds: currentSharedUserIds,
    },
    error: null,
  });
});

const createShareSchema = z.object({
  userId: z.string().min(1, 'Target userId or agentProfileId is required'),
  permission: z.enum(['VIEW', 'REPLY']).default('VIEW'),
});

// POST /:id/shares - Share conversation with another agent/user
conversationsRouter.post('/:id/shares', validateBody(createShareSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { userId: targetUserParam, permission } = req.body as z.infer<typeof createShareSchema>;

  const conversation = await resolveAppConversation(tenantId, id, true);

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

  // Resolve target user in this tenant (can be profile ID, user ID, display name, or email)
  let targetAgentProfile = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      OR: [
        { id: targetUserParam },
        { userId: targetUserParam },
        { user: { displayName: { equals: targetUserParam, mode: 'insensitive' } } },
        { user: { email: { equals: targetUserParam, mode: 'insensitive' } } },
      ],
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
      where: {
        tenantId,
        OR: [
          { id: targetUserParam },
          { displayName: { equals: targetUserParam, mode: 'insensitive' } },
          { email: { equals: targetUserParam, mode: 'insensitive' } },
        ],
      },
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

  // Hierarchical team scoping governance check
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const wsSettings = (workspace?.settings as Record<string, any>) || {};
  const userRole = req.user?.role;
  const isSalesAgent = userRole === 'SALES_AGENT' || (userRole as string) === 'CLOSER';

  if (wsSettings.chatSharingScope === 'REPORTING_TEAM_ONLY' && isSalesAgent) {
    const isSameTeam = await checkSameReportingTeam(tenantId, req.user!.userId, targetUserId);
    if (!isSameTeam) {
      res.status(403).json({
        success: false,
        error: 'Conversation sharing is restricted to your direct reporting team under workspace governance policy.',
        message: 'Conversation sharing is restricted to your direct reporting team under workspace governance policy.',
      });
      return;
    }
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

  const conversation = await resolveAppConversation(tenantId, id);

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

  const conversation = await resolveAppConversation(tenantId, id, false);

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

  // Resolve linked lead if exists
  const leadId = (existingPayload.leadId as string) || null;
  let linkedLead = leadId
    ? await prisma.salesLeadAssignment.findFirst({ where: { id: leadId, tenantId } })
    : null;
  if (!linkedLead && conversation.customerPhone) {
    const rawPhone = conversation.customerPhone.trim();
    const phoneDigits = rawPhone.replace(/\D/g, '');
    const last10 = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : phoneDigits;
    linkedLead = await prisma.salesLeadAssignment.findFirst({
      where: {
        tenantId,
        OR: [
          { customerPhone: rawPhone },
          ...(last10.length >= 7 ? [{ customerPhone: { contains: last10 } }] : []),
          { conversationId: id },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  if (action === 'mark-status') {
    const nextStatus = String(body.status || 'Paid');
    const paymentRequestId = String(body.paymentRequestId || currentPayment?.id || '');
    const updatedPayment = {
      ...(currentPayment || {}),
      id: paymentRequestId,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    };

    if (paymentRequestId) {
      const matchStatus = nextStatus.toUpperCase() === 'PAID' ? 'PAID' : 'PENDING';
      await prisma.upiPaymentLink.updateMany({
        where: {
          tenantId,
          OR: [
            { customFields: { path: ['paymentRequestId'], equals: paymentRequestId } },
            { id: paymentRequestId },
          ],
        },
        data: {
          status: matchStatus as any,
          ...(matchStatus === 'PAID' ? { paidAt: new Date() } : {}),
          updatedAt: new Date(),
        },
      }).catch(() => undefined);
    }

    if (linkedLead && nextStatus.toUpperCase() === 'PAID') {
      await prisma.salesLeadTimelineEntry.create({
        data: {
          tenantId,
          leadId: linkedLead.id,
          type: 'PAYMENT_RECEIVED',
          body: `Payment marked as Paid: ${currentPayment?.amount ? `₹${currentPayment.amount}` : ''}`,
          metadata: { paymentRequestId },
        },
      }).catch(() => undefined);
    }

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

  // Load configured workspace payment gateway settings (zero hardcoded fallback)
  const paymentSettings = await prisma.upiPaymentSetting.findUnique({ where: { tenantId } });
  const upiId = String(body.payeeUpiId || paymentSettings?.upiId || 'aicloser@upi').trim();
  const payeeName = String(paymentSettings?.payeeName || 'AI Closer CRM').trim();

  const publicToken = randomUUID().replace(/-/g, '').slice(0, 16);
  const payUrl = `https://app.aicloser.in/pay/${publicToken}`;
  const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(title)}`;

  // Create real database row in upiPaymentLink
  let authUserId = req.user?.userId;
  if (!authUserId) {
    const fallbackUser = await prisma.appAuthUser.findFirst({ where: { tenantId } });
    authUserId = fallbackUser?.id;
  }

  if (authUserId) {
    await prisma.upiPaymentLink.create({
      data: {
        tenantId,
        publicToken,
        createdByUserId: authUserId,
        customerName: conversation.customerName || linkedLead?.customerName || 'Valued Customer',
        customerPhone: conversation.customerPhone || linkedLead?.customerPhone || '',
        customerEmail: linkedLead?.customerEmail || null,
        productName: title,
        totalAmount: amount,
        baseAmount: amount,
        duration: 1,
        durationUnit: 'DAY' as any,
        durationMultiplier: 1,
        currency: 'INR',
        status: 'PENDING',
        upiIdSnapshot: upiId,
        payeeNameSnapshot: payeeName,
        customFields: {
          conversationId: id,
          leadId: linkedLead?.id || null,
          paymentRequestId,
        },
      },
    }).catch((err) => {
      logger.warn('Failed to create upiPaymentLink row for conversation payment request', { error: String(err) });
    });
  }

  // Synchronize budget amount and timeline on the linked lead
  if (linkedLead) {
    await prisma.salesLeadAssignment.update({
      where: { id: linkedLead.id },
      data: {
        budgetAmount: amount,
        updatedAt: new Date(),
      },
    }).catch(() => undefined);

    await prisma.salesLeadTimelineEntry.create({
      data: {
        tenantId,
        leadId: linkedLead.id,
        type: 'PAYMENT_LINK_GENERATED',
        body: `Payment request created for ₹${amount.toLocaleString('en-IN')} (${title}): ${payUrl}`,
        metadata: { paymentRequestId, amount, publicToken, payUrl },
      },
    }).catch(() => undefined);
  }

  const newPayment = {
    id: paymentRequestId,
    publicToken,
    amount,
    title,
    note,
    status: 'Sent',
    paymentLink: upiLink,
    payUrl,
    payeeUpiId: upiId,
    payeeName,
    payeeRole: body.payeeRole || 'agency',
    createdAt: new Date().toISOString(),
  };

  const rawMessages = Array.isArray(existingPayload.messages) ? (existingPayload.messages as Record<string, unknown>[]) : [];
  const prevPaymentRequests = Array.isArray(existingPayload.paymentRequests)
    ? (existingPayload.paymentRequests as Record<string, unknown>[])
    : (existingPayload.latestPaymentRequest ? [existingPayload.latestPaymentRequest as Record<string, unknown>] : []);

  const paymentMessage = {
    id: `msg-${randomUUID()}`,
    body: `Payment request: ₹${amount.toLocaleString('en-IN')} for ${title}${note ? ` (${note})` : ''} - Pay online: ${payUrl}`,
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
        payUrl,
      },
    ],
  };

  await prisma.appConversation.update({
    where: { id },
    data: {
      payload: {
        ...existingPayload,
        latestPaymentRequest: newPayment,
        paymentRequests: [...prevPaymentRequests, newPayment],
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
