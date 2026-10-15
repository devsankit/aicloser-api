import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { SalesLeadStage } from '@prisma/client';
import { persistApiRealtimeEvent } from '../../lib/realtime.js';

export const leadsRouter = Router();

// Apply auth and tenant isolation to all lead routes
leadsRouter.use(authenticate, enforceTenantIsolation);

const listLeadsQuerySchema = z.object({
  page: z.string().optional().transform((v) => (v ? Math.max(1, Number(v)) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, Math.max(1, Number(v))) : 25)),
  stage: z.nativeEnum(SalesLeadStage).optional(),
  search: z.string().optional(),
  assignedAgentId: z.string().optional(),
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

  // Strict closer scoping: SALES_AGENT can only see their own assigned leads
  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    where.assignedAgentId = profile?.id ?? '__NO_ACCESS__';
  } else if (assignedAgentId) {
    where.assignedAgentId = assignedAgentId;
  }

  if (search) {
    where.OR = [
      { customerName: { contains: search, mode: 'insensitive' } },
      { customerPhone: { contains: search } },
      { customerEmail: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, leads] = await Promise.all([
    prisma.salesLeadAssignment.count({ where }),
    prisma.salesLeadAssignment.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
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

  res.json({
    success: true,
    data: leads,
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
  stage: z.nativeEnum(SalesLeadStage).default('NEW'),
  budgetAmount: z.number().optional(),
});

leadsRouter.post('/', validateBody(createLeadSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body;

  // Verify that the assigned agent belongs to the same tenant
  const agent = await prisma.salesAgentProfile.findFirst({
    where: { id: body.assignedAgentId, tenantId },
  });

  if (!agent) {
    res.status(400).json({
      success: false,
      error: 'InvalidAgent',
      message: 'Assigned agent does not exist within your workspace',
    });
    return;
  }

  const lead = await prisma.salesLeadAssignment.create({
    data: {
      tenantId, // Root ownership strictly enforced
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      customerEmail: body.customerEmail,
      assignedAgentId: body.assignedAgentId,
      createdById: req.user?.userId,
      serviceInterest: body.serviceInterest,
      segment: body.segment,
      priority: body.priority,
      notes: body.notes,
      stage: body.stage,
      budgetAmount: body.budgetAmount,
    },
  });

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

  const aggregates = await prisma.salesLeadAssignment.groupBy({
    by: ['stage'],
    where: { tenantId },
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

// GET /pool - Unassigned leads in the Grab Pool
leadsRouter.get('/pool', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const poolLeads = await prisma.salesLeadPoolItem.findMany({
    where: {
      tenantId,
      status: 'OPEN',
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


// GET /:id/360 - Unified Lead 360 view
leadsRouter.get('/:id/360', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  // 1. Strict Tenant Isolation: verify lead exists in tenant first
  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id, tenantId },
    include: {
      assignedAgent: {
        select: {
          id: true,
          agentCode: true,
          user: { select: { id: true, displayName: true, email: true, phone: true } },
        },
      },
    },
  });

  if (!lead) {
    res.status(404).json({ success: false, data: null, error: 'NotFound', message: 'Lead not found in this workspace' });
    return;
  }

  // 2. Fetch all child resources strictly isolated to this verified lead
  const [timeline, tasks, calls, customFieldsDef] = await Promise.all([
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
  ]);

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

  res.json({
    success: true,
    data: {
      lead,
      assignedAgent: lead.assignedAgent ? {
        id: lead.assignedAgent.id,
        agentCode: lead.assignedAgent.agentCode,
        displayName: lead.assignedAgent.user?.displayName,
        email: lead.assignedAgent.user?.email,
        phone: lead.assignedAgent.user?.phone,
      } : null,
      timelineNotes: timeline,
      timeline,
      tasks,
      callLogs: calls,
      calls,
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
    },
    error: null,
  });
});

leadsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const where: Record<string, unknown> = { id, tenantId };
  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    where.assignedAgentId = profile?.id ?? '__NO_ACCESS__';
  }

  const lead = await prisma.salesLeadAssignment.findFirst({
    where,
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
  stage: z.nativeEnum(SalesLeadStage).optional(),
  kanbanPosition: z.number().optional(),
  priority: z.string().optional(),
  notes: z.string().optional(),
  followUpAt: z.string().datetime().optional(),
  budgetAmount: z.number().optional(),
  assignedAgentId: z.string().optional(),
  customFields: z.record(z.unknown()).optional(),
  lostReason: z.string().optional().nullable(),
  lostReasonNotes: z.string().optional().nullable(),
  isDndActive: z.boolean().optional(),
});

leadsRouter.patch('/:id', validateBody(updateLeadSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body;

  // First verify lead exists in this tenant
  const existing = await prisma.salesLeadAssignment.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found in this workspace' });
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
      res.status(403).json({ success: false, error: 'Forbidden', message: 'Only workspace administrators can reassign leads' });
      return;
    }
  }

  // If reassigning (admin/manager), verify target agent belongs to same tenant
  if (body.assignedAgentId && body.assignedAgentId !== existing.assignedAgentId) {
    const targetAgent = await prisma.salesAgentProfile.findFirst({
      where: { id: body.assignedAgentId, tenantId },
    });
    if (!targetAgent) {
      res.status(400).json({ success: false, error: 'InvalidAgent', message: 'Target agent not in workspace' });
      return;
    }
  }

  const updated = await prisma.salesLeadAssignment.update({
    where: { id },
    data: {
      ...body,
      followUpAt: body.followUpAt ? new Date(body.followUpAt) : undefined,
    },
  });

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

  await prisma.salesLeadAssignment.delete({ where: { id } });
  res.json({ success: true, message: 'Lead deleted from workspace' });
});
// POST /:id/claim - Closer claims a lead from the Grab Pool
leadsRouter.post('/:id/claim', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const profile = await prisma.salesAgentProfile.findFirst({
    where: { userId: req.user?.userId, tenantId },
  });

  if (!profile) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Only active sales closers can claim leads' });
    return;
  }

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id, tenantId },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found' });
    return;
  }

  if (lead.assignedAgentId && lead.assignedAgentId !== profile.id) {
    res.status(409).json({ success: false, error: 'Conflict', message: 'This lead has already been claimed by another closer' });
    return;
  }

  const updated = await prisma.salesLeadAssignment.update({
    where: { id: lead.id },
    data: {
      assignedAgentId: profile.id,
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: lead.id,
      actorUserId: req.user?.userId,
      action: 'LEAD_CLAIMED',
      note: `Lead claimed from pool by ${req.user?.displayName || 'closer'}`,
    },
  });

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.claimed',
    payload: {
      id: updated.id,
      assignedAgentId: profile.id,
      agentCode: profile.agentCode,
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.json({ success: true, data: updated, message: 'Lead claimed successfully', error: null });
});

// GET /:id/notes - Get internal notes for a lead
leadsRouter.get('/:id/notes', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const [lead, entries] = await Promise.all([
    prisma.salesLeadAssignment.findFirst({
      where: { id, tenantId },
      select: { id: true, notes: true },
    }),
    prisma.salesLeadTimelineEntry.findMany({
      where: { leadId: id, tenantId },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found' });
    return;
  }

  res.json({
    success: true,
    data: {
      summaryNotes: lead.notes || '',
      timelineNotes: entries,
    },
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

  const entry = await prisma.salesLeadTimelineEntry.create({
    data: {
      tenantId,
      leadId: id,
      type: 'NOTE',
      body: body.trim(),
      userId: req.user?.userId,
    },
  });

  res.status(201).json({ success: true, data: entry });
});

// GET /:id/tasks - Get tasks for a lead
leadsRouter.get('/:id/tasks', async (req: Request, res: Response) => {
  const id = String(req.params.id);

  const tasks = await prisma.gxLeadTask.findMany({
    where: { salesLeadId: id },
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

  const task = await prisma.gxLeadTask.create({
    data: {
      salesLeadId: id,
      createdById: req.user?.userId,
      title: title.trim(),
      description: description?.trim(),
      dueAt: new Date(dueAt),
      priority: (priority || 'NORMAL').toUpperCase(),
      status: 'OPEN',
    },
  });

  res.status(201).json({ success: true, data: task });
});

// PATCH /:id/tasks/:taskId - Update task status
leadsRouter.patch('/:id/tasks/:taskId', async (req: Request, res: Response) => {
  const taskId = String(req.params.taskId);
  const { status } = req.body as { status: string };

  const task = await prisma.gxLeadTask.update({
    where: { id: taskId },
    data: {
      status: (status || 'OPEN').toUpperCase(),
      completedAt: status === 'DONE' ? new Date() : null,
    },
  });

  res.json({ success: true, data: task });
});

// DELETE /:id/tasks/:taskId - Delete a task
leadsRouter.delete('/:id/tasks/:taskId', async (req: Request, res: Response) => {
  const taskId = String(req.params.taskId);

  await prisma.gxLeadTask.delete({
    where: { id: taskId },
  });

  res.json({ success: true, message: 'Task deleted successfully' });
});
