import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody } from '../../middlewares/validate.js';
import { SalesAgentStatus } from '@prisma/client';

export const teamRouter = Router();

teamRouter.use(authenticate, enforceTenantIsolation);

const updateAgentSchema = z.object({
  status: z.nativeEnum(SalesAgentStatus).optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
  canClaimLeads: z.boolean().optional(),
  maxActiveLeads: z.number().optional(),
});

teamRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

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

  const team = profiles.map((p) => ({
    id: p.id,
    userId: p.user.id,
    displayName: p.user.displayName,
    email: p.user.email,
    phone: p.user.phone,
    role: p.user.role,
    agentCode: p.agentCode,
    status: p.status,
    commissionPercent: p.commissionPercent ? Number(p.commissionPercent) : 0,
    canClaimLeads: p.canClaimLeads,
    maxActiveLeads: p.maxActiveLeads,
    assignedLeadsCount: p._count.leadAssignments,
    callsCount: p._count.mobileCalls,
    createdAt: p.createdAt,
  }));

  res.json({
    success: true,
    data: team,
  });
});

teamRouter.patch('/:id', validateBody(updateAgentSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof updateAgentSchema>;

  const profile = await prisma.salesAgentProfile.findFirst({
    where: { id, tenantId },
  });

  if (!profile) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Team member profile not found' });
    return;
  }

  const updated = await prisma.salesAgentProfile.update({
    where: { id: profile.id },
    data: {
      status: body.status,
      commissionPercent: body.commissionPercent,
      canClaimLeads: body.canClaimLeads,
      maxActiveLeads: body.maxActiveLeads,
    },
  });

  res.json({
    success: true,
    data: updated,
    message: 'Team member settings updated successfully',
  });
});
