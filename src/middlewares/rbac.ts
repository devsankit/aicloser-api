import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../types/auth.js';
import { prisma } from '../lib/prisma.js';

export const PERM_TEAM_VIEW = 'team:view';
export const PERM_TEAM_MANAGE = 'team:manage';
export const PERM_LEADS_REASSIGN = 'leads:reassign';
export const PERM_LEADS_EXPORT = 'leads:export';
export const PERM_CALLS_VIEW_ALL = 'calls:view_all';
export const PERM_RECORDINGS_PLAY_ALL = 'recordings:play_all';

export function requireRoles(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;

    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    if (!allowedRoles.includes(user.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Insufficient permissions: role ' + user.role + ' is not authorized for this resource',
      });
      return;
    }

    next();
  };
}

export function requirePermissions(...requiredPermissions: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    const tenantId = req.tenantId;

    if (!user || !tenantId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication and tenant context required',
      });
      return;
    }

    // Super Admin and Admin have all workspace permissions unconditionally
    if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') {
      next();
      return;
    }

    // Manager default capabilities
    if (user.role === 'MANAGER') {
      const managerDisallowed = [PERM_TEAM_MANAGE];
      const hasDenied = requiredPermissions.some((p) => managerDisallowed.includes(p));
      if (!hasDenied) {
        next();
        return;
      }
    }

    // Check granular agent profile permissions for SALES_AGENT
    if (user.role === 'SALES_AGENT') {
      const profile = await prisma.salesAgentProfile.findFirst({
        where: { userId: user.userId, tenantId },
        select: { permissions: true, canClaimLeads: true, canCreateSubAgents: true },
      });

      if (profile) {
        const perms = (profile.permissions as Record<string, boolean> | null) || {};
        const hasAll = requiredPermissions.every((perm) => Boolean(perms[perm]));
        if (hasAll) {
          next();
          return;
        }
      }
    }

    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'You lack the required granular permission: ' + requiredPermissions.join(', '),
    });
  };
}
