import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { SalesLeadStage } from '@prisma/client';

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
    data: {
      leads,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    },
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

  res.status(201).json({ success: true, data: lead });
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
  priority: z.string().optional(),
  notes: z.string().optional(),
  followUpAt: z.string().datetime().optional(),
  budgetAmount: z.number().optional(),
  assignedAgentId: z.string().optional(),
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

  res.json({ success: true, data: updated });
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