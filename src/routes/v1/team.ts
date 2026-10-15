import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requirePermissions, PERM_TEAM_VIEW, PERM_TEAM_MANAGE } from '../../middlewares/rbac.js';
import { validateBody } from '../../middlewares/validate.js';
import { SalesAgentStatus } from '@prisma/client';

export const teamRouter = Router();

teamRouter.use(authenticate, enforceTenantIsolation);

const updateAgentSchema = z.object({
  status: z.nativeEnum(SalesAgentStatus).optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
  canClaimLeads: z.boolean().optional(),
  maxActiveLeads: z.number().optional(),
  permissions: z.record(z.boolean()).optional(),
});

// GET /me - Get own profile (accessible by any authenticated workspace user)
teamRouter.get('/me', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  const profile = await prisma.salesAgentProfile.findFirst({
    where: { userId: user.userId, tenantId },
    include: {
      user: {
        select: {
          id: true,
          displayName: true,
          email: true,
          phone: true,
          role: true,
        },
      },
      _count: {
        select: {
          leadAssignments: true,
          mobileCalls: true,
        },
      },
    },
  });

  if (!profile) {
    res.json({
      success: true,
      data: {
        userId: user.userId,
        displayName: user.displayName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        agentCode: null,
        status: 'ACTIVE',
        commissionPercent: null,
        canClaimLeads: false,
        permissions: {},
        assignedLeadsCount: 0,
        callsCount: 0,
      },
    });
    return;
  }

  res.json({
    success: true,
    data: {
      id: profile.id,
      userId: profile.user.id,
      displayName: profile.user.displayName,
      email: profile.user.email,
      phone: profile.user.phone,
      role: profile.user.role,
      agentCode: profile.agentCode,
      status: profile.status,
      commissionPercent: profile.commissionPercent ? Number(profile.commissionPercent) : 0,
      canClaimLeads: profile.canClaimLeads,
      maxActiveLeads: profile.maxActiveLeads,
      permissions: profile.permissions || {},
      assignedLeadsCount: profile._count.leadAssignments,
      callsCount: profile._count.mobileCalls,
      createdAt: profile.createdAt,
    },
  });
});

// GET / - List team members (Restricted to team:view permission - ADMIN and MANAGER by default)
teamRouter.get('/', requirePermissions(PERM_TEAM_VIEW), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  const profiles = await prisma.salesAgentProfile.findMany({
    where: { tenantId },
    include: {
      user: {
        select: {
          id: true,
          displayName: true,
          email: true,
          phone: true,
          role: true,
        },
      },
      _count: {
        select: {
          leadAssignments: true,
          mobileCalls: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const canSeeCommissions = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';

  const team = profiles.map((p) => ({
    id: p.id,
    userId: p.user.id,
    displayName: p.user.displayName,
    email: p.user.email,
    phone: p.user.phone,
    role: p.user.role,
    agentCode: p.agentCode,
    status: p.status,
    commissionPercent: canSeeCommissions || p.userId === user.userId
      ? (p.commissionPercent ? Number(p.commissionPercent) : 0)
      : undefined,
    canClaimLeads: p.canClaimLeads,
    maxActiveLeads: p.maxActiveLeads,
    permissions: p.permissions,
    assignedLeadsCount: p._count.leadAssignments,
    callsCount: p._count.mobileCalls,
    createdAt: p.createdAt,
  }));

  res.json({
    success: true,
    data: team,
  });
});

// PATCH /:id - Update team member settings (Strictly restricted to team:manage permission)
teamRouter.patch('/:id', requirePermissions(PERM_TEAM_MANAGE), validateBody(updateAgentSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof updateAgentSchema>;

  const profile = await prisma.salesAgentProfile.findFirst({
    where: { id, tenantId },
  });

  if (!profile) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Team member profile not found in this workspace' });
    return;
  }

  const updated = await prisma.salesAgentProfile.update({
    where: { id: profile.id },
    data: {
      status: body.status,
      commissionPercent: body.commissionPercent,
      canClaimLeads: body.canClaimLeads,
      maxActiveLeads: body.maxActiveLeads,
      ...(body.permissions !== undefined ? { permissions: body.permissions as any } : {}),
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      actorUserId: req.user?.userId,
      action: 'TEAM_MEMBER_SETTINGS_UPDATED',
      note: 'Team member settings updated for agent ' + profile.agentCode,
      metadata: { targetProfileId: id, changes: body },
    },
  }).catch(() => undefined);

  res.json({
    success: true,
    data: updated,
    message: 'Team member settings updated successfully',
  });
});
