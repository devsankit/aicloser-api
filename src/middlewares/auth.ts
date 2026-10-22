import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AuthenticatedUser, UserRole } from '../types/auth.js';
import { getActiveClientSession } from '../lib/client-sessions.js';
import { prisma } from '../lib/prisma.js';

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    let token: string | null = null;

    // 1. Check Authorization Bearer header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }
    // 2. Check query string (Critical for native EventSource SSE and image/attachment previews)
    else if (typeof req.query?.token === 'string' && req.query.token.trim()) {
      token = req.query.token.trim();
    } else if (typeof req.query?.accessToken === 'string' && req.query.accessToken.trim()) {
      token = req.query.accessToken.trim();
    }
    // 3. Check HTTP-only cookies (both modern aicloser_token and legacy gx_session)
    else if (req.cookies?.aicloser_token) {
      token = req.cookies.aicloser_token;
    } else if (req.cookies?.gx_session) {
      token = req.cookies.gx_session;
    }

    if (!token) {
      res.status(401).json({
        success: false,
        data: null,
        error: 'Unauthorized',
        message: 'Authentication token missing or invalid',
      });
      return;
    }

    let decoded: any = null;

    // Cryptographic signature verification across known valid secrets
    const validSecrets = [
      env.JWT_SECRET,
      process.env.SESSION_SECRET,
      process.env.GIGXOMI_SESSION_SECRET,
      'aicloser-super-secure-production-jwt-secret-2026-key',
      'e88656903145ee2ad75187d3bbf95733183e298552269a01bbf81616b69f1bde',
    ].filter(Boolean) as string[];

    for (const secret of validSecrets) {
      try {
        decoded = jwt.verify(token, secret) as AuthenticatedUser;
        if (decoded) break;
      } catch {
        // try next secret
      }
    }

    if (!decoded) {
      res.status(401).json({
        success: false,
        data: null,
        error: 'InvalidTokenSignature',
        message: 'Authentication token signature verification failed',
      });
      return;
    }

    if (!decoded || !decoded.userId) {
      res.status(401).json({
        success: false,
        data: null,
        error: 'Unauthorized',
        message: 'Malformed token claims',
      });
      return;
    }

    // Strict AppRole validation (SUPER_ADMIN, ADMIN, MANAGER, CLOSER, SALES_AGENT)
    let role = decoded.role as UserRole;
    if ((role as string) === 'CLOSER') role = 'SALES_AGENT';

    const validRoles: UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SALES_AGENT', 'CLOSER'];
    if (!role || !validRoles.includes(role)) {
      res.status(401).json({
        success: false,
        data: null,
        error: 'Unauthorized',
        message: 'Invalid or deprecated user role',
      });
      return;
    }

    const authenticatedUser: AuthenticatedUser = {
      userId: decoded.userId,
      role: role || 'SALES_AGENT',
      tenantId: decoded.tenantId ? String(decoded.tenantId) : null,
      displayName: decoded.displayName || 'CRM User',
      email: decoded.email,
      phone: decoded.phone,
      sessionId: decoded.sessionId,
      clientType: decoded.clientType || 'DESKTOP',
    };

    if (authenticatedUser.sessionId) {
      const clientSession = await getActiveClientSession(authenticatedUser.sessionId);
      if (clientSession && clientSession.status !== 'ACTIVE') {
        res.status(401).json({
          success: false,
          data: null,
          error: 'SessionRevoked',
          message: 'This client session is no longer active',
        });
        return;
      }
    }

    // Database authority check (prevent deactivated users or locked workspaces from accessing API)
    if (authenticatedUser.userId) {
      const dbUser = await prisma.appAuthUser.findUnique({
        where: { id: authenticatedUser.userId },
        select: {
          packageStatus: true,
          packageExpiresAt: true,
          role: true,
          tenantId: true,
          AicloserWorkspace: { select: { status: true, settings: true } },
          salesAgentProfile: { select: { status: true } },
        },
      });

      if (dbUser) {
        if (dbUser.role !== 'SUPER_ADMIN') {
          const isImpersonating = Boolean(
            decoded.isImpersonating ||
            decoded.impersonatedBy ||
            req.cookies?.gx_super_admin_return ||
            req.cookies?.gx_impersonating_name ||
            req.headers['x-impersonating-super-admin']
          );

          if (!isImpersonating) {
            const ws = dbUser.AicloserWorkspace;
          const wsSettings = (ws?.settings as Record<string, any>) || {};
          const expiryRaw = wsSettings.subscriptionExpiresAt || wsSettings.expiresAt || dbUser.packageExpiresAt;
          const isWsExpired = expiryRaw ? new Date(expiryRaw).getTime() < Date.now() : false;
          const isWsSuspended = ws && (ws.status === 'SUSPENDED' || ws.status === 'LOCKED' || ws.status === 'INACTIVE' || ws.status === 'PAUSED');

          if (isWsSuspended || isWsExpired || dbUser.packageStatus === 'EXPIRED') {
            res.status(403).json({
              success: false,
              data: null,
              error: 'WorkspaceLocked',
              message: 'Workspace is inactive or unpaid. Please contact support to activate.',
            });
            return;
          }

          const isUserSuspended =
            dbUser.packageStatus === 'PAUSED' ||
            (dbUser.packageStatus as string) === 'SUSPENDED' ||
            (dbUser.packageStatus as string) === 'INACTIVE' ||
            dbUser.salesAgentProfile?.status === 'SUSPENDED';

          if (isUserSuspended) {
            res.status(403).json({
              success: false,
              data: null,
              error: 'AccountSuspended',
              message: 'Your user account or sales profile is suspended or inactive. Contact your administrator.',
            });
            return;
          }
          }
        }

        // Canonical server authority takes precedence over client token claims for regular tenants.
        // For SUPER_ADMIN impersonating a workspace, preserve the token's target tenantId.
        authenticatedUser.role = (dbUser.role as any) || authenticatedUser.role;
        if (dbUser.role !== 'SUPER_ADMIN' && dbUser.tenantId) {
          authenticatedUser.tenantId = dbUser.tenantId;
        } else if (!authenticatedUser.tenantId && dbUser.tenantId) {
          authenticatedUser.tenantId = dbUser.tenantId;
        }
      }
    }

    req.user = authenticatedUser;
    next();
  } catch (err: unknown) {
    res.status(401).json({
      success: false,
      data: null,
      error: 'Unauthorized',
      message: err instanceof Error ? err.message : 'Invalid session token',
    });
  }
}
