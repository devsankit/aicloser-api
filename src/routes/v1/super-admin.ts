import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { scryptSync, randomBytes, randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { authenticate } from '../../middlewares/auth.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { logger } from '../../lib/logger.js';
import { AuthenticatedUser } from '../../types/auth.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { acquireClientSession, closeClientSession } from '../../lib/client-sessions.js';

export const superAdminRouter = Router();

// Strictly restricted to SUPER_ADMIN role only
superAdminRouter.use(authenticate, requireRoles('SUPER_ADMIN'));

// ==========================================
// 1. WORKSPACES (TENANTS)
// ==========================================

const listTenantsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'LOCKED']).optional(),
  planTier: z.enum(['FREE', 'STARTER', 'GROWTH', 'PRO', 'AGENCY', 'ENTERPRISE']).optional(),
});

// GET /tenants - List workspaces with pagination and filtering
superAdminRouter.get('/tenants', validateQuery(listTenantsQuerySchema), async (req: Request, res: Response) => {
  const { page, limit, search, status, planTier } = req.query as unknown as z.infer<typeof listTenantsQuerySchema>;

  logger.info('Super Admin listed workspaces', { actorId: req.user?.userId, page, limit, search, status });

  const where: Record<string, unknown> = {};

  if (status) {
    where.status = status;
  }

  if (planTier) {
    where.planTier = planTier;
  }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { id: { contains: search, mode: 'insensitive' } },
      { slug: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, workspaces] = await Promise.all([
    prisma.aicloserWorkspace.count({ where }),
    prisma.aicloserWorkspace.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            users: true,
            leads: true,
            mobileCalls: true,
          },
        },
      },
    }),
  ]);

  res.json({
    success: true,
    data: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      status: w.status,
      planTier: w.planTier,
      maxSeats: w.maxSeats,
      ownerEmail: w.ownerEmail || null,
        ownerPhone: w.ownerPhone || null,
        ownerUserId: w.ownerUserId || null,
        expiresAt: ((w.settings as any)?.subscriptionExpiresAt || (w.settings as any)?.expiresAt || null) as string | null,
        monthlyAmount: Number((w.settings as any)?.monthlyAmount ?? ((w.maxSeats || 5) * 1999)),
        paymentStatus: ((w.settings as any)?.paymentStatus || 'PAID') as 'PAID' | 'PENDING',
        settings: w.settings,
        stats: {
        usersCount: w._count.users,
        leadsCount: w._count.leads,
        callsCount: w._count.mobileCalls,
      },
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    })),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    error: null,
  });
});

const createTenantSchema = z.object({
  name: z.string().min(2, 'Name required'),
  slug: z.string().min(2).optional(),
  ownerEmail: z.string().email().optional(),
  ownerPhone: z.string().optional(),
  ownerPassword: z.string().min(6).optional().default('Admin@123'),
  maxSeats: z.coerce.number().int().min(1).default(5),
  expiresAt: z.string().optional(),
  planTier: z.enum(['FREE', 'STARTER', 'GROWTH', 'PRO', 'AGENCY', 'ENTERPRISE']).optional().default('PRO'),
  monthlyAmount: z.coerce.number().min(0).optional(),
});

// POST /tenants - Provision new tenant workspace with owner user and live expiry
superAdminRouter.post('/tenants', validateBody(createTenantSchema), async (req: Request, res: Response) => {
  try {
    const { name, slug, ownerEmail, ownerPhone, ownerPassword, maxSeats, expiresAt, planTier, monthlyAmount } = req.body as z.infer<typeof createTenantSchema>;
    const workspaceId = 'ws-' + randomUUID().slice(0, 10);
    const baseSlug = (slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
    const workspaceSlug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
    const expiryDate = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 365 * 86400000);

    // 1. Create Workspace first to satisfy foreign key constraints
    const workspace = await prisma.aicloserWorkspace.create({
      data: {
        id: workspaceId,
        name,
        slug: workspaceSlug,
        ownerEmail: ownerEmail || null,
        ownerPhone: ownerPhone || null,
        status: 'ACTIVE',
        planTier: planTier || 'PRO',
        maxSeats,
        settings: {
          subscriptionExpiresAt: expiryDate.toISOString(),
          expiresAt: expiryDate.toISOString(),
          ...(monthlyAmount !== undefined ? { monthlyAmount } : {}),
        },
      },
    });

    // 2. Create or link Owner AppAuthUser
    let ownerUserId: string | null = null;
    if (ownerEmail) {
      const existing = await prisma.appAuthUser.findFirst({
        where: {
          OR: [
            { email: ownerEmail.toLowerCase() },
            ...(ownerPhone ? [{ phone: ownerPhone }] : []),
          ],
        },
      });

      if (existing) {
        ownerUserId = existing.id;
        await prisma.appAuthUser.update({
          where: { id: existing.id },
          data: {
            tenantId: workspace.id,
            role: 'ADMIN',
            assignedRole: 'ADMIN',
            packageExpiresAt: expiryDate,
          },
        });
      } else {
        const salt = randomBytes(16).toString('hex');
        const hash = scryptSync(ownerPassword || 'Admin@123', salt, 64).toString('hex');
        const newUserId = `usr-${randomBytes(6).toString('hex')}`;
        const createdOwner = await prisma.appAuthUser.create({
          data: {
            id: newUserId,
            role: 'ADMIN',
            assignedRole: 'ADMIN',
            tenantId: workspace.id,
            displayName: `${name} Admin`,
            email: ownerEmail.toLowerCase(),
            phone: ownerPhone || null,
            passwordSalt: salt,
            passwordHash: hash,
            otpCode: '123456',
            permissions: ['admin'],
            packageExpiresAt: expiryDate,
            isSeeded: false,
          },
        });
        ownerUserId = createdOwner.id;
      }

      await prisma.aicloserWorkspace.update({
        where: { id: workspace.id },
        data: { ownerUserId },
      });
    }

    res.status(201).json({
      success: true,
      data: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        status: workspace.status,
        planTier: workspace.planTier,
        maxSeats: workspace.maxSeats,
        monthlyAmount: Number(monthlyAmount ?? (workspace.settings as any)?.monthlyAmount ?? ((maxSeats || 5) * 1999)),
        ownerEmail: workspace.ownerEmail,
        ownerPhone: workspace.ownerPhone,
        ownerUserId: workspace.ownerUserId,
        expiresAt: expiryDate.toISOString(),
        settings: workspace.settings,
        stats: {
          usersCount: ownerUserId ? 1 : 0,
          leadsCount: 0,
          callsCount: 0,
        },
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      },
    });
  } catch (error) {
    console.error('[superAdminRouter.postTenants] Error:', error);
    res.status(500).json({
      success: false,
      error: 'CreateTenantFailed',
      message: error instanceof Error ? error.message : 'Could not provision workspace',
    });
  }
});

// GET /tenants/:id - Workspace detail
superAdminRouter.get('/tenants/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: String(id) },
    include: {
      users: {
        select: {
          id: true,
          email: true,
          displayName: true,
          role: true,
          packageStatus: true,
          packageExpiresAt: true,
          createdAt: true,
        },
      },
      agentProfiles: {
        select: {
          id: true,
          agentCode: true,
          status: true,
          canClaimLeads: true,
        },
      },
      _count: {
        select: {
          users: true,
          leads: true,
          mobileCalls: true,
          conversations: true,
        },
      },
    },
  });

  if (!workspace) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Workspace not found' });
    return;
  }

  res.json({ success: true, data: workspace });
});

// GET /tenants/:id/plan - Workspace plan info
superAdminRouter.get('/tenants/:id/plan', async (req: Request, res: Response) => {
  const { id } = req.params;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: String(id) },
    select: {
      id: true,
      name: true,
      planTier: true,
      maxSeats: true,
      status: true,
      settings: true,
    },
  });

  if (!workspace) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Workspace not found' });
    return;
  }

  const activeSeats = await prisma.appAuthUser.count({
    where: { tenantId: String(id), packageStatus: 'ACTIVE' },
  });

  const settings = (workspace.settings as Record<string, any>) || {};

  res.json({
    success: true,
    data: {
      tenantId: workspace.id,
      name: workspace.name,
      planTier: workspace.planTier,
      seatLimit: workspace.maxSeats,
      activeSeats,
      status: workspace.status,
      subscriptionExpiresAt: settings.subscriptionExpiresAt || settings.expiresAt || null,
      settings: workspace.settings,
    },
    error: null,
  });
});

// ==========================================
// 2. WORKSPACE MUTATIONS (STRICT ZOD VALIDATION)
// ==========================================

const updatePlanSchema = z.object({
  planTier: z.enum(['FREE', 'STARTER', 'GROWTH', 'PRO', 'AGENCY', 'ENTERPRISE'], {
    errorMap: () => ({ message: 'planTier must be one of: FREE, STARTER, GROWTH, PRO, AGENCY, ENTERPRISE' }),
  }),
});

// PATCH /tenants/:id/plan - Change plan tier
superAdminRouter.patch('/tenants/:id/plan', validateBody(updatePlanSchema), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { planTier } = req.body as z.infer<typeof updatePlanSchema>;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: String(id) },
  });

  if (!workspace) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Workspace not found' });
    return;
  }

  const updated = await prisma.aicloserWorkspace.update({
    where: { id: workspace.id },
    data: { planTier, updatedAt: new Date() },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: workspace.id,
      actorUserId: req.user?.userId,
      action: 'PLAN_TIER_CHANGED',
      note: `Plan tier updated to ${planTier} by Super Admin`,
      metadata: { planTier, previousTier: workspace.planTier },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: `Plan tier updated to ${planTier}`, data: updated });
});

const updateStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'LOCKED'], {
    errorMap: () => ({ message: 'status must be one of: ACTIVE, SUSPENDED, LOCKED' }),
  }),
  reason: z.string().trim().optional(),
});

// PATCH /tenants/:id/status - Suspend / activate / lock workspace
superAdminRouter.patch('/tenants/:id/status', validateBody(updateStatusSchema), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, reason } = req.body as z.infer<typeof updateStatusSchema>;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: String(id) },
  });

  if (!workspace) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Workspace not found' });
    return;
  }

  const updated = await prisma.aicloserWorkspace.update({
    where: { id: workspace.id },
    data: { status, updatedAt: new Date() },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: workspace.id,
      actorUserId: req.user?.userId,
      action: 'WORKSPACE_STATUS_CHANGED',
      note: `Workspace status changed to ${status} by Super Admin${reason ? `: ${reason}` : ''}`,
      metadata: { status, previousStatus: workspace.status, reason },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: `Workspace status updated to ${status}`, data: updated });
});

const updateSeatsSchema = z.object({
  maxSeats: z.number({ invalid_type_error: 'maxSeats must be a number' })
    .int('maxSeats must be an integer')
    .min(1, 'maxSeats must be at least 1')
    .max(1000, 'maxSeats cannot exceed 1000'),
});

// PATCH /tenants/:id/seats - Change seat limit
superAdminRouter.patch('/tenants/:id/seats', validateBody(updateSeatsSchema), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { maxSeats } = req.body as z.infer<typeof updateSeatsSchema>;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: String(id) },
  });

  if (!workspace) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Workspace not found' });
    return;
  }

  const updated = await prisma.aicloserWorkspace.update({
    where: { id: workspace.id },
    data: { maxSeats, updatedAt: new Date() },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: workspace.id,
      actorUserId: req.user?.userId,
      action: 'SEAT_LIMIT_CHANGED',
      note: `Seat quota updated to ${maxSeats} by Super Admin`,
      metadata: { maxSeats, previousMaxSeats: workspace.maxSeats },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: `Seat quota set to ${maxSeats}`, data: updated });
});

const updateAmountSchema = z.object({
  monthlyAmount: z.coerce.number().min(0, 'Monthly amount cannot be negative'),
});

// PATCH /tenants/:id/amount - Set custom monthly subscription amount
superAdminRouter.patch('/tenants/:id/amount', validateBody(updateAmountSchema), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { monthlyAmount } = req.body as z.infer<typeof updateAmountSchema>;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: String(id) },
  });

  if (!workspace) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Workspace not found' });
    return;
  }

  const existingSettings = (workspace.settings as Record<string, any>) || {};
  const updatedSettings = {
    ...existingSettings,
    monthlyAmount,
  };

  const updated = await prisma.aicloserWorkspace.update({
    where: { id: workspace.id },
    data: { settings: updatedSettings, updatedAt: new Date() },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: workspace.id,
      actorUserId: req.user?.userId,
      action: 'MONTHLY_AMOUNT_UPDATED',
      note: `Monthly subscription amount updated to ₹${monthlyAmount} by Super Admin`,
      metadata: { monthlyAmount, previousAmount: existingSettings.monthlyAmount },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: `Monthly subscription amount set to ₹${monthlyAmount}`, data: { ...updated, monthlyAmount } });
});

// PATCH /tenants/:id/payment-status - Update tenant payment status (PAID | PENDING)
const updatePaymentStatusSchema = z.object({
  paymentStatus: z.enum(['PAID', 'PENDING']),
});

superAdminRouter.patch('/tenants/:id/payment-status', validateBody(updatePaymentStatusSchema), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { paymentStatus } = req.body as z.infer<typeof updatePaymentStatusSchema>;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: String(id) },
  });

  if (!workspace) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Workspace not found' });
    return;
  }

  const existingSettings = (workspace.settings as Record<string, any>) || {};
  const updatedSettings = {
    ...existingSettings,
    paymentStatus,
  };

  const updated = await prisma.aicloserWorkspace.update({
    where: { id: workspace.id },
    data: { settings: updatedSettings, updatedAt: new Date() },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: workspace.id,
      actorUserId: req.user?.userId,
      action: 'PAYMENT_STATUS_UPDATED',
      note: `Payment status marked as ${paymentStatus} by Super Admin`,
      metadata: { paymentStatus, previousStatus: existingSettings.paymentStatus || 'PAID' },
    },
  }).catch(() => undefined);

  res.json({
    success: true,
    message: 'Payment status marked as ' + paymentStatus,
    data: {
      ...updated,
      paymentStatus,
    },
  });
});

// PATCH /tenants/:tenantId/expiry - Extend / set plan expiry date (Real Database Update)
const expirySchema = z.object({
  expiresAt: z.string().datetime({ message: 'Valid ISO datetime required (e.g. 2026-12-31T23:59:59.000Z)' }),
});

superAdminRouter.patch('/tenants/:tenantId/expiry', validateBody(expirySchema), async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const { expiresAt } = req.body as z.infer<typeof expirySchema>;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: String(tenantId) },
  });

  if (!workspace) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Workspace not found' });
    return;
  }

  const existingSettings = (workspace.settings as Record<string, any>) || {};
  const updatedSettings = {
    ...existingSettings,
    subscriptionExpiresAt: expiresAt,
    expiresAt,
  };

  const expiryDate = new Date(expiresAt);

  // 1. Update workspace settings
  await prisma.aicloserWorkspace.update({
    where: { id: workspace.id },
    data: {
      settings: updatedSettings,
      updatedAt: new Date(),
    },
  });

  // 2. Update all users in workspace
  await prisma.appAuthUser.updateMany({
    where: { tenantId: workspace.id },
    data: { packageExpiresAt: expiryDate },
  });

  // 3. Audit log
  await prisma.salesActivityLog.create({
    data: {
      tenantId: workspace.id,
      actorUserId: req.user?.userId,
      action: 'WORKSPACE_EXPIRY_UPDATED',
      note: `Subscription expiry extended to ${expiresAt} by Super Admin`,
      metadata: { expiresAt },
    },
  }).catch(() => undefined);

  res.json({
    success: true,
    message: 'Subscription expiry updated in database',
    data: { tenantId: workspace.id, expiresAt },
  });
});

// ==========================================
// 3. WORKSPACE USERS (PAGINATION & MANAGEMENT)
// ==========================================

const listWorkspaceUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().optional(),
  role: z.enum(['ADMIN', 'MANAGER', 'SALES_AGENT', 'USER']).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'EXPIRED']).optional(),
});

// GET /tenants/:tenantId/users - List users with pagination and filtering
superAdminRouter.get('/tenants/:tenantId/users', validateQuery(listWorkspaceUsersQuerySchema), async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const { page, limit, search, role, status } = req.query as unknown as z.infer<typeof listWorkspaceUsersQuerySchema>;

  const where: Record<string, unknown> = {
    tenantId: String(tenantId),
  };

  if (role) {
    where.role = role === 'USER' ? 'SALES_AGENT' : role;
  }

  if (status) {
    where.packageStatus = status;
  }

  if (search) {
    where.OR = [
      { displayName: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
    ];
  }

  const [total, users] = await Promise.all([
    prisma.appAuthUser.count({ where }),
    prisma.appAuthUser.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        email: true,
        phone: true,
        displayName: true,
        role: true,
        packageStatus: true,
        packageExpiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  res.json({
    success: true,
    data: users,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    error: null,
  });
});

// POST /tenants/:tenantId/users - Add user with real password hashing and agent profile
const createUserSchema = z.object({
  email: z.string().trim().email('Valid email address required'),
  displayName: z.string().trim().min(1, 'Display name cannot be empty'),
  role: z.enum(['ADMIN', 'MANAGER', 'SALES_AGENT'], {
    errorMap: () => ({ message: 'role must be one of: ADMIN, MANAGER, SALES_AGENT' }),
  }),
  password: z.string().min(6, 'Password must be at least 6 characters').optional(),
  phone: z.string().trim().optional(),
});

superAdminRouter.post('/tenants/:tenantId/users', validateBody(createUserSchema), async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const body = req.body as z.infer<typeof createUserSchema>;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: String(tenantId) },
  });

  if (!workspace) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Target workspace not found' });
    return;
  }

  // Check seat capacity
  const currentSeats = await prisma.appAuthUser.count({ where: { tenantId: String(tenantId), packageStatus: 'ACTIVE' } });
  if (currentSeats >= workspace.maxSeats) {
    res.status(403).json({
      success: false,
      error: 'SeatLimitExceeded',
      message: `Workspace seat quota of ${workspace.maxSeats} reached. Increase maxSeats before adding users.`,
    });
    return;
  }

  // Check if email already taken
  const existingUser = await prisma.appAuthUser.findUnique({ where: { email: body.email.toLowerCase() } });
  if (existingUser) {
    res.status(409).json({ success: false, error: 'EmailConflict', message: 'User with this email already exists' });
    return;
  }

  // Check if phone already taken
  if (body.phone) {
    const existingPhone = await prisma.appAuthUser.findFirst({ where: { phone: body.phone } });
    if (existingPhone) {
      res.status(409).json({ success: false, error: 'PhoneConflict', message: 'User with this phone number already exists' });
      return;
    }
  }

  // Secure scrypt password hashing
  const salt = randomBytes(16).toString('hex');
  const rawPassword = body.password || randomBytes(8).toString('hex');
  const passwordHash = scryptSync(rawPassword, salt, 64).toString('hex');
  const userId = `usr-${randomUUID().slice(0, 12)}`;

  const user = await prisma.appAuthUser.create({
    data: {
      id: userId,
      tenantId: workspace.id,
      email: body.email.toLowerCase(),
      phone: body.phone || null,
      displayName: body.displayName,
      role: body.role as any,
      assignedRole: body.role as any,
      passwordSalt: salt,
      passwordHash: passwordHash,
      otpCode: '000000',
      permissions: [],
      packageStatus: 'ACTIVE',
    },
  });

  // Auto create SalesAgentProfile if role is SALES_AGENT
  if (body.role === 'SALES_AGENT') {
    const code = `AG-${randomUUID().slice(0, 6).toUpperCase()}`;
    await prisma.salesAgentProfile.create({
      data: {
        userId: user.id,
        tenantId: workspace.id,
        agentCode: code,
        status: 'ACTIVE',
        canClaimLeads: true,
      },
    }).catch(() => undefined);
  }

  await prisma.salesActivityLog.create({
    data: {
      tenantId: workspace.id,
      actorUserId: req.user?.userId,
      action: 'USER_CREATED_BY_SUPER_ADMIN',
      note: `User ${body.email} (${body.role}) created by Super Admin`,
      metadata: { userId: user.id, role: body.role },
    },
  }).catch(() => undefined);

  res.status(201).json({
    success: true,
    data: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role === 'SALES_AGENT' ? 'USER' : user.role,
      temporaryPassword: body.password ? undefined : rawPassword,
    },
    message: 'User created successfully in workspace',
  });
});

const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  role: z.enum(['ADMIN', 'MANAGER', 'SALES_AGENT', 'USER']).optional(),
  password: z.string().min(6, 'Password must be at least 6 characters').optional(),
  phone: z.string().trim().optional(),
  packageStatus: z.enum(['ACTIVE', 'PAUSED', 'EXPIRED']).optional(),
});

// PATCH /tenants/:tenantId/users/:userId - Update user with strict validation and password hashing
superAdminRouter.patch('/tenants/:tenantId/users/:userId', validateBody(updateUserSchema), async (req: Request, res: Response) => {
  const { userId, tenantId } = req.params;
  const body = req.body as z.infer<typeof updateUserSchema>;

  const existingUser = await prisma.appAuthUser.findFirst({
    where: { id: String(userId), tenantId: String(tenantId) },
  });

  if (!existingUser) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'User not found in this workspace' });
    return;
  }

  let passwordData: { passwordSalt: string; passwordHash: string } | {} = {};
  if (body.password) {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(body.password, salt, 64).toString('hex');
    passwordData = { passwordSalt: salt, passwordHash: hash };
  }

  const updated = await prisma.appAuthUser.update({
    where: { id: existingUser.id },
    data: {
      ...(body.displayName ? { displayName: body.displayName } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.role ? { role: (body.role === 'USER' ? 'SALES_AGENT' : body.role) as any, assignedRole: (body.role === 'USER' ? 'SALES_AGENT' : body.role) as any } : {}),
      ...(body.packageStatus ? { packageStatus: body.packageStatus as any } : {}),
      ...passwordData,
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      phone: true,
      role: true,
      packageStatus: true,
      packageExpiresAt: true,
    },
  });

  // If role changed to SALES_AGENT, ensure SalesAgentProfile exists
  if (body.role === 'SALES_AGENT') {
    const existingProfile = await prisma.salesAgentProfile.findFirst({
      where: { userId: existingUser.id, tenantId: String(tenantId) },
    });
    if (!existingProfile) {
      const code = 'AG-' + randomUUID().slice(0, 6).toUpperCase();
      await prisma.salesAgentProfile.create({
        data: {
          userId: existingUser.id,
          tenantId: String(tenantId),
          agentCode: code,
          status: 'ACTIVE',
          canClaimLeads: true,
        },
      }).catch(() => undefined);
    } else if (existingProfile.status === 'SUSPENDED') {
      await prisma.salesAgentProfile.update({
        where: { id: existingProfile.id },
        data: { status: 'ACTIVE', canClaimLeads: true },
      });
    }
  }

  await prisma.salesActivityLog.create({
    data: {
      tenantId: String(tenantId),
      actorUserId: req.user?.userId,
      action: 'USER_UPDATED_BY_SUPER_ADMIN',
      note: 'User ' + existingUser.email + ' updated by Super Admin',
      metadata: { userId: existingUser.id, changes: { ...body, password: body.password ? '[UPDATED]' : undefined } },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: 'User updated successfully', data: updated });
});

// DELETE /tenants/:tenantId/users/:userId - Safe deactivation with audit log (Hard delete only if force=true)
superAdminRouter.delete('/tenants/:tenantId/users/:userId', async (req: Request, res: Response) => {
  const { userId, tenantId } = req.params;
  const force = req.query.force === 'true';

  const user = await prisma.appAuthUser.findFirst({
    where: { id: String(userId), tenantId: String(tenantId) },
  });

  if (!user) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'User not found in this workspace' });
    return;
  }

  // Count active leads assigned to user
  const activeLeadsCount = await prisma.salesLeadAssignment.count({
    where: { assignedAgent: { userId: user.id }, tenantId: String(tenantId) },
  });

  if (force && activeLeadsCount === 0) {
    await prisma.salesAgentProfile.deleteMany({ where: { userId: user.id, tenantId: String(tenantId) } });
    await prisma.appAuthUser.delete({ where: { id: user.id } });

    await prisma.salesActivityLog.create({
      data: {
        tenantId: String(tenantId),
        actorUserId: req.user?.userId,
        action: 'USER_HARD_DELETED',
        note: `User ${user.email} permanently deleted by Super Admin`,
      },
    }).catch(() => undefined);

    res.json({ success: true, message: 'User permanently deleted from workspace' });
    return;
  }

  // Safe soft-deactivation (Preserves lead history, calls, and recordings)
  await prisma.appAuthUser.update({
    where: { id: user.id },
    data: { packageStatus: 'PAUSED' },
  });

  await prisma.salesAgentProfile.updateMany({
    where: { userId: user.id, tenantId: String(tenantId) },
    data: { status: 'SUSPENDED', canClaimLeads: false },
  });

  // Revoke active sessions
  await prisma.appClientSession.deleteMany({ where: { userId: user.id } });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: String(tenantId),
      actorUserId: req.user?.userId,
      action: 'USER_DEACTIVATED',
      note: `User ${user.email} deactivated by Super Admin (assigned leads: ${activeLeadsCount})`,
      metadata: { userId: user.id, activeLeadsCount },
    },
  }).catch(() => undefined);

  res.json({
    success: true,
    deactivated: true,
    activeLeadsCount,
    message: 'User safely deactivated. Assigned leads and call history preserved.',
  });
});

// ==========================================
// 4. TELEMETRY & SYSTEM HEALTH
// ==========================================

// GET /telemetry - System wide metrics with breakdowns
superAdminRouter.get('/telemetry', async (req: Request, res: Response) => {
  const [
    totalWorkspaces,
    activeWorkspaces,
    suspendedWorkspaces,
    lockedWorkspaces,
    totalUsers,
    activeUsers,
    totalLeads,
    totalCalls,
    workspacesByTier,
  ] = await Promise.all([
    prisma.aicloserWorkspace.count(),
    prisma.aicloserWorkspace.count({ where: { status: 'ACTIVE' } }),
    prisma.aicloserWorkspace.count({ where: { status: 'SUSPENDED' } }),
    prisma.aicloserWorkspace.count({ where: { status: 'LOCKED' } }),
    prisma.appAuthUser.count(),
    prisma.appAuthUser.count({ where: { packageStatus: 'ACTIVE' } }),
    prisma.salesLeadAssignment.count(),
    prisma.salesMobileCall.count(),
    prisma.aicloserWorkspace.groupBy({
      by: ['planTier'],
      _count: true,
    }),
  ]);

  res.json({
    success: true,
    data: {
      workspaces: {
        total: totalWorkspaces,
        active: activeWorkspaces,
        suspended: suspendedWorkspaces,
        locked: lockedWorkspaces,
        byTier: workspacesByTier.map((t) => ({ tier: t.planTier, count: t._count })),
      },
      users: {
        total: totalUsers,
        active: activeUsers,
      },
      leads: { total: totalLeads },
      calls: { total: totalCalls },
      system: {
        serverMemoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
      },
    },
    error: null,
  });
});

// ==========================================
// 5. FEEDBACK & RESOLUTION
// ==========================================

const listFeedbackQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  tenantId: z.string().trim().optional(),
  search: z.string().trim().optional(),
});

// GET /feedback - Paginated user feedback with search & filtering
superAdminRouter.get('/feedback', validateQuery(listFeedbackQuerySchema), async (req: Request, res: Response) => {
  const { page, limit, tenantId, search } = req.query as unknown as z.infer<typeof listFeedbackQuerySchema>;

  const where: Record<string, unknown> = {
    action: { contains: 'FEEDBACK' },
  };

  if (tenantId) {
    where.tenantId = tenantId;
  }

  if (search) {
    where.note = { contains: search, mode: 'insensitive' };
  }

  const [total, logs] = await Promise.all([
    prisma.salesActivityLog.count({ where }),
    prisma.salesActivityLog.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  res.json({
    success: true,
    data: logs.map((l) => ({
      id: l.id,
      tenantId: l.tenantId,
      action: l.action,
      message: l.note,
      metadata: l.metadata,
      createdAt: l.createdAt,
    })),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    error: null,
  });
});

const resolveFeedbackSchema = z.object({
  resolutionNote: z.string().trim().min(1).optional(),
});

// PATCH /feedback/:id - Resolve feedback with audit trail
superAdminRouter.patch('/feedback/:id', validateBody(resolveFeedbackSchema), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { resolutionNote } = req.body as z.infer<typeof resolveFeedbackSchema>;

  const existingLog = await prisma.salesActivityLog.findUnique({
    where: { id: String(id) },
  });

  if (existingLog) {
    await prisma.salesActivityLog.create({
      data: {
        tenantId: existingLog.tenantId,
        actorUserId: req.user?.userId,
        action: 'FEEDBACK_RESOLVED',
        note: `Feedback ${id} marked resolved by Super Admin${resolutionNote ? `: ${resolutionNote}` : ''}`,
        metadata: { feedbackId: id, resolutionNote },
      },
    }).catch(() => undefined);
  }

  res.json({ success: true, message: 'Feedback marked as resolved', id });
});

// ==========================================
// 6. IMPERSONATION (AUDITED)
// ==========================================

// POST /tenants/:tenantId/impersonate - Audited session with explicit tracking
superAdminRouter.post('/tenants/:tenantId/impersonate', async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const actor = req.user!;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: String(tenantId) },
  });

  if (!workspace) {
    res.status(404).json({
      success: false,
      error: 'WorkspaceNotFound',
      message: `Target workspace "${tenantId}" does not exist`,
    });
    return;
  }

  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

  // Acquire audited desktop client session
  const session = await acquireClientSession({
    userId: actor.userId,
    tenantId: String(tenantId),
    channel: 'DESKTOP',
    installationId: `impersonation-${actor.userId}`,
    deviceName: `SuperAdmin Impersonation (${actor.displayName})`,
    platform: 'Web Console',
    replaceExisting: true,
  }).catch(() => null);

  const sessionId = session?.session?.sessionId || `imp-sess-${randomUUID().slice(0, 16)}`;

  // Audit log in target workspace
  await prisma.salesActivityLog.create({
    data: {
      tenantId: String(tenantId),
      actorUserId: actor.userId,
      action: 'SUPER_ADMIN_IMPERSONATION_STARTED',
      note: `Super Admin ${actor.displayName} started audited session in workspace ${workspace.name}`,
      metadata: { actorId: actor.userId, sessionId, targetTenantId: tenantId },
    },
  }).catch(() => undefined);

  const impersonatedPayload: AuthenticatedUser = {
    userId: actor.userId,
    role: 'SUPER_ADMIN',
    tenantId: String(tenantId),
    displayName: `${actor.displayName} (Viewing: ${workspace.name})`,
    phone: actor.phone,
    email: actor.email,
    sessionId,
  };

  const token = jwt.sign(impersonatedPayload, env.JWT_SECRET, { expiresIn: '2h' });

  res.json({
    success: true,
    message: `Audited impersonation session created for workspace "${workspace.name}"`,
    data: {
      token,
      sessionId,
      targetTenantId: tenantId,
      workspaceName: workspace.name,
      expiresAt: expiresAt.toISOString(),
      expiresIn: '2h',
    },
  });
});

// POST /impersonation/return - Return to Super Admin canonical context with audit log
superAdminRouter.post('/impersonation/return', async (req: Request, res: Response) => {
  const actor = req.user!;

  if (actor.sessionId) {
    await closeClientSession(actor.sessionId, 'REVOKED', 'Super Admin returned from impersonation').catch(() => undefined);
  }

  // Find actor's canonical user record
  const dbUser = await prisma.appAuthUser.findUnique({
    where: { id: actor.userId },
    select: { tenantId: true },
  });

  const canonicalTenantId = dbUser?.tenantId || null;

  if (actor.tenantId) {
    await prisma.salesActivityLog.create({
      data: {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'SUPER_ADMIN_IMPERSONATION_REVOKED',
        note: 'Super Admin returned from impersonation session',
        metadata: { actorId: actor.userId, sessionId: actor.sessionId },
      },
    }).catch(() => undefined);
  }

  const cleanDisplayName = actor.displayName.split(' (Viewing:')[0];
  const originalPayload: AuthenticatedUser = {
    userId: actor.userId,
    role: 'SUPER_ADMIN',
    tenantId: canonicalTenantId,
    displayName: cleanDisplayName,
    phone: actor.phone,
    email: actor.email,
  };

  const token = jwt.sign(originalPayload, env.JWT_SECRET, { expiresIn: '7d' });

  res.json({
    success: true,
    message: 'Returned to canonical Super Admin session',
    data: { token, tenantId: canonicalTenantId },
  });
});

// POST /impersonation/revoke/:sessionId - Explicitly revoke an impersonation session
superAdminRouter.post('/impersonation/revoke/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const actor = req.user!;

  await closeClientSession(String(sessionId), 'REVOKED', 'Explicitly revoked by Super Admin').catch(() => undefined);

  await prisma.salesActivityLog.create({
    data: {
      tenantId: actor.tenantId || 'global-admin',
      actorUserId: actor.userId,
      action: 'SUPER_ADMIN_IMPERSONATION_REVOKED',
      note: 'Impersonation session ' + sessionId + ' explicitly revoked by Super Admin',
      metadata: { actorId: actor.userId, sessionId },
    },
  }).catch(() => undefined);

  res.json({
    success: true,
    message: 'Impersonation session ' + sessionId + ' successfully revoked',
  });
});
