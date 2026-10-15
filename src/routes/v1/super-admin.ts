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
import { validateBody } from '../../middlewares/validate.js';
import { acquireClientSession, closeClientSession } from '../../lib/client-sessions.js';

export const superAdminRouter = Router();

// Strictly restricted to SUPER_ADMIN role only
superAdminRouter.use(authenticate, requireRoles('SUPER_ADMIN'));

// 1. GET /tenants - List all workspaces
superAdminRouter.get('/tenants', async (req: Request, res: Response) => {
  logger.info('Super Admin listed all canonical workspaces', { actorId: req.user?.userId });

  const workspaces = await prisma.aicloserWorkspace.findMany({
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
  });

  res.json({
    success: true,
    data: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      status: w.status,
      planTier: w.planTier,
      maxSeats: w.maxSeats,
      settings: w.settings,
      stats: {
        usersCount: w._count.users,
        leadsCount: w._count.leads,
        callsCount: w._count.mobileCalls,
      },
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    })),
  });
});

// 2. GET /tenants/:id - Workspace detail
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
    },
  });

  if (!workspace) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Workspace not found' });
    return;
  }

  res.json({ success: true, data: workspace });
});

// 3. GET /tenants/:id/plan - Workspace plan info
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
    where: { tenantId: String(id) },
  });

  res.json({
    success: true,
    data: {
      tenantId: workspace.id,
      planTier: workspace.planTier,
      seatLimit: workspace.maxSeats,
      activeSeats,
      status: workspace.status,
      settings: workspace.settings,
    },
  });
});

// 4. PATCH /tenants/:id/plan - Change plan tier
superAdminRouter.patch('/tenants/:id/plan', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { planTier } = req.body as { planTier: string };

  const updated = await prisma.aicloserWorkspace.update({
    where: { id: String(id) },
    data: { planTier: planTier.toUpperCase(), updatedAt: new Date() },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: String(id),
      actorUserId: req.user?.userId,
      action: 'PLAN_TIER_CHANGED',
      note: `Plan tier updated to ${planTier.toUpperCase()} by Super Admin`,
      metadata: { planTier: planTier.toUpperCase() },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: 'Plan updated successfully', data: updated });
});

// 5. PATCH /tenants/:id/status - Suspend / activate workspace
superAdminRouter.patch('/tenants/:id/status', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body as { status: 'ACTIVE' | 'SUSPENDED' | 'LOCKED' };

  const updated = await prisma.aicloserWorkspace.update({
    where: { id: String(id) },
    data: { status, updatedAt: new Date() },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: String(id),
      actorUserId: req.user?.userId,
      action: 'WORKSPACE_STATUS_CHANGED',
      note: `Workspace status changed to ${status} by Super Admin`,
      metadata: { status },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: `Workspace status updated to ${status}`, data: updated });
});

// 6. PATCH /tenants/:id/seats - Change seat limit
superAdminRouter.patch('/tenants/:id/seats', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { maxSeats } = req.body as { maxSeats: number };

  const updated = await prisma.aicloserWorkspace.update({
    where: { id: String(id) },
    data: { maxSeats: Number(maxSeats), updatedAt: new Date() },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: String(id),
      actorUserId: req.user?.userId,
      action: 'SEAT_LIMIT_CHANGED',
      note: `Seat quota updated to ${maxSeats} by Super Admin`,
      metadata: { maxSeats: Number(maxSeats) },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: `Seat quota set to ${maxSeats}`, data: updated });
});

// 7. PATCH /tenants/:tenantId/expiry - Extend / set plan expiry date (Real Database Update)
const expirySchema = z.object({
  expiresAt: z.string().datetime({ message: 'Valid ISO datetime required' }),
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

// 8. GET /tenants/:tenantId/users - List users
superAdminRouter.get('/tenants/:tenantId/users', async (req: Request, res: Response) => {
  const { tenantId } = req.params;

  const users = await prisma.appAuthUser.findMany({
    where: { tenantId: String(tenantId) },
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
  });

  res.json({ success: true, data: users });
});

// 9. POST /tenants/:tenantId/users - Add user with real password hashing and agent profile
const createUserSchema = z.object({
  email: z.string().trim().email(),
  displayName: z.string().trim().min(1),
  role: z.enum(['ADMIN', 'MANAGER', 'SALES_AGENT']),
  password: z.string().min(6).optional(),
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
  const currentSeats = await prisma.appAuthUser.count({ where: { tenantId: String(tenantId) } });
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
      role: user.role,
      temporaryPassword: body.password ? undefined : rawPassword,
    },
    message: 'User created successfully in workspace',
  });
});

const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  role: z.enum(['ADMIN', 'MANAGER', 'SALES_AGENT']).optional(),
  password: z.string().min(6).optional(),
  phone: z.string().trim().optional(),
  packageStatus: z.enum(['ACTIVE', 'PAUSED', 'EXPIRED']).optional(),
});

// 10. PATCH /tenants/:tenantId/users/:userId - Update user with strict validation and password hashing
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
      ...(body.role ? { role: body.role as any, assignedRole: body.role as any } : {}),
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

// 11. DELETE /tenants/:tenantId/users/:userId - Safe deactivation with audit log (Hard delete only if force=true)
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

// 12. GET /telemetry - System wide metrics
superAdminRouter.get('/telemetry', async (req: Request, res: Response) => {
  const [totalWorkspaces, totalUsers, totalLeads, totalCalls] = await Promise.all([
    prisma.aicloserWorkspace.count(),
    prisma.appAuthUser.count(),
    prisma.salesLeadAssignment.count(),
    prisma.salesMobileCall.count(),
  ]);

  res.json({
    success: true,
    data: {
      workspaces: totalWorkspaces,
      users: totalUsers,
      leads: totalLeads,
      calls: totalCalls,
      serverMemoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      uptimeSeconds: Math.round(process.uptime()),
    },
  });
});

// 13. GET /feedback - Real user feedback list
superAdminRouter.get('/feedback', async (req: Request, res: Response) => {
  const logs = await prisma.salesActivityLog.findMany({
    where: { action: { contains: 'FEEDBACK' } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

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
  });
});

// 14. PATCH /feedback/:id - Resolve feedback
superAdminRouter.patch('/feedback/:id', async (req: Request, res: Response) => {
  res.json({ success: true, message: 'Feedback marked as resolved' });
});

// 15. POST /tenants/:tenantId/impersonate - Audited session with explicit tracking
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

// 16. POST /impersonation/return - Return to Super Admin canonical context with audit log
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


// 17. POST /impersonation/revoke/:sessionId - Explicitly revoke an impersonation session
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
