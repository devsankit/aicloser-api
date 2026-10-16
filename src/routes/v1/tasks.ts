import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { logger } from '../../lib/logger.js';

export const tasksRouter = Router();

tasksRouter.use(authenticate, enforceTenantIsolation);

const listTasksQuerySchema = z.object({
  page: z.string().optional().transform((v) => (v ? Math.max(1, Number(v)) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, Math.max(1, Number(v))) : 25)),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'ALL']).optional().default('ALL'),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  salesLeadId: z.string().optional(),
  search: z.string().optional(),
});

// 1. GET / - List all workspace tasks with strict closer scoping and lead hydration
tasksRouter.get('/', validateQuery(listTasksQuerySchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { page, limit, status, priority, salesLeadId, search } = req.query as unknown as {
    page: number;
    limit: number;
    status: string;
    priority?: string;
    salesLeadId?: string;
    search?: string;
  };

  // Determine accessible leads for this tenant / user
  let accessibleLeadIds: string[] = [];

  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });

    const leads = await prisma.salesLeadAssignment.findMany({
      where: {
        tenantId,
        ...(salesLeadId ? { id: salesLeadId } : {}),
        assignedAgentId: profile?.id ?? '__NO_ACCESS__',
      },
      select: { id: true },
    });
    accessibleLeadIds = leads.map((l) => l.id);
  } else {
    // Admin / Manager / Super Admin
    const leads = await prisma.salesLeadAssignment.findMany({
      where: {
        tenantId,
        ...(salesLeadId ? { id: salesLeadId } : {}),
      },
      select: { id: true },
    });
    accessibleLeadIds = leads.map((l) => l.id);
  }

  if (accessibleLeadIds.length === 0) {
    res.json({
      success: true,
      data: [],
      pagination: { total: 0, page, limit, totalPages: 0 },
      error: null,
    });
    return;
  }

  const where: any = {
    salesLeadId: { in: accessibleLeadIds },
  };

  if (status && status !== 'ALL') {
    where.status = status;
  }

  if (priority) {
    where.priority = priority;
  }

  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, tasks] = await Promise.all([
    prisma.gxLeadTask.count({ where }),
    prisma.gxLeadTask.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
    }),
  ]);

  // Hydrate linked lead information
  const leadDetails = await prisma.salesLeadAssignment.findMany({
    where: { id: { in: tasks.map((t) => t.salesLeadId) } },
    select: {
      id: true,
      customerName: true,
      customerPhone: true,
      customerEmail: true,
      stage: true,
      budgetAmount: true,
      assignedAgent: {
        select: {
          id: true,
          agentCode: true,
          user: { select: { displayName: true } },
        },
      },
    },
  });

  const leadMap = new Map(leadDetails.map((l) => [l.id, l]));

  const enrichedTasks = tasks.map((t) => {
    const lead = leadMap.get(t.salesLeadId);
    return {
      ...t,
      lead: lead
        ? {
            id: lead.id,
            customerName: lead.customerName,
            customerPhone: lead.customerPhone,
            customerEmail: lead.customerEmail,
            stage: lead.stage,
            budgetAmount: lead.budgetAmount ? Number(lead.budgetAmount) : null,
            assignedAgentName: lead.assignedAgent?.user?.displayName || null,
          }
        : null,
    };
  });

  res.json({
    success: true,
    data: enrichedTasks,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    error: null,
  });
});

const createTaskSchema = z.object({
  salesLeadId: z.string().min(1, 'salesLeadId is required'),
  title: z.string().trim().min(1, 'Task title is required').max(255),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  dueAt: z.string().datetime({ message: 'dueAt must be a valid ISO datetime' }),
});

// 2. POST / - Create a new task on a lead
tasksRouter.post('/', validateBody(createTaskSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body as z.infer<typeof createTaskSchema>;

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id: body.salesLeadId, tenantId },
    select: { id: true, assignedAgentId: true, customerName: true },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Target lead not found in this workspace' });
    return;
  }

  // Closer authorization check: SALES_AGENT can only create tasks on leads assigned to them
  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    if (!profile || lead.assignedAgentId !== profile.id) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only create tasks on your assigned leads' });
      return;
    }
  }

  const task = await prisma.gxLeadTask.create({
    data: {
      salesLeadId: lead.id,
      createdById: req.user?.userId,
      ownerAgentId: lead.assignedAgentId,
      title: body.title,
      description: body.description || null,
      priority: body.priority,
      status: 'OPEN',
      dueAt: new Date(body.dueAt),
    },
  });

  logger.info('Created task on lead', { tenantId, taskId: task.id, leadId: lead.id, title: task.title });

  res.status(201).json({
    success: true,
    message: 'Task created successfully',
    data: task,
    error: null,
  });
});

const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  dueAt: z.string().datetime().optional(),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
});

// 3. PATCH /:id - Update or toggle task
tasksRouter.patch('/:id', validateBody(updateTaskSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof updateTaskSchema>;

  const task = await prisma.gxLeadTask.findUnique({
    where: { id },
  });

  if (!task) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Task not found' });
    return;
  }

  // Verify task belongs to this tenant via its linked lead
  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id: task.salesLeadId, tenantId },
    select: { id: true, assignedAgentId: true },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Task does not belong to this workspace' });
    return;
  }

  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    if (!profile || lead.assignedAgentId !== profile.id) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only update tasks on your assigned leads' });
      return;
    }
  }

  const updated = await prisma.gxLeadTask.update({
    where: { id },
    data: {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.dueAt !== undefined ? { dueAt: new Date(body.dueAt) } : {}),
      ...(body.status !== undefined
        ? {
            status: body.status,
            completedAt: body.status === 'DONE' ? new Date() : null,
          }
        : {}),
    },
  });

  res.json({
    success: true,
    message: 'Task updated successfully',
    data: updated,
    error: null,
  });
});

// 4. DELETE /:id - Delete a task
tasksRouter.delete('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const task = await prisma.gxLeadTask.findUnique({
    where: { id },
  });

  if (!task) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Task not found' });
    return;
  }

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id: task.salesLeadId, tenantId },
    select: { id: true, assignedAgentId: true },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Task does not belong to this workspace' });
    return;
  }

  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    if (!profile || lead.assignedAgentId !== profile.id) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only delete tasks on your assigned leads' });
      return;
    }
  }

  await prisma.gxLeadTask.delete({
    where: { id },
  });

  res.json({
    success: true,
    message: 'Task deleted successfully',
    data: { deletedTaskId: id },
    error: null,
  });
});
