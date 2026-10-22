import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

export async function enforceTenantIsolation(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = req.user;

  if (!user) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Authentication required for tenant-scoped operations',
    });
    return;
  }

  // 1. SUPER_ADMIN Handling
  if (user.role === 'SUPER_ADMIN') {
    const rawTarget = req.headers['x-target-tenant-id'];
    const targetTenant = typeof rawTarget === 'string' ? rawTarget.trim() : undefined;

    if (targetTenant) {
      // Verify target workspace exists in canonical registry
      const workspace = await prisma.aicloserWorkspace.findUnique({
        where: { id: targetTenant },
        select: { id: true, name: true, status: true },
      });

      if (!workspace) {
        logger.warn('SUPER_ADMIN attempted cross-tenant override with unknown tenant', {
          actorId: user.userId,
          targetTenantId: targetTenant,
          path: req.originalUrl,
          ip: req.ip,
        });

        res.status(404).json({
          success: false,
          error: 'WorkspaceNotFound',
          message: `Target workspace "${targetTenant}" does not exist in canonical registry`,
        });
        return;
      }

      req.tenantId = targetTenant;
      req.isSuperAdminOverride = true;

      // Sanitize body/query to enforce the target tenant
      if (req.body && typeof req.body === 'object') {
        req.body.tenantId = targetTenant;
      }

      logger.info('SUPER_ADMIN audited cross-tenant override', {
        actorId: user.userId,
        targetTenantId: targetTenant,
        workspaceName: workspace.name,
        path: req.originalUrl,
        method: req.method,
        ip: req.ip,
      });

      next();
      return;
    }

    if (user.tenantId) {
      req.tenantId = user.tenantId;
      req.isSuperAdminOverride = true;
      if (req.body && typeof req.body === 'object') {
        req.body.tenantId = user.tenantId;
      }
      next();
      return;
    }

    // Super admin without tenant context cannot access tenant-scoped resources
    res.status(400).json({
      success: false,
      error: 'SuperAdminTenantContextRequired',
      message: 'Super Admin must specify x-target-tenant-id header with a valid workspace ID to access tenant resources',
    });
    return;
  }

  // 2. Standard Tenant User Handling (ADMIN, MANAGER, SALES_AGENT, etc.)
  if (!user.tenantId) {
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'User is not bound to a workspace/tenant',
    });
    return;
  }

  // Detect and reject any client attempt to spoof tenant via header, query, or body
  const headerTenant = req.headers['x-target-tenant-id'] as string | undefined;
  const queryTenant = typeof req.query?.tenantId === 'string' ? req.query.tenantId : undefined;
  const bodyTenant = typeof req.body?.tenantId === 'string' ? req.body.tenantId : undefined;

  const attemptedSpoof =
    (headerTenant && headerTenant !== user.tenantId) ||
    (queryTenant && queryTenant !== user.tenantId) ||
    (bodyTenant && bodyTenant !== user.tenantId);

  if (attemptedSpoof) {
    logger.warn('Cross-tenant spoof attempt blocked', {
      actorId: user.userId,
      userTenantId: user.tenantId,
      attemptedHeaderTenant: headerTenant,
      attemptedQueryTenant: queryTenant,
      attemptedBodyTenant: bodyTenant,
      path: req.originalUrl,
      ip: req.ip,
    });

    res.status(403).json({
      success: false,
      code: 'TENANT_ISOLATION_VIOLATION',
      error: 'TenantIsolationViolation',
      message: 'Access denied: Client cannot query or mutate data outside their assigned workspace',
    });
    return;
  }

  // STRICTLY bind req.tenantId to server session tenantId and sanitize body/query
  req.tenantId = user.tenantId;
  if (req.body && typeof req.body === 'object') {
    req.body.tenantId = user.tenantId;
  }

  // Verify workspace status & subscription validity
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: user.tenantId },
    select: { id: true, name: true, status: true, settings: true },
  });

  if (!workspace) {
    res.status(404).json({
      success: false,
      error: 'WorkspaceNotFound',
      message: 'Assigned workspace not found in canonical registry',
    });
    return;
  }

  const workspaceSettings = (workspace.settings as Record<string, any>) || {};
  const isSuspended = workspace.status === 'SUSPENDED' || workspace.status === 'INACTIVE' || workspace.status === 'PAUSED';
  
  const expiryRaw = workspaceSettings.subscriptionExpiresAt || workspaceSettings.expiresAt;
  const isExpired = expiryRaw ? new Date(expiryRaw).getTime() < Date.now() : false;

  if (isSuspended || isExpired) {
    res.status(403).json({
      success: false,
      error: 'WorkspaceLocked',
      message: 'Workspace is inactive or unpaid. Please contact support to activate.',
    });
    return;
  }

  next();
}
