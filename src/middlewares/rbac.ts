import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../types/auth.js';
import { prisma } from '../lib/prisma.js';

export const PERM_TEAM_VIEW = 'team:view';
export const PERM_TEAM_MANAGE = 'team:manage';
export const PERM_LEADS_VIEW_ALL = 'leads:view_all';
export const PERM_LEADS_CLAIM = 'leads:claim';
export const PERM_LEADS_REASSIGN = 'leads:reassign';
export const PERM_LEADS_EXPORT = 'leads:export';
export const PERM_CALLS_VIEW_ALL = 'calls:view_all';
export const PERM_RECORDINGS_PLAY_ALL = 'recordings:play_all';
export const PERM_LEADS_DELETE = 'leads:delete';

export async function hasPermission(
  userId: string,
  tenantId: string,
  role: UserRole,
  permission: string
): Promise<boolean> {
  // Super Admin and Admin have all permissions unconditionally
  if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
    return true;
  }

  // Check AppAuthUser permissions array
  const authUser = await prisma.appAuthUser.findFirst({
    where: { id: userId, tenantId },
    select: { permissions: true },
  });

  if (authUser?.permissions && authUser.permissions.includes(permission)) {
    return true;
  }

  // Manager defaults
  if (role === 'MANAGER') {
    const managerDenied = [PERM_TEAM_MANAGE];
    if (!managerDenied.includes(permission)) {
      return true;
    }
  }

  // Check granular agent profile permissions for SALES_AGENT
  if (role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId, tenantId },
      select: { permissions: true, canClaimLeads: true },
    });

    if (profile) {
      if (profile.permissions && typeof profile.permissions === 'object') {
        const perms = profile.permissions as Record<string, boolean>;
        if (perms[permission] === true) return true;
      }
      if (permission === PERM_LEADS_CLAIM && profile.canClaimLeads) {
        return true;
      }
    }
  }

  return false;
}

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

    if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') {
      next();
      return;
    }

    for (const perm of requiredPermissions) {
      const allowed = await hasPermission(user.userId, tenantId, user.role, perm);
      if (!allowed) {
        res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: `You lack the required granular permission: ${perm}`,
        });
        return;
      }
    }

    next();
  };
}
