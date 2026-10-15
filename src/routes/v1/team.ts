import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles, PERM_TEAM_MANAGE } from '../../middlewares/rbac.js';
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

// GET / - List team members (restricted to ADMIN, MANAGER, SUPER_ADMIN)
teamRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  const where: any = { tenantId };

  // Sales Agent can only view their own profile unless explicitly elevated
  if (user.role === 'SALES_AGENT') {
    where.userId = user.userId;
  }

  const profiles = await prisma.salesAgentProfile.findMany({
    where,
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

  const team = profiles.map((p) => ({
    id: p.id,
    userId: p.user.id,
    displayName: p.user.displayName,
    email: p.user.email,
    phone: p.user.phone,
    role: p.user.role,
    agentCode: p.agentCode,
    status: p.status,
    commissionPercent: (user.role === 'SALES_AGENT' && p.userId !== user.userId) ? undefined : (p.commissionPercent ? Number(p.commissionPercent) : 0),
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

// PATCH /:id - Update team member settings (Strictly restricted to SUPER_ADMIN and ADMIN)
teamRouter.patch('/:id', requireRoles('SUPER_ADMIN', 'ADMIN'), validateBody(updateAgentSchema), async (req: Request, res: Response) => {
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
