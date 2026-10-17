import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../types/auth.js';
import { prisma } from '../lib/prisma.js';

export const PERM_TEAM_VIEW = 'team:view';
export const PERM_TEAM_MANAGE = 'team:manage';
export const PERM_LEADS_VIEW_ALL = 'leads:view_all';
export const PERM_CONTACTS_VIEW = 'contacts:view';
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

  // Check the canonical profile permission map for managers and closers.
  // An explicit false must deny access; previously managers bypassed this
  // branch and therefore saw contacts even after an admin disabled access.
  if (role === 'MANAGER' || role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId, tenantId },
      select: { permissions: true, canClaimLeads: true },
    });

    if (profile) {
      const perms = profile.permissions && typeof profile.permissions === 'object'
        ? profile.permissions as Record<string, boolean>
        : {};
      if (Object.prototype.hasOwnProperty.call(perms, permission)) {
        return perms[permission] === true;
      }

      // Backward-compatible defaults for profiles created before the matrix
      // was persisted. The legacy claim flag remains a fallback only for the
      // lead-claim permission.
      const workspace = await prisma.aicloserWorkspace.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const rolePermissions = (workspace?.settings as { rolePermissions?: Record<string, Record<string, boolean>> } | null)?.rolePermissions?.[role];
      if (rolePermissions && Object.prototype.hasOwnProperty.call(rolePermissions, permission)) return rolePermissions[permission] === true;
      if (permission === PERM_LEADS_CLAIM) return profile.canClaimLeads;
      if (permission === PERM_TEAM_MANAGE) return role === 'MANAGER';
      if (permission === PERM_LEADS_REASSIGN || permission === PERM_TEAM_VIEW || permission === 'payouts:approve') return role === 'MANAGER';
      if (permission === PERM_CONTACTS_VIEW) return true;
      return true;
    }
  }

  // Legacy AppAuthUser permissions remain supported for roles without a
  // canonical sales profile, but never override an explicit profile denial.
  const authUser = await prisma.appAuthUser.findFirst({
    where: { id: userId, tenantId },
    select: { permissions: true },
  });

  if (authUser?.permissions && authUser.permissions.includes(permission)) {
    return true;
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
        code: 'PERMISSION_DENIED',
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
          code: 'PERMISSION_DENIED',
          error: 'Forbidden',
          message: `You lack the required granular permission: ${perm}`,
        });
        return;
      }
    }

    next();
  };
}
