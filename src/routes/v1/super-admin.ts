import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { authenticate } from '../../middlewares/auth.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { logger } from '../../lib/logger.js';
import { AuthenticatedUser } from '../../types/auth.js';

export const superAdminRouter = Router();

// Strictly restricted to SUPER_ADMIN role only
superAdminRouter.use(authenticate, requireRoles('SUPER_ADMIN'));

superAdminRouter.get('/tenants', async (req: Request, res: Response) => {
  logger.info('Super Admin listed all canonical workspaces', { actorId: req.user?.userId });

  const workspaces = await prisma.aicloserWorkspace.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      slug: true,
      ownerEmail: true,
      ownerPhone: true,
      status: true,
      planTier: true,
      maxSeats: true,
      createdAt: true,
      _count: {
        select: {
          users: true,
          leads: true,
          marketingContacts: true,
          conversations: true,
        },
      },
    },
  });

  res.json({ success: true, data: workspaces });
});

superAdminRouter.post('/tenants/:tenantId/impersonate', async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const actor = req.user!;

  // 1. Verify target workspace exists in canonical registry
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: String(tenantId) },
  });

  if (!workspace) {
    logger.warn('Super Admin impersonation failed: workspace not found', {
      actorId: actor.userId,
      targetTenantId: tenantId,
      ip: req.ip,
    });

    res.status(404).json({
      success: false,
      error: 'WorkspaceNotFound',
      message: `Target workspace "${tenantId}" does not exist in canonical registry`,
    });
    return;
  }

  logger.warn('Super Admin verified tenant impersonation granted', {
    actorId: actor.userId,
    targetTenantId: tenantId,
    workspaceName: workspace.name,
    ip: req.ip,
  });

  // 2. Create an explicit audited token scoped to target tenant
  const impersonatedPayload: AuthenticatedUser = {
    userId: actor.userId,
    role: 'SUPER_ADMIN',
    tenantId: String(tenantId),
    displayName: `${actor.displayName} (Viewing: ${workspace.name})`,
    phone: actor.phone,
    email: actor.email,
  };

  const token = jwt.sign(impersonatedPayload, env.JWT_SECRET, { expiresIn: '2h' });

  res.json({
    success: true,
    message: `Audited access granted for workspace "${workspace.name}" (${tenantId})`,
    data: {
      token,
      targetTenantId: tenantId,
      workspaceName: workspace.name,
      expiresIn: '2h',
    },
  });
});
