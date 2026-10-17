import { upsertCompanyLead, normalizePhoneNumber } from '../../lib/lead-upsert-pipeline.js';
import { logger } from '../../lib/logger.js';
import { maskPhoneNumber, isPhoneMaskingRequired } from '../../lib/phone-mask.js';
import { assignLeadToNextCloser } from '../../lib/lead-assignment-engine.js';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { SalesLeadStage, salesLeadStageSchema } from '../../types/leads.js';
import { hasPermission, requirePermissions, PERM_LEADS_CLAIM, PERM_LEADS_REASSIGN } from '../../middlewares/rbac.js';
import { persistApiRealtimeEvent } from '../../lib/realtime.js';
import { syncMarketingContactForLead, normalizeLeadPhone, deleteContactsAndLinkedLeadsTransactional } from '../../lib/lead-contact-sync.js';
import { getWorkspaceScope } from '../../lib/workspace-scope.js';

export const leadsRouter = Router();

// Apply auth and tenant isolation to all lead routes
leadsRouter.use(authenticate, enforceTenantIsolation);

const listLeadsQuerySchema = z.object({
  page: z.string().optional().transform((v) => (v ? Math.max(1, Number(v)) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, Math.max(1, Number(v))) : 25)),
  stage: salesLeadStageSchema.optional(),
  search: z.string().optional(),
  assignedAgentId: z.string().optional(),
  sortBy: z.enum(['kanbanPosition', 'createdAt', 'updatedAt', 'followUpAt', 'budgetAmount']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

leadsRouter.get('/', validateQuery(listLeadsQuerySchema), async (req: Request, res: Response) => {
  const { page, limit, stage, search, assignedAgentId } = req.query as unknown as {
    page: number;
    limit: number;
    stage?: SalesLeadStage;
    search?: string;
    assignedAgentId?: string;
  };

  const tenantId = req.tenantId!;

  // Strict tenant-scoped WHERE clause
  const where: Record<string, unknown> = {
    tenantId,
  };

  if (stage) where.stage = stage;

  // Admins see the tenant; managers see their reporting team; closers see
  // only their own assigned leads.
  if (req.user?.role === 'SALES_AGENT' || req.user?.role === 'MANAGER') {
    const scope = await getWorkspaceScope(tenantId, req.user);
    where.assignedAgentId = { in: scope.profileIds.length ? scope.profileIds : ['__NO_ACCESS__'] };
  } else if (assignedAgentId) {
    where.assignedAgentId = assignedAgentId;
  }

  if (search) {
    const trimmed = search.trim();
    const phoneVariation = trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
    where.OR = [
      { customerName: { contains: trimmed, mode: 'insensitive' } },
      { customerPhone: { contains: trimmed } },
      { customerPhone: { contains: phoneVariation } },
      { customerEmail: { contains: trimmed, mode: 'insensitive' } },
    ];
  }

  const [total, leads] = await Promise.all([
    prisma.salesLeadAssignment.count({ where }),
    prisma.salesLeadAssignment.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: (req.query as any).sortBy === 'createdAt' ? [{ createdAt: ((req.query as any).sortOrder || 'desc') as 'asc' | 'desc' }] : [{ kanbanPosition: 'asc' as const }, { createdAt: 'desc' as const }],
      include: {
        assignedAgent: {
          select: {
            id: true,
            agentCode: true,
            user: { select: { displayName: true, email: true, phone: true } },
          },
        },
      },
    }),
  ]);

  // Check workspace security setting for phone masking
  const wsForMask = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const shouldMask = isPhoneMaskingRequired(req.user, wsForMask?.settings as Record<string, any>);

  const sanitizedLeads = shouldMask
    ? leads.map((l) => ({
        ...l,
        customerPhone: maskPhoneNumber(l.customerPhone, true),
      }))
    : leads;

  res.json({
    success: true,
    data: sanitizedLeads,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    error: null,
  });
});

const createLeadSchema = z.object({
  customerName: z.string().min(1, 'Customer name is required'),
  customerPhone: z.string().min(5, 'Phone number is required'),
  customerEmail: z.string().email().optional(),
  assignedAgentId: z.string().min(1, 'Assigned agent is required'),
  serviceInterest: z.string().optional(),
  segment: z.string().optional(),
  priority: z.string().default('normal'),
  notes: z.string().optional(),
  stage: salesLeadStageSchema.default('NEW'),
  budgetAmount: z.number().optional(),
});

leadsRouter.post('/', validateBody(createLeadSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body;

  // Verify that the assigned agent belongs to the same tenant (resolving SalesAgentProfile.id or User.id)
  const agent = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      OR: [
        { id: body.assignedAgentId },
        { userId: body.assignedAgentId },
      ],
    },
  });

  if (!agent) {
    res.status(400).json({
      success: false,
      error: 'InvalidAgent',
      message: 'Assigned agent does not exist within your workspace',
    });
    return;
  }

  // Tenant-scoped deduplication check: prevent duplicate leads for the same phone number
  const rawPhone = body.customerPhone?.trim() || "";
  const cleanDigits = rawPhone.replace(/\D/g, "");
  const last10 = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;

  if (last10 && last10.length >= 7) {
    const existing = await prisma.salesLeadAssignment.findFirst({
      where: {
        tenantId,
        OR: [
          { customerPhone: body.customerPhone },
          { customerPhone: { contains: last10 } },
          ...(body.customerEmail ? [{ customerEmail: body.customerEmail }] : []),
        ],
      },
      orderBy: [{ stage: 'desc' }, { createdAt: 'asc' }],
    });

    if (existing) {
      // Enrich existing lead with any new notes / metadata without creating a duplicate row
      const updated = await prisma.salesLeadAssignment.update({
        where: { id: existing.id },
        data: {
          lastContactedAt: new Date(),
          ...(body.notes ? { notes: existing.notes ? (existing.notes + "\n---\n" + body.notes) : body.notes } : {}),
          ...(body.budgetAmount ? { budgetAmount: body.budgetAmount } : {}),
        },
      });

      await syncMarketingContactForLead(updated).catch(() => undefined);

      await prisma.salesActivityLog.create({
        data: {
          tenantId,
          assignmentId: existing.id,
          actorUserId: req.user?.userId,
          action: "LEAD_DEDUPLICATED",
          note: "Incoming lead for " + body.customerName + " (" + body.customerPhone + ") deduplicated against existing lead ID " + existing.id,
        },
      });

      res.status(200).json({
        success: true,
        deduplicated: true,
        message: "Lead already exists for this phone number in your workspace and was updated.",
        data: updated,
        error: null,
      });
      return;
    }
  }

  let lead;
  try {
    lead = await prisma.salesLeadAssignment.create({
      data: {
        tenantId, // Root ownership strictly enforced
        customerName: body.customerName,
        customerPhone: body.customerPhone,
        customerEmail: body.customerEmail,
        assignedAgentId: agent.id, // canonicalized profile ID
        createdById: req.user?.userId,
        serviceInterest: body.serviceInterest,
        segment: body.segment,
        priority: body.priority,
        notes: body.notes,
        stage: body.stage,
        budgetAmount: body.budgetAmount,
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002' || err?.message?.includes('idx_salesleadassignment_tenant_phone')) {
      // Race-condition resilience: return existing record if concurrently inserted
      const existing = await prisma.salesLeadAssignment.findFirst({
        where: { tenantId, customerPhone: body.customerPhone },
      });
      if (existing) {
        res.status(200).json({
          success: true,
          data: existing,
          deduplicated: true,
          message: 'Lead already exists in workspace; enriched existing record',
          error: null,
        });
        return;
      }
    }
    throw err;
  }

  // Also log activity log under this tenant
  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: lead.id,
      actorUserId: req.user?.userId,
      action: 'LEAD_CREATED',
      note: `Lead created manually for ${body.customerName}`,
    },
  });

  await syncMarketingContactForLead(lead).catch(() => undefined);

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.created',
    payload: lead,
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.status(201).json({ success: true, data: lead, error: null });
});

leadsRouter.get('/pipeline-aggregates', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const where: any = { tenantId };

  // Pipeline totals must use the same visibility scope as the lead list.
  // Otherwise a newly-created sales user sees workspace totals on Dashboard
  // while Kanban correctly shows only their assigned leads.
  if (req.user?.role === 'SALES_AGENT' || req.user?.role === 'MANAGER') {
    const scope = await getWorkspaceScope(tenantId, req.user);
    where.assignedAgentId = { in: scope.profileIds.length ? scope.profileIds : ['__NO_ACCESS__'] };
  }

  const aggregates = await prisma.salesLeadAssignment.groupBy({
    by: ['stage'],
    where,
    _count: { id: true },
    _sum: { budgetAmount: true },
  });

  const stageProbabilities: Record<string, number> = {
    NEW: 0.1,
    CONTACTED: 0.2,
    IN_PROGRESS: 0.35,
    DEMO_SCHEDULED: 0.5,
    FOLLOW_UP: 0.6,
    NEGOTIATION: 0.8,
    CLOSED_WON: 1.0,
    CLOSED_LOST: 0.0,
  };

  const results = aggregates.map((item) => {
    const count = item._count?.id ?? 0;
    const totalValue = Number(item._sum?.budgetAmount ?? 0);
    const winProb = stageProbabilities[item.stage] ?? 0.2;
    const weightedValue = Math.round(totalValue * winProb);
    return {
      stage: item.stage,
      count,
      totalValue,
      weightedValue,
    };
  });

  res.json({ success: true, data: results });
});

// GET /dashboard-summary - Permission-scoped aggregated totals for dashboard KPIs
leadsRouter.get('/dashboard-summary', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const where: any = { tenantId };

  if (req.user?.role === 'SALES_AGENT' || req.user?.role === 'MANAGER') {
    const scope = await getWorkspaceScope(tenantId, req.user);
    where.assignedAgentId = { in: scope.profileIds.length ? scope.profileIds : ['__NO_ACCESS__'] };
  } else if (req.query.assignedAgentId) {
    where.assignedAgentId = String(req.query.assignedAgentId);
  }

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const [
    totalLeads,
    hotLeads,
    followUpsToday,
    followUpsPending,
    stageAggregates,
  ] = await Promise.all([
    prisma.salesLeadAssignment.count({ where }),
    prisma.salesLeadAssignment.count({
      where: {
        ...where,
        priority: { in: ['HIGH', 'URGENT'] },
      },
    }),
    prisma.salesLeadAssignment.count({
      where: {
        ...where,
        followUpAt: { gte: startOfDay, lte: endOfDay },
      },
    }),
    prisma.salesLeadAssignment.count({
      where: {
        ...where,
        followUpAt: { lt: now },
        stage: { notIn: ['CLOSED_WON', 'CLOSED_LOST'] },
      },
    }),
    prisma.salesLeadAssignment.groupBy({
      by: ['stage'],
      where,
      _count: { id: true },
      _sum: { budgetAmount: true },
    }),
  ]);

  let wonCount = 0;
  let wonAmount = 0;
  let lostCount = 0;
  let pipelineValue = 0;
  const stageCounts: Record<string, number> = {};

  for (const item of stageAggregates) {
    const count = item._count?.id ?? 0;
    const value = Number(item._sum?.budgetAmount ?? 0);
    stageCounts[item.stage] = count;

    if (item.stage === 'CLOSED_WON' || (item.stage as string) === 'PAID') {
      wonCount += count;
      wonAmount += value;
    } else if (item.stage === 'CLOSED_LOST' || (item.stage as string) === 'LOST') {
      lostCount += count;
    } else {
      pipelineValue += value;
    }
  }

  const conversionRate = totalLeads > 0 ? Number(((wonCount / totalLeads) * 100).toFixed(1)) : 0;

  res.json({
    success: true,
    data: {
      totalLeads,
      hotLeads,
      followUpsToday,
      followUpsPending,
      wonCount,
      wonAmount,
      lostCount,
      pipelineValue,
      conversionRate,
      stageCounts,
    },
    error: null,
  });
});


// GET /pool - Unassigned leads in the Grab Pool
leadsRouter.get('/pool', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const profile = req.user?.role === 'SALES_AGENT'
    ? await prisma.salesAgentProfile.findFirst({
        where: { userId: req.user.userId, tenantId, status: 'ACTIVE' },
        select: { id: true },
      })
    : null;

  if (req.user?.role === 'SALES_AGENT' && !profile) {
    res.json({ success: true, data: [], error: null });
    return;
  }

  const poolLeads = await prisma.salesLeadPoolItem.findMany({
    where: {
      tenantId,
      status: 'OPEN',
      ...(profile ? { OR: [{ assignedAgentId: null }, { assignedAgentId: profile.id }] } : {}),
    },
    take: 50,
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: poolLeads });
});

// GET /duplicates - Detect duplicate leads by phone or email
leadsRouter.get('/duplicates', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  // Find phones that occur more than once
  const duplicates = await prisma.$queryRawUnsafe<Array<{ customerPhone: string; count: number }>>(`
    SELECT "customerPhone", COUNT(*)::int as count
    FROM "SalesLeadAssignment"
    WHERE "tenantId" = '${tenantId}'
    GROUP BY "customerPhone"
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 20;
  `);

  const results = await Promise.all(
    duplicates.map(async (d) => {
      const leads = await prisma.salesLeadAssignment.findMany({
        where: { tenantId, customerPhone: d.customerPhone },
        orderBy: { createdAt: 'desc' },
      });
      return {
        phone: d.customerPhone,
        duplicateCount: d.count,
        leads,
      };
    })
  );

  res.json({ success: true, data: results });
});

// POST /merge - Merge secondary duplicate lead into primary
leadsRouter.post('/merge', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { primaryLeadId, secondaryLeadId } = req.body as { primaryLeadId: string; secondaryLeadId: string };

  if (!primaryLeadId || !secondaryLeadId || primaryLeadId === secondaryLeadId) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'Specify two distinct lead IDs' });
    return;
  }

  const [primary, secondary] = await Promise.all([
    prisma.salesLeadAssignment.findFirst({ where: { id: primaryLeadId, tenantId } }),
    prisma.salesLeadAssignment.findFirst({ where: { id: secondaryLeadId, tenantId } }),
  ]);

  if (!primary || !secondary) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'One or both leads not found' });
    return;
  }

  // Transfer calls to primary
  await prisma.salesMobileCall.updateMany({
    where: { assignmentId: secondary.id, tenantId },
    data: { assignmentId: primary.id },
  });

  // Transfer timeline entries to primary
  await prisma.salesLeadTimelineEntry.updateMany({
    where: { leadId: secondary.id, tenantId },
    data: { leadId: primary.id },
  });

  // Archive secondary lead
  await prisma.salesLeadAssignment.delete({
    where: { id: secondary.id },
  });

  // Log audit event
  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: primary.id,
      actorUserId: req.user?.userId,
      action: 'LEAD_MERGED',
      note: `Merged duplicate lead ${secondary.id} (${secondary.customerName}) into this lead`,
    },
  });

  res.json({ success: true, message: 'Leads merged successfully', primaryLeadId });
});


async function verifyLeadAccess(leadId: string, req: Request) {
  const tenantId = req.tenantId!;
  const user = req.user!;

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id: leadId, tenantId },
    include: {
      assignedAgent: {
        select: {
          id: true,
          agentCode: true,
          userId: true,
          user: { select: { id: true, displayName: true, email: true, phone: true } },
        },
      },
    },
  });

  if (!lead) return { ok: false as const, status: 404, error: 'NotFound', message: 'Lead not found in this workspace' };

  // Closer scoping: SALES_AGENT can only access leads assigned to them
  if (user.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: user.userId, tenantId },
      select: { id: true },
    });
    if (!profile || lead.assignedAgentId !== profile.id) {
      return { ok: false as const, status: 403, error: 'Forbidden', message: 'You are not authorized to access this lead' };
    }
  }

  return { ok: true as const, lead };
}

// GET /:id/360 - Unified Lead 360 view
leadsRouter.get('/:id/360', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, data: null, error: check.error, message: check.message });
    return;
  }
  const lead = check.lead;

  // 2. Fetch all child resources strictly isolated to this verified lead
  const [timeline, tasks, calls, customFieldsDef, activityLogs] = await Promise.all([
    prisma.salesLeadTimelineEntry.findMany({
      where: { leadId: lead.id, tenantId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.gxLeadTask.findMany({
      where: { salesLeadId: lead.id },
      orderBy: { dueAt: 'asc' },
    }),
    prisma.salesMobileCall.findMany({
      where: { assignmentId: lead.id, tenantId },
      orderBy: { startedAt: 'desc' },
      take: 20,
    }),
    prisma.customFieldDefinition.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.salesActivityLog.findMany({
      where: { assignmentId: lead.id, tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        actor: { select: { displayName: true, email: true } },
      },
    }),
  ]);

  const recordingUploads = calls.length
    ? await prisma.callRecordingUpload.findMany({
        where: { tenantId, callId: { in: calls.map((call) => call.id) }, status: 'UPLOADED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, callId: true },
      })
    : [];
  const recordingByCallId = new Map<string, string>();
  for (const upload of recordingUploads) {
    if (!recordingByCallId.has(upload.callId)) recordingByCallId.set(upload.callId, upload.id);
  }
  const enrichedCalls = calls.map((call) => ({
    ...call,
    recordingUploadId: recordingByCallId.get(call.id) ?? null,
    hasRecording: Boolean(recordingByCallId.get(call.id)),
  }));

  // 3. Direct conversation relation prioritized, fallback to phone
  let conversation = null;
  if (lead.conversationId) {
    conversation = await prisma.appConversation.findFirst({
      where: { id: lead.conversationId, tenantId },
      select: { id: true, status: true, updatedAt: true, payload: true },
    });
  }
  if (!conversation && lead.customerPhone) {
    conversation = await prisma.appConversation.findFirst({
      where: { tenantId, customerPhone: lead.customerPhone },
      select: { id: true, status: true, updatedAt: true, payload: true },
    });
    if (conversation) {
      await prisma.salesLeadAssignment.update({
        where: { id: lead.id },
        data: { conversationId: conversation.id },
      }).catch(() => undefined);
    }
  }

  // 4. Payments directly linked to lead in customFields, fallback to customerPhone
  const payments = await prisma.upiPaymentLink.findMany({
    where: {
      tenantId,
      OR: [
        { customFields: { path: ['leadId'], equals: id } },
        ...(lead.customerPhone ? [{ customerPhone: lead.customerPhone }] : []),
      ],
    },
    orderBy: { id: 'desc' },
    take: 10,
  });

  const rawMessages = Array.isArray((conversation?.payload as any)?.messages)
    ? (conversation!.payload as any).messages
    : [];
  const lastMessage = rawMessages.length > 0 ? rawMessages[rawMessages.length - 1] : null;
  const humanizeHistoryAction = (value: string) => value
    .replace(/^LEAD_/, '')
    .replace(/^CALL_/, 'Call ')
    .replace(/^MOBILE_/, 'Mobile ')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
  const history: Array<Record<string, unknown>> = [
    ...timeline.map((entry) => ({
      id: `timeline:${entry.id}`,
      kind: entry.type || 'NOTE',
      title: entry.type === 'NOTE' ? 'Note added' : humanizeHistoryAction(entry.type),
      body: entry.body,
      createdAt: entry.createdAt.toISOString(),
    })),
    ...activityLogs.map((entry) => ({
      id: `activity:${entry.id}`,
      kind: 'ACTIVITY',
      title: humanizeHistoryAction(entry.action),
      body: entry.note || humanizeHistoryAction(entry.action),
      createdAt: entry.createdAt.toISOString(),
      actorName: entry.actor?.displayName || entry.actor?.email || null,
      metadata: entry.metadata,
    })),
    ...tasks.map((task) => ({
      id: `task:${task.id}`,
      kind: 'CALLBACK',
      title: task.title || 'Follow-up scheduled',
      body: task.description || 'Follow-up task created for this lead.',
      createdAt: task.createdAt.toISOString(),
      dueAt: task.dueAt.toISOString(),
      status: task.status,
    })),
    ...enrichedCalls.map((call) => ({
      id: `call:${call.id}`,
      kind: 'CALL',
      title: `${call.direction === 'INBOUND' ? 'Incoming' : 'Outgoing'} call`,
      body: [
        call.outcome,
        call.note,
        call.durationSeconds != null ? `${call.durationSeconds}s` : null,
      ].filter(Boolean).join(' · ') || 'Call activity recorded.',
      createdAt: call.startedAt.toISOString(),
    })),
    ...payments.map((payment) => ({
      id: `payment:${payment.id}`,
      kind: 'PAYMENT',
      title: 'Payment request updated',
      body: `${payment.status}${payment.totalAmount != null ? ` · ${payment.currency} ${payment.totalAmount}` : ''}`,
      createdAt: payment.createdAt.toISOString(),
    })),
    ...rawMessages.map((message: any, index: number) => ({
      id: `message:${message.id || index}`,
      kind: 'MESSAGE',
      title: message.senderRole === 'customer' ? 'Customer message' : 'Team message',
      body: String(message.body || '').trim() || 'Message activity recorded.',
      createdAt: String(message.createdAt || conversation?.updatedAt || new Date().toISOString()),
    })),
  ].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

  const raw360Data = {
    lead,
    assignedAgent: lead.assignedAgent ? {
      id: lead.assignedAgent.id,
      agentCode: lead.assignedAgent.agentCode,
      displayName: lead.assignedAgent.user?.displayName,
      email: lead.assignedAgent.user?.email,
      phone: lead.assignedAgent.user?.phone,
    } : null,
    notes: timeline.filter((entry) => entry.type === 'NOTE'),
    timelineNotes: timeline.filter((entry) => entry.type === 'NOTE'),
    timeline,
    activityLogs,
    history,
    tasks,
    callbacks: tasks,
    callLogs: enrichedCalls,
    calls: enrichedCalls,
    activeConversation: conversation ? {
      id: conversation.id,
      status: conversation.status,
      updatedAt: conversation.updatedAt,
      unreadCount: 0,
      lastMessage,
    } : null,
    conversation: conversation ? {
      id: conversation.id,
      status: conversation.status,
      updatedAt: conversation.updatedAt,
    } : null,
    payments,
    customFieldDefinitions: customFieldsDef,
    customFieldsDefinition: customFieldsDef,
  };

  const wsFor360 = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  if (isPhoneMaskingRequired(req.user, wsFor360?.settings as Record<string, any>)) {
    if (raw360Data.lead) {
      raw360Data.lead = {
        ...raw360Data.lead,
        customerPhone: maskPhoneNumber(raw360Data.lead.customerPhone, true),
      };
    }
    if (raw360Data.callLogs) {
      raw360Data.callLogs = raw360Data.callLogs.map((c: any) => ({
        ...c,
        phoneNumber: maskPhoneNumber(c.phoneNumber, true),
      }));
    }
    if (raw360Data.calls) {
      raw360Data.calls = raw360Data.calls.map((c: any) => ({
        ...c,
        phoneNumber: maskPhoneNumber(c.phoneNumber, true),
      }));
    }
  }

  res.json({
    success: true,
    data: raw360Data,
    error: null,
  });
});

leadsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, data: null, error: check.error, message: check.message });
    return;
  }

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id: check.lead.id, tenantId },
    include: {
      assignedAgent: {
        select: {
          id: true,
          agentCode: true,
          user: { select: { displayName: true, email: true, phone: true } },
        },
      },
      mobileCalls: {
        where: { tenantId },
        orderBy: { startedAt: 'desc' },
        take: 10,
      },
      activityLogs: {
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found in this workspace' });
    return;
  }

  res.json({ success: true, data: lead });
});

const updateLeadSchema = z.object({
  customerName: z.string().trim().min(1).max(200).optional(),
  customerPhone: z.string().trim().min(5).max(40).nullable().optional(),
  customerEmail: z.string().trim().email().max(320).nullable().optional(),
  serviceInterest: z.string().trim().max(200).nullable().optional(),
  segment: z.string().trim().max(120).nullable().optional(),
  stage: salesLeadStageSchema.optional(),
  kanbanPosition: z.number().optional(),
  priority: z.string().optional(),
  notes: z.string().optional(),
  followUpAt: z.string().datetime().nullable().optional(),
  budgetAmount: z.number().optional(),
  assignedAgentId: z.string().optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  customFields: z.record(z.unknown()).optional(),
  lostReason: z.string().optional().nullable(),
  lostReasonNotes: z.string().optional().nullable(),
  isDndActive: z.boolean().optional(),
});

leadsRouter.patch('/:id', validateBody(updateLeadSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body;

  // The CRM settings toggle is enforced here as well as in the UI. This keeps
  // direct API calls and the Kanban/list controls on the same permission rule.
  if (req.user?.role !== 'ADMIN' && req.user?.role !== 'SUPER_ADMIN') {
    const workspace = await prisma.aicloserWorkspace.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const workspaceSettings = (workspace?.settings as Record<string, any>) || {};
    const roundRobinSettings = (workspaceSettings.roundRobinSettings as Record<string, any>) || {};
    if (roundRobinSettings.allowNonAdminModifyLeads === false) {
      res.status(403).json({
        success: false,
        code: 'PERMISSION_DENIED',
        error: 'Forbidden',
        message: 'Only workspace administrators can modify leads. Ask an administrator to enable lead modification access.',
      });
      return;
    }
  }

  // First verify lead exists in this tenant
  const existing = await prisma.salesLeadAssignment.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found in this workspace' });
    return;
  }

  // The phone is the tenant-scoped lead identity key. It can be set when the
  // lead is created, but changing it would silently detach conversations,
  // notes, calls, and payment history from the original customer.
  if (body.customerPhone !== undefined && body.customerPhone !== existing.customerPhone) {
    res.status(400).json({
      success: false,
      error: 'LeadPhoneImmutable',
      message: 'A lead phone number is its identity key and cannot be changed after creation.',
    });
    return;
  }

  // Strict closer scoping: Closers can only update leads assigned to them and cannot reassign
  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    if (existing.assignedAgentId !== profile?.id) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only update leads assigned to you' });
      return;
    }
    if (body.assignedAgentId && body.assignedAgentId !== existing.assignedAgentId) {
      const canReassign = await hasPermission(req.user.userId, tenantId, req.user.role, PERM_LEADS_REASSIGN);
      if (!canReassign) {
        res.status(403).json({ success: false, error: 'Forbidden', message: 'Only workspace administrators or authorized users can reassign leads' });
        return;
      }
    }
  }

  // If reassigning (admin/manager), verify target agent belongs to same tenant (resolving SalesAgentProfile.id or User.id)
  let targetAgentId: string | undefined = undefined;
  if (body.assignedAgentId && body.assignedAgentId !== existing.assignedAgentId) {
    const targetAgent = await prisma.salesAgentProfile.findFirst({
      where: {
        tenantId,
        OR: [
          { id: body.assignedAgentId },
          { userId: body.assignedAgentId },
        ],
      },
    });
    if (!targetAgent) {
      res.status(400).json({ success: false, error: 'InvalidAgent', message: 'Target agent not in workspace' });
      return;
    }
    targetAgentId = targetAgent.id;
  }

  const updated = await prisma.salesLeadAssignment.update({
    where: { id },
    data: {
      ...(body.customerName !== undefined ? { customerName: body.customerName } : {}),
      ...(body.customerEmail !== undefined ? { customerEmail: body.customerEmail || null } : {}),
      ...(body.serviceInterest !== undefined ? { serviceInterest: body.serviceInterest || null } : {}),
      ...(body.segment !== undefined ? { segment: body.segment || null } : {}),
      ...(body.stage !== undefined ? { stage: body.stage } : {}),
      ...(body.kanbanPosition !== undefined ? { kanbanPosition: body.kanbanPosition } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.budgetAmount !== undefined ? { budgetAmount: body.budgetAmount } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.customFields !== undefined ? { customFields: body.customFields } : {}),
      ...(body.lostReason !== undefined ? { lostReason: body.lostReason } : {}),
      ...(body.lostReasonNotes !== undefined ? { lostReasonNotes: body.lostReasonNotes } : {}),
      ...(body.isDndActive !== undefined ? { isDndActive: body.isDndActive } : {}),
      ...(targetAgentId ? { assignedAgentId: targetAgentId } : {}),
      ...(body.followUpAt !== undefined ? { followUpAt: body.followUpAt ? new Date(body.followUpAt) : null } : {}),
    },
  });

  const leadHistoryWrites: Promise<unknown>[] = [];
  if (body.stage !== undefined && body.stage !== existing.stage) {
    leadHistoryWrites.push(prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: existing.id,
        actorUserId: req.user?.userId,
        action: 'LEAD_STAGE_CHANGED',
        note: `Lead stage changed from ${existing.stage} to ${body.stage}`,
        metadata: { previousStage: existing.stage, newStage: body.stage },
      },
    }));
  }
  if (targetAgentId) {
    leadHistoryWrites.push(prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: existing.id,
        actorUserId: req.user?.userId,
        action: 'LEAD_REASSIGNED',
        note: `Lead reassigned to ${targetAgentId}`,
        metadata: { previousAgentId: existing.assignedAgentId, newAgentId: targetAgentId },
      },
    }));
  }
  if (body.followUpAt !== undefined) {
    leadHistoryWrites.push(prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: existing.id,
        actorUserId: req.user?.userId,
        action: body.followUpAt ? 'CALLBACK_SCHEDULED' : 'CALLBACK_CLEARED',
        note: body.followUpAt ? `Callback scheduled for ${body.followUpAt}` : 'Callback cleared',
        metadata: { followUpAt: body.followUpAt },
      },
    }));
  }

  const historyHandledFields = new Set(['stage', 'assignedAgentId', 'followUpAt']);
  const changedDetailFields = Object.keys(body)
    .filter((field) => !historyHandledFields.has(field))
    .filter((field) => JSON.stringify((existing as any)[field] ?? null) !== JSON.stringify((body as any)[field] ?? null));
  if (changedDetailFields.length > 0) {
    leadHistoryWrites.push(prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: existing.id,
        actorUserId: req.user?.userId,
        action: 'LEAD_DETAILS_UPDATED',
        note: `Lead details updated: ${changedDetailFields.join(', ')}`,
        metadata: { changedFields: changedDetailFields },
      },
    }));
  }
  await Promise.all(leadHistoryWrites).catch(() => undefined);

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.stage_changed',
    payload: {
      id: updated.id,
      stage: updated.stage,
      kanbanPosition: updated.kanbanPosition,
      priority: updated.priority,
      budgetAmount: updated.budgetAmount,
      updatedAt: updated.updatedAt,
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  // Sync mirrored marketing contact with updated lead fields (name, email, assignee)
  await syncMarketingContactForLead(updated).catch(() => undefined);

  res.json({ success: true, data: updated, error: null });
});

leadsRouter.delete('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  // Closers cannot delete leads
  if (req.user?.role === 'SALES_AGENT') {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Only workspace administrators can delete leads' });
    return;
  }

  const existing = await prisma.salesLeadAssignment.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found in this workspace' });
    return;
  }

  const result = await deleteContactsAndLinkedLeadsTransactional(tenantId, {
    leadIds: [existing.id],
  });

  res.json({
    success: true,
    message: 'Lead and linked contact deleted successfully',
    deletedLeadId: existing.id,
    deletedContactId: result.deletedContactId,
    data: {
      deletedLeadId: existing.id,
      deletedContactId: result.deletedContactId,
    },
    error: null,
  });
});
const claimPoolSchema = z.object({
  assignedAgentId: z.string().min(1).optional(),
});

const inactiveLeadStages: SalesLeadStage[] = [
  'CLOSED_WON',
  'CLOSED_LOST',
  'CLOSED',
  'LOST',
  'PAID',
  'CONVERTED_FREE',
  'RECYCLED',
];

class PoolClaimError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function handlePoolClaim(req: Request, res: Response) {
  const tenantId = req.tenantId!;
  const poolItemId = String(req.params.poolItemId || req.params.id || '').trim();
  const parsed = claimPoolSchema.safeParse(req.body ?? {});

  if (!poolItemId) {
    res.status(400).json({ success: false, error: 'ValidationError', message: 'Pool item id is required' });
    return;
  }

  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'ValidationError', message: parsed.error.issues[0]?.message || 'Invalid claim request' });
    return;
  }

  const user = req.user!;
  const canClaim = await hasPermission(user.userId, tenantId, user.role, PERM_LEADS_CLAIM);
  if (!canClaim) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Lead claiming is not enabled for this user' });
    return;
  }

  const requestedAgentId = parsed.data.assignedAgentId;
  if (user.role === 'SALES_AGENT' && requestedAgentId) {
    const ownProfile = await prisma.salesAgentProfile.findFirst({
      where: { userId: user.userId, tenantId },
      select: { id: true },
    });
    if (!ownProfile || (requestedAgentId !== ownProfile.id && requestedAgentId !== user.userId)) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'Sales agents can only claim leads for themselves' });
      return;
    }
  }

  const profile = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      ...(user.role === 'SALES_AGENT'
        ? { userId: user.userId }
        : requestedAgentId
          ? { OR: [{ id: requestedAgentId }, { userId: requestedAgentId }] }
          : { userId: user.userId }),
    },
  });

  // `leads:claim` is the single permission source of truth. Older profiles
  // may have canClaimLeads=false while the admin has granted the granular
  // permission, so do not reject those users a second time here.
  if (!profile || profile.status !== 'ACTIVE') {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Only active sales closers with lead-claim access can claim leads' });
    return;
  }

  const activeLeadCount = await prisma.salesLeadAssignment.count({
    where: {
      tenantId,
      assignedAgentId: profile.id,
      stage: { notIn: inactiveLeadStages },
    },
  });
  const maxActiveLeads = profile.maxActiveLeads && profile.maxActiveLeads > 0 ? profile.maxActiveLeads : 10;
  if (activeLeadCount >= maxActiveLeads) {
    res.status(409).json({
      success: false,
      error: 'LeadQuotaReached',
      message: `This closer already has ${activeLeadCount} of ${maxActiveLeads} allowed active leads`,
      data: { activeLeadCount, maxActiveLeads },
    });
    return;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const poolItem = await tx.salesLeadPoolItem.findFirst({
        where: { id: poolItemId, tenantId },
        include: { convertedAssignment: true },
      });

      if (!poolItem) throw new PoolClaimError(404, 'NotFound', 'Lead pool item was not found in this workspace');

      if (poolItem.status !== 'OPEN') {
        if (poolItem.claimedByAgentId === profile.id && poolItem.convertedAssignment) {
          return { poolItem, lead: poolItem.convertedAssignment, deduplicated: false, idempotent: true };
        }
        throw new PoolClaimError(409, 'AlreadyClaimed', 'This lead has already been claimed');
      }

      if (poolItem.assignedAgentId && poolItem.assignedAgentId !== profile.id) {
        throw new PoolClaimError(409, 'ReservedForAnotherCloser', 'This lead is reserved for another closer');
      }

      const rawPhone = poolItem.customerPhone?.trim() || '';
      const phoneDigits = rawPhone.replace(/\D/g, '');
      const last10 = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : phoneDigits;
      const duplicateFilters: Array<Record<string, unknown>> = [];
      if (rawPhone) duplicateFilters.push({ customerPhone: rawPhone });
      if (last10.length >= 7) duplicateFilters.push({ customerPhone: { contains: last10 } });
      if (poolItem.customerEmail) duplicateFilters.push({ customerEmail: poolItem.customerEmail });

      const existingLead = duplicateFilters.length
        ? await tx.salesLeadAssignment.findFirst({
            where: { tenantId, OR: duplicateFilters },
            orderBy: { createdAt: 'asc' },
          })
        : null;

      if (existingLead && existingLead.assignedAgentId !== profile.id) {
        throw new PoolClaimError(409, 'LeadAlreadyAssigned', 'This customer already belongs to another closer in this workspace');
      }

      const reserved = await tx.salesLeadPoolItem.updateMany({
        where: { id: poolItem.id, tenantId, status: 'OPEN' },
        data: { status: 'CLAIMED', claimedByAgentId: profile.id, claimedAt: new Date() },
      });
      if (reserved.count !== 1) throw new PoolClaimError(409, 'AlreadyClaimed', 'This lead has already been claimed');

      const lead = existingLead ?? await tx.salesLeadAssignment.create({
        data: {
          tenantId,
          assignedAgentId: profile.id,
          createdById: user.userId,
          customerName: poolItem.customerName,
          customerPhone: poolItem.customerPhone,
          customerEmail: poolItem.customerEmail,
          source: poolItem.source,
          serviceInterest: poolItem.serviceInterest,
          segment: poolItem.segment,
          priority: poolItem.priority,
          budgetAmount: poolItem.budgetAmount,
          stage: 'NEW',
          notes: poolItem.notes,
          conversationId: poolItem.conversationId,
        },
      });

      await tx.salesLeadPoolItem.update({
        where: { id: poolItem.id },
        data: {
          status: 'CLAIMED',
          claimedByAgentId: profile.id,
          convertedAssignmentId: lead.id,
          claimedAt: new Date(),
        },
      });

      await tx.salesActivityLog.create({
        data: {
          tenantId,
          assignmentId: lead.id,
          actorUserId: user.userId,
          action: existingLead ? 'LEAD_POOL_DEDUPLICATED' : 'LEAD_CLAIMED',
          note: existingLead
            ? 'Queue item linked to the existing tenant lead instead of creating a duplicate.'
            : 'Lead claimed from the shared pool.',
        },
      });

      const updatedPoolItem = await tx.salesLeadPoolItem.findUniqueOrThrow({ where: { id: poolItem.id } });
      return { poolItem: updatedPoolItem, lead, deduplicated: Boolean(existingLead), idempotent: false };
    });

    await persistApiRealtimeEvent({
      tenantId,
      eventType: 'lead.claimed',
      payload: {
        id: result.lead.id,
        poolItemId,
        assignedAgentId: profile.id,
        agentCode: profile.agentCode,
        deduplicated: result.deduplicated,
      },
      actorUserId: user.userId,
    }).catch(() => undefined);

    // Sync mirrored marketing contact with newly assigned lead
    await syncMarketingContactForLead(result.lead).catch(() => undefined);

    res.json({ success: true, data: result, message: result.idempotent ? 'Lead was already claimed by this closer' : 'Lead claimed successfully', error: null });
  } catch (error: unknown) {
    if (error instanceof PoolClaimError) {
      res.status(error.status).json({ success: false, error: error.code, message: error.message });
      return;
    }
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      res.status(409).json({ success: false, error: 'DuplicateLead', message: 'This customer already exists in the workspace' });
      return;
    }
    throw error;
  }
}

// Canonical pool-item claim route. The shorter path remains a compatibility alias,
// and both routes deliberately reuse the same handler/business transaction.
leadsRouter.post('/pool/:poolItemId/claim', handlePoolClaim);
leadsRouter.post('/:poolItemId/claim', handlePoolClaim);

// GET /:id/notes - Get internal notes for a lead
leadsRouter.get('/:id/notes', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const entries = await prisma.salesLeadTimelineEntry.findMany({
    // Keep follow-up/task entries in the 360 history stream, not in notes.
    where: { leadId: check.lead.id, tenantId, type: 'NOTE' },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    success: true,
    data: {
      notes: entries,
      timelineNotes: entries,
      summaryNotes: check.lead.notes || '',
    },
    error: null,
  });
});

// POST /:id/notes - Add an internal note to a lead
leadsRouter.post('/:id/notes', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { body } = req.body as { body: string };

  if (!body || !body.trim()) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'Note content cannot be empty' });
    return;
  }

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const entry = await prisma.salesLeadTimelineEntry.create({
    data: {
      tenantId,
      leadId: check.lead.id,
      type: 'NOTE',
      body: body.trim(),
      userId: req.user?.userId,
    },
  });

  res.status(201).json({ success: true, data: entry });
});

// PATCH /:id/notes/:noteId - Edit a timeline note
leadsRouter.patch('/:id/notes/:noteId', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const noteId = String(req.params.noteId);
  const { body } = req.body as { body?: string };

  if (!body || !body.trim()) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'Note content cannot be empty' });
    return;
  }

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const existingNote = await prisma.salesLeadTimelineEntry.findFirst({
    where: { id: noteId, leadId: check.lead.id, tenantId },
  });

  if (!existingNote) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Note not found' });
    return;
  }

  if (req.user?.role === 'SALES_AGENT' && existingNote.userId && existingNote.userId !== req.user.userId) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Cannot edit a note created by another user' });
    return;
  }

  const updated = await prisma.salesLeadTimelineEntry.update({
    where: { id: noteId },
    data: { body: body.trim() },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: check.lead.id,
      actorUserId: req.user?.userId,
      action: 'NOTE_UPDATED',
      note: 'Lead note updated',
      metadata: { noteId, previousBody: existingNote.body, body: updated.body },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: 'Note updated successfully', data: updated });
});

// DELETE /:id/notes/:noteId - Delete a timeline note
leadsRouter.delete('/:id/notes/:noteId', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const noteId = String(req.params.noteId);

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const existingNote = await prisma.salesLeadTimelineEntry.findFirst({
    where: { id: noteId, leadId: check.lead.id, tenantId },
  });

  if (!existingNote) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Note not found' });
    return;
  }

  if (req.user?.role === 'SALES_AGENT' && existingNote.userId && existingNote.userId !== req.user.userId) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Cannot delete a note created by another user' });
    return;
  }

  await prisma.salesLeadTimelineEntry.delete({
    where: { id: noteId },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: check.lead.id,
      actorUserId: req.user?.userId,
      action: 'NOTE_DELETED',
      note: 'Lead note deleted',
      metadata: { noteId, body: existingNote.body },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: 'Note deleted successfully', data: { deletedNoteId: noteId } });
});

// GET /:id/tasks - Get tasks for a lead
leadsRouter.get('/:id/tasks', async (req: Request, res: Response) => {
  const id = String(req.params.id);

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const tasks = await prisma.gxLeadTask.findMany({
    where: { salesLeadId: check.lead.id },
    orderBy: { dueAt: 'asc' },
  });

  res.json({ success: true, data: tasks });
});

// POST /:id/tasks - Create task for a lead
leadsRouter.post('/:id/tasks', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { title, description, dueAt, priority } = req.body as {
    title: string;
    description?: string;
    dueAt: string;
    priority?: string;
  };

  if (!title || !dueAt) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'Title and due date are required' });
    return;
  }

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const task = await prisma.gxLeadTask.create({
    data: {
      salesLeadId: check.lead.id,
      createdById: req.user?.userId,
      title: title.trim(),
      description: description?.trim(),
      dueAt: new Date(dueAt),
      priority: (priority || 'NORMAL').toUpperCase(),
      status: 'OPEN',
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: check.lead.tenantId,
      assignmentId: check.lead.id,
      actorUserId: req.user?.userId,
      action: 'FOLLOW_UP_CREATED',
      note: `Follow-up created: ${task.title}`,
      metadata: { taskId: task.id, dueAt: task.dueAt, priority: task.priority },
    },
  }).catch(() => undefined);

  res.status(201).json({ success: true, data: task });
});

// PATCH /:id/tasks/:taskId - Update task status, reschedule, or edit details
leadsRouter.patch('/:id/tasks/:taskId', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const taskId = String(req.params.taskId);
  const { status, title, description, dueAt, priority } = req.body as {
    status?: string;
    title?: string;
    description?: string;
    dueAt?: string;
    priority?: string;
  };

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const existingTask = await prisma.gxLeadTask.findFirst({
    where: { id: taskId, salesLeadId: check.lead.id },
  });
  if (!existingTask) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Task not found on this lead' });
    return;
  }

  const task = await prisma.gxLeadTask.update({
    where: { id: taskId },
    data: {
      ...(status !== undefined ? {
        status: status.toUpperCase(),
        completedAt: status.toUpperCase() === 'DONE' ? new Date() : null,
      } : {}),
      ...(title !== undefined ? { title: title.trim() } : {}),
      ...(description !== undefined ? { description: description.trim() } : {}),
      ...(dueAt !== undefined ? { dueAt: new Date(dueAt) } : {}),
      ...(priority !== undefined ? { priority: priority.toUpperCase() } : {}),
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: check.lead.tenantId,
      assignmentId: check.lead.id,
      actorUserId: req.user?.userId,
      action: 'FOLLOW_UP_UPDATED',
      note: `Follow-up ${task.title} updated to ${task.status}`,
      metadata: { taskId: task.id, previousStatus: existingTask.status, status: task.status },
    },
  }).catch(() => undefined);

  res.json({ success: true, data: task });
});

// DELETE /:id/tasks/:taskId - Delete a task
leadsRouter.delete('/:id/tasks/:taskId', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const taskId = String(req.params.taskId);

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const existingTask = await prisma.gxLeadTask.findFirst({
    where: { id: taskId, salesLeadId: check.lead.id },
  });
  if (!existingTask) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Task not found on this lead' });
    return;
  }

  await prisma.gxLeadTask.delete({
    where: { id: taskId },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: check.lead.tenantId,
      assignmentId: check.lead.id,
      actorUserId: req.user?.userId,
      action: 'FOLLOW_UP_DELETED',
      note: `Follow-up deleted: ${existingTask.title}`,
      metadata: { taskId, dueAt: existingTask.dueAt, status: existingTask.status },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: 'Task deleted successfully' });
});

// GET /api/v1/leads/delta - High-efficiency delta sync for mobile and web offline sync
leadsRouter.get('/delta', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const since = req.query.since ? String(req.query.since) : undefined;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));

  const where: any = { tenantId };

  if (since) {
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) {
      where.updatedAt = { gt: sinceDate };
    }
  }

  // Closer scoping
  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    where.assignedAgentId = profile?.id ?? '__NO_ACCESS__';
  }

  const rows = await prisma.salesLeadAssignment.findMany({
    where,
    take: limit + 1,
    orderBy: { updatedAt: 'asc' },
    include: {
      assignedAgent: {
        select: {
          id: true,
          agentCode: true,
          user: { select: { displayName: true } },
        },
      },
    },
  });

  const hasMore = rows.length > limit;
  const leads = hasMore ? rows.slice(0, limit) : rows;
  const lastLead = leads[leads.length - 1];
  const nextSyncCursor = lastLead?.updatedAt?.toISOString() || since || new Date().toISOString();

  res.json({
    success: true,
    data: {
      leads,
      hasMore,
      nextSyncCursor,
      count: leads.length,
      serverTime: new Date().toISOString(),
    },
    error: null,
  });
});


const reassignLeadSchema = z.object({
  assignedAgentId: z.string().min(1, 'Target assignedAgentId is required'),
  reason: z.string().optional(),
});

// POST /:id/reassign - Dedicated lead reassignment endpoint
leadsRouter.post('/:id/reassign', requirePermissions(PERM_LEADS_REASSIGN), validateBody(reassignLeadSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { assignedAgentId, reason } = req.body as z.infer<typeof reassignLeadSchema>;

  const lead = await prisma.salesLeadAssignment.findUnique({
    where: { id },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found in this workspace' });
    return;
  }

  if (lead.tenantId !== tenantId) {
    res.status(403).json({
      success: false,
      code: 'TENANT_ISOLATION_VIOLATION',
      error: 'TenantIsolationViolation',
      message: 'Cross-tenant reassignment is strictly prohibited: lead belongs to another workspace',
    });
    return;
  }

  // Resolve target agent profile
  const targetAgent = await prisma.salesAgentProfile.findFirst({
    where: {
      OR: [
        { id: assignedAgentId },
        { userId: assignedAgentId },
      ],
    },
    include: { user: { select: { id: true, displayName: true, role: true } } },
  });

  if (!targetAgent) {
    res.status(404).json({
      success: false,
      code: 'AGENT_NOT_IN_WORKSPACE',
      error: 'AgentNotInWorkspace',
      message: 'Target agent not found in workspace',
    });
    return;
  }

  if (targetAgent.tenantId !== tenantId) {
    res.status(403).json({
      success: false,
      code: 'TENANT_ISOLATION_VIOLATION',
      error: 'TenantIsolationViolation',
      message: 'Target agent belongs to a different workspace',
    });
    return;
  }

  if (targetAgent.status !== 'ACTIVE') {
    res.status(400).json({
      success: false,
      code: 'AGENT_NOT_ACTIVE',
      error: 'AgentNotActive',
      message: `Target agent is not active (status: ${targetAgent.status}). Only ACTIVE agents can be assigned.`,
    });
    return;
  }

  if (targetAgent.user.role === 'ADMIN' || targetAgent.user.role === 'SUPER_ADMIN') {
    res.status(400).json({
      success: false,
      code: 'AGENT_NOT_ACTIVE',
      error: 'InvalidTargetRole',
      message: 'Administrators and Super Admins cannot be assigned leads. Target must be a sales agent or closer.',
    });
    return;
  }

  // Idempotent duplicate check
  if (lead.assignedAgentId === targetAgent.id) {
    res.status(200).json({
      success: true,
      code: 'DUPLICATE_ASSIGNMENT',
      message: `Lead is already assigned to ${targetAgent.user.displayName || targetAgent.agentCode} (idempotent)`,
      data: {
        id: lead.id,
        assignedAgentId: targetAgent.id,
        agentCode: targetAgent.agentCode,
        idempotent: true,
      },
      error: null,
    });
    return;
  }

  const updated = await prisma.salesLeadAssignment.update({
    where: { id: lead.id },
    data: {
      assignedAgentId: targetAgent.id,
      updatedAt: new Date(),
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: lead.id,
      actorUserId: req.user?.userId,
      action: 'LEAD_REASSIGNED',
      note: `Lead reassigned to ${targetAgent.user.displayName || targetAgent.agentCode}${reason ? ': ' + reason : ''}`,
      metadata: { previousAgentId: lead.assignedAgentId, newAgentId: targetAgent.id, reason },
    },
  }).catch(() => undefined);

  // Symmetrically sync linked MarketingContact with new assignee
  const normPhone = normalizeLeadPhone(lead.customerPhone);
  await prisma.marketingContact.updateMany({
    where: {
      tenantId,
      OR: [
        { leadId: lead.id },
        ...(normPhone ? [{ e164Phone: normPhone }] : []),
      ],
    },
    data: {
      assignedAgentId: targetAgent.id,
      updatedAt: new Date(),
    },
  }).catch(() => undefined);

  await persistApiRealtimeEvent({
    tenantId,
    actorUserId: req.user?.userId,
    audienceRoles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SALES_AGENT'],
    eventType: 'lead.reassigned',
    payload: { id: lead.id, assignedAgentId: targetAgent.id, agentCode: targetAgent.agentCode },
  }).catch(() => undefined);

  res.json({
    success: true,
    data: updated,
    message: `Lead successfully reassigned to ${targetAgent.user.displayName || targetAgent.agentCode}`,
  });
});

// POST /bulk-reassign - Dedicated bulk lead reassignment endpoint
const bulkReassignSchema = z.object({
  leadIds: z.array(z.string().min(1)).min(1, 'Provide at least one lead ID to reassign'),
  assignedAgentId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  reason: z.string().optional(),
}).refine((d) => Boolean(d.assignedAgentId || d.agentId), {
  message: 'Target assignedAgentId or agentId is required',
  path: ['assignedAgentId'],
});

leadsRouter.post('/bulk-reassign', requirePermissions(PERM_LEADS_REASSIGN), validateBody(bulkReassignSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body as z.infer<typeof bulkReassignSchema>;
  const rawTargetAgentId = (body.assignedAgentId || body.agentId)!.trim();

  // Resolve target agent profile in this workspace
  const targetAgent = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      OR: [
        { id: rawTargetAgentId },
        { userId: rawTargetAgentId },
      ],
    },
    include: { user: { select: { id: true, displayName: true, role: true } } },
  });

  if (!targetAgent) {
    res.status(404).json({
      success: false,
      code: 'AGENT_NOT_IN_WORKSPACE',
      error: 'AgentNotInWorkspace',
      message: 'Target agent not found in workspace',
    });
    return;
  }

  if (targetAgent.status !== 'ACTIVE') {
    res.status(400).json({
      success: false,
      code: 'AGENT_NOT_ACTIVE',
      error: 'AgentNotActive',
      message: `Target agent is not active (status: ${targetAgent.status}). Only ACTIVE agents can be assigned.`,
    });
    return;
  }

  if (targetAgent.user.role === 'ADMIN' || targetAgent.user.role === 'SUPER_ADMIN') {
    res.status(400).json({
      success: false,
      code: 'INVALID_TARGET_ROLE',
      error: 'InvalidTargetRole',
      message: 'Administrators and Super Admins cannot be assigned leads. Target must be a sales closer.',
    });
    return;
  }

  // Find all matching leads strictly within this tenant
  const validLeads = await prisma.salesLeadAssignment.findMany({
    where: {
      tenantId,
      id: { in: body.leadIds },
    },
    select: { id: true, customerPhone: true, customerName: true, assignedAgentId: true },
  });

  if (validLeads.length === 0) {
    res.status(404).json({
      success: false,
      error: 'NotFound',
      message: 'No matching leads found in workspace to reassign',
    });
    return;
  }

  const validLeadIds = validLeads.map((l) => l.id);
  const phones = validLeads
    .map((l) => normalizeLeadPhone(l.customerPhone))
    .filter((p): p is string => Boolean(p));

  // Perform bulk reassignment in a transaction
  await prisma.$transaction(async (tx) => {
    // 1. Reassign SalesLeadAssignment records
    await tx.salesLeadAssignment.updateMany({
      where: {
        tenantId,
        id: { in: validLeadIds },
      },
      data: {
        assignedAgentId: targetAgent.id,
        updatedAt: new Date(),
      },
    });

    // 2. Reassign mirrored MarketingContact records
    const contactOrConditions: Array<Record<string, unknown>> = [{ leadId: { in: validLeadIds } }];
    if (phones.length > 0) {
      contactOrConditions.push({ e164Phone: { in: phones } });
    }
    await tx.marketingContact.updateMany({
      where: {
        tenantId,
        OR: contactOrConditions,
      },
      data: {
        assignedAgentId: targetAgent.id,
        updatedAt: new Date(),
      },
    });

    // 3. Activity logs for all reassigned leads
    for (const lead of validLeads) {
      await tx.salesActivityLog.create({
        data: {
          tenantId,
          assignmentId: lead.id,
          actorUserId: req.user?.userId,
          action: 'LEAD_REASSIGNED',
          note: `Lead reassigned to ${targetAgent.user.displayName || targetAgent.agentCode}${body.reason ? ': ' + body.reason : ''}`,
          metadata: { previousAgentId: lead.assignedAgentId, newAgentId: targetAgent.id, reason: body.reason, isBulk: true },
        },
      });
    }
  });

  // Emit realtime events
  for (const lead of validLeads) {
    await persistApiRealtimeEvent({
      tenantId,
      actorUserId: req.user?.userId,
      audienceRoles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SALES_AGENT'],
      eventType: 'lead.reassigned',
      payload: { id: lead.id, assignedAgentId: targetAgent.id, agentCode: targetAgent.agentCode },
    }).catch(() => undefined);
  }

  res.json({
    success: true,
    message: `Successfully reassigned ${validLeadIds.length} lead(s) to ${targetAgent.user.displayName || targetAgent.agentCode}`,
    data: {
      reassignedLeadIds: validLeadIds,
      assignedAgentId: targetAgent.id,
      agentCode: targetAgent.agentCode,
      count: validLeadIds.length,
    },
    error: null,
  });
});




// ==========================================
// Unified Lead Import & Multi-Source Ingestion
// ==========================================

const unifiedImportSchema = z.object({
  source: z.string().default('CSV'),
  rows: z.array(
    z.object({
      customerName: z.string().min(1, 'Customer name is required'),
      customerPhone: z.string().optional(),
      customerEmail: z.string().optional(),
      serviceInterest: z.string().optional(),
      budgetAmount: z.number().optional(),
      notes: z.string().optional(),
      customFields: z.record(z.any()).optional(),
    })
  ).min(1, 'Provide at least one row to import'),
  distributionMode: z.enum(['AUTO', 'ROUND_ROBIN', 'POOL', 'MANUAL']).default('AUTO'),
  duplicateAction: z.enum(['SKIP', 'UPDATE', 'OVERWRITE']).default('SKIP'),
});

// POST /import - Unified Lead Import for CSV, Excel, WhatsApp, Google Sheets
leadsRouter.post('/import', requirePermissions(PERM_LEADS_REASSIGN), validateBody(unifiedImportSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { source, rows, duplicateAction } = req.body;
  const upperSource = source.toUpperCase().trim();

  let createdCount = 0;
  let updatedCount = 0;
  let skippedDuplicates = 0;
  const sampleAssignments: Array<{ leadId: string; customerName: string; stage: string; assignedAgentId: string | null }> = [];

  // Fetch a fallback profile for required assignedAgentId field
  const fallbackAgent = await prisma.salesAgentProfile.findFirst({
    where: { tenantId, status: 'ACTIVE', user: { role: 'SALES_AGENT', packageStatus: 'ACTIVE' } },
  }) || await prisma.salesAgentProfile.findFirst({ where: { tenantId } });

  if (!fallbackAgent) {
    res.status(409).json({ success: false, error: 'NoAgentProfiles', message: 'No agent profile found in workspace to attach leads' });
    return;
  }

  for (const row of rows) {
    const res = await upsertCompanyLead({
      tenantId,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      customerEmail: row.customerEmail,
      serviceInterest: row.serviceInterest,
      budgetAmount: row.budgetAmount,
      notes: row.notes,
      customFields: row.customFields,
      source: upperSource,
      duplicateAction: duplicateAction as any,
      actorUserId: req.user?.userId,
    });

    if (res.wasCreated) createdCount++;
    else if (res.wasUpdated) updatedCount++;
    else skippedDuplicates++;

    if (sampleAssignments.length < 10 && res.lead) {
      sampleAssignments.push({
        leadId: res.lead.id,
        customerName: res.lead.customerName,
        stage: res.lead.stage,
        assignedAgentId: res.lead.assignedAgentId,
      });
    }
  }

  res.status(201).json({
    success: true,
    message: `Import complete: ${createdCount} created, ${updatedCount} updated, ${skippedDuplicates} duplicates skipped`,
    data: {
      source: upperSource,
      totalRows: rows.length,
      createdCount,
      updatedCount,
      skippedDuplicates,
      sampleAssignments,
    },
    error: null,
  });
});

// POST /import/google-sheets - Google Sheets lead ingestion
const googleSheetsImportSchema = z.object({
  spreadsheetUrl: z.string().optional(),
  sheetRows: z.array(z.record(z.any())).optional(),
  distributionMode: z.enum(['AUTO', 'ROUND_ROBIN', 'POOL', 'MANUAL']).default('AUTO'),
});

leadsRouter.post('/import/google-sheets', requirePermissions(PERM_LEADS_REASSIGN), validateBody(googleSheetsImportSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { spreadsheetUrl, sheetRows } = req.body;

  let rowsToIngest: Array<any> = [];

  if (Array.isArray(sheetRows) && sheetRows.length > 0) {
    rowsToIngest = sheetRows.map((r) => ({
      customerName: r.name || r.customerName || r['Client Name'] || r['Full Name'] || 'Inbound Lead',
      customerPhone: r.phone || r.customerPhone || r['Phone'] || r['Mobile'] || r['Contact Number'],
      customerEmail: r.email || r.customerEmail || r['Email'],
      serviceInterest: r.service || r.serviceInterest || r['Service'] || r['Requirement'],
      notes: r.notes || r['Notes'] || r['Remarks'] || 'Imported from Google Sheets',
    }));
  } else if (spreadsheetUrl) {
    // If public Google Sheet URL provided, fetch CSV export
    try {
      let exportUrl = spreadsheetUrl;
      const match = spreadsheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (match) {
        exportUrl = `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv`;
      }

      const fetchRes = await fetch(exportUrl);
      if (fetchRes.ok) {
        const csvText = await fetchRes.text();
        const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 1) {
          const headers = lines[0].split(',').map((h) => h.replace(/"/g, '').trim().toLowerCase());
          const nameIdx = headers.findIndex((h) => h.includes('name'));
          const phoneIdx = headers.findIndex((h) => h.includes('phone') || h.includes('mobile'));
          const emailIdx = headers.findIndex((h) => h.includes('email'));

          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map((c) => c.replace(/"/g, '').trim());
            if (cols.length > 0) {
              rowsToIngest.push({
                customerName: nameIdx >= 0 ? cols[nameIdx] : `Lead #${i}`,
                customerPhone: phoneIdx >= 0 ? cols[phoneIdx] : null,
                customerEmail: emailIdx >= 0 ? cols[emailIdx] : null,
                notes: 'Imported from Google Sheet ' + spreadsheetUrl.slice(0, 50),
              });
            }
          }
        }
      }
    } catch (err) {
      logger.warn('Failed to fetch public Google Sheets export URL', { error: String(err) });
    }
  }

  if (rowsToIngest.length === 0) {
    res.status(400).json({
      success: false,
      error: 'NoData',
      message: 'No valid lead rows found in sheet payload or provided Google Sheets URL',
    });
    return;
  }

  // Forward to internal import processing
  const fallbackAgent = await prisma.salesAgentProfile.findFirst({
    where: { tenantId, status: 'ACTIVE', user: { role: 'SALES_AGENT' } },
  }) || await prisma.salesAgentProfile.findFirst({ where: { tenantId } });

  let createdCount = 0;
  for (const row of rowsToIngest) {
    const rawPhone = String(row.customerPhone || '').replace(/\D/g, '');
    const normalizedPhone = rawPhone.length === 10 ? `+91${rawPhone}` : (rawPhone ? `+${rawPhone}` : null);

    const lead = await prisma.salesLeadAssignment.create({
      data: {
        tenantId,
        assignedAgentId: fallbackAgent ? fallbackAgent.id : '__UNASSIGNED__',
        createdById: req.user?.userId,
        customerName: row.customerName,
        customerPhone: normalizedPhone,
        customerEmail: row.customerEmail,
        source: 'GOOGLE_SHEETS',
        notes: row.notes || 'Google Sheets Lead',
        stage: 'NEW',
      },
    });

    await assignLeadToNextCloser({
      tenantId,
      leadId: lead.id,
      source: 'GOOGLE_SHEETS',
      actorUserId: req.user?.userId,
    }).catch(() => undefined);

    createdCount++;
  }

  res.status(201).json({
    success: true,
    message: `Successfully ingested ${createdCount} leads from Google Sheets`,
    data: { createdCount, source: 'GOOGLE_SHEETS' },
    error: null,
  });
});

// POST /intake/email - Inbound email enquiry ingestion
const emailIntakeSchema = z.object({
  senderEmail: z.string().email('Valid sender email required'),
  senderName: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().min(1, 'Email body is required'),
  extractedPhone: z.string().optional(),
  serviceInterest: z.string().optional(),
});

leadsRouter.post('/intake/email', validateBody(emailIntakeSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { senderEmail, senderName, subject, body, extractedPhone, serviceInterest } = req.body;

  const fallbackAgent = await prisma.salesAgentProfile.findFirst({
    where: { tenantId, status: 'ACTIVE', user: { role: 'SALES_AGENT' } },
  }) || await prisma.salesAgentProfile.findFirst({ where: { tenantId } });

  const rawPhone = String(extractedPhone || '').replace(/\D/g, '');
  const normalizedPhone = rawPhone.length === 10 ? `+91${rawPhone}` : (rawPhone ? `+${rawPhone}` : null);

  const lead = await prisma.salesLeadAssignment.create({
    data: {
      tenantId,
      assignedAgentId: fallbackAgent ? fallbackAgent.id : '__UNASSIGNED__',
      customerName: senderName || senderEmail.split('@')[0],
      customerEmail: senderEmail.toLowerCase().trim(),
      customerPhone: normalizedPhone,
      source: 'EMAIL',
      serviceInterest: serviceInterest || subject || 'Email Inquiry',
      notes: `Subject: ${subject || 'No subject'}\n\n${body.slice(0, 300)}`,
      stage: 'NEW',
    },
  });

  const assignment = await assignLeadToNextCloser({
    tenantId,
    leadId: lead.id,
    source: 'EMAIL',
    actorUserId: req.user?.userId,
  });

  res.status(201).json({
    success: true,
    message: 'Email enquiry successfully ingested into lead pipeline',
    data: {
      leadId: lead.id,
      stage: assignment.stage,
      assignedAgentId: assignment.assignedAgentId,
      source: 'EMAIL',
    },
    error: null,
  });
});

// POST /intake/webhook/:sourceKey - Generic intake webhook (IndiaMART, Justdial, Facebook Ads, Google Ads)
leadsRouter.post('/intake/webhook/:sourceKey', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const sourceKey = String(req.params.sourceKey || 'WEBHOOK').toUpperCase();
  const body = req.body || {};

  // Extract common lead properties regardless of vendor payload structure
  const customerName = body.customerName || body.name || body.sender_name || body.full_name || body.ContactName || 'Online Inbound Lead';
  const customerPhone = body.customerPhone || body.phone || body.mobile || body.sender_mobile || body.MobileNo || body.phone_number;
  const customerEmail = body.customerEmail || body.email || body.sender_email || body.Email;
  const query = body.query || body.requirement || body.subject || body.message || body.service || '';

  const rawPhone = String(customerPhone || '').replace(/\D/g, '');
  const normalizedPhone = rawPhone.length === 10 ? `+91${rawPhone}` : (rawPhone ? `+${rawPhone}` : null);

  const fallbackAgent = await prisma.salesAgentProfile.findFirst({
    where: { tenantId, status: 'ACTIVE', user: { role: 'SALES_AGENT' } },
  }) || await prisma.salesAgentProfile.findFirst({ where: { tenantId } });

  const lead = await prisma.salesLeadAssignment.create({
    data: {
      tenantId,
      assignedAgentId: fallbackAgent ? fallbackAgent.id : '__UNASSIGNED__',
      customerName,
      customerPhone: normalizedPhone,
      customerEmail: customerEmail ? String(customerEmail).toLowerCase().trim() : null,
      source: sourceKey,
      serviceInterest: query ? String(query).slice(0, 100) : sourceKey,
      notes: `Inbound lead from ${sourceKey}: "${String(query).slice(0, 250)}"`,
      stage: 'NEW',
    },
  });

  const assignment = await assignLeadToNextCloser({
    tenantId,
    leadId: lead.id,
    source: sourceKey,
  });

  res.status(201).json({
    success: true,
    message: `Lead ingested from ${sourceKey} webhook`,
    data: {
      leadId: lead.id,
      stage: assignment.stage,
      assignedAgentId: assignment.assignedAgentId,
      source: sourceKey,
    },
    error: null,
  });
});

// GET /whatsapp-desktop/status & POST /whatsapp-desktop/sync
leadsRouter.get('/whatsapp-desktop/status', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const [channel, activeSessions, totalConversations, totalContacts] = await Promise.all([
    prisma.whatsAppChannel.findFirst({
      where: { tenantId },
      select: { status: true, displayPhoneNumber: true, verifiedName: true, lastSyncedAt: true, phoneNumberId: true },
    }),
    prisma.appClientSession.count({
      where: { tenantId, status: 'ACTIVE' },
    }),
    prisma.appConversation.count({ where: { tenantId, serviceSlug: 'whatsapp' } }),
    prisma.marketingContact.count({ where: { tenantId } }),
  ]);

  const clientStatus = channel ? channel.status : (activeSessions > 0 ? 'CONNECTED' : 'NOT_CONFIGURED');

  res.json({
    success: true,
    data: {
      clientStatus,
      isConfigured: Boolean(channel),
      phoneNumber: channel?.displayPhoneNumber || null,
      verifiedName: channel?.verifiedName || null,
      sessionName: 'WhatsApp Linked Device Desktop Gateway',
      totalSyncedChats: totalConversations,
      totalSyncedContacts: totalContacts,
      lastSyncHeartbeat: channel?.lastSyncedAt?.toISOString() || new Date().toISOString(),
      qrScanRequired: clientStatus !== 'ACTIVE' && clientStatus !== 'CONNECTED',
    },
    error: null,
  });
});

leadsRouter.post('/whatsapp-desktop/sync', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { contacts = [] } = req.body;

  let ingested = 0;
  for (const c of contacts) {
    const rawPhone = String(c.phone || c.jid || '').replace(/\D/g, '');
    if (!rawPhone) continue;
    const normalizedPhone = rawPhone.length === 10 ? `+91${rawPhone}` : `+${rawPhone}`;

    await prisma.marketingContact.upsert({
      where: {
        tenantId_e164Phone: {
          tenantId,
          e164Phone: normalizedPhone,
        },
      },
      create: {
        tenantId,
        fullName: c.name || normalizedPhone,
        e164Phone: normalizedPhone,
        source: 'WHATSAPP_DESKTOP',
      },
      update: {
        fullName: c.name || undefined,
      },
    }).catch(() => undefined);
    ingested++;
  }

  res.json({
    success: true,
    message: `Synced ${ingested} WhatsApp desktop contacts`,
    data: { ingestedCount: ingested },
    error: null,
  });
});
