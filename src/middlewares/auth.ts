import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AuthenticatedUser } from '../types/auth.js';
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

    // Cryptographic signature verification - NO UNVERIFIED DECODE FALLBACK ALLOWED
    try {
      decoded = jwt.verify(token, env.JWT_SECRET) as AuthenticatedUser;
    } catch (e) {
      const fallbackSecret = process.env.GIGXOMI_SESSION_SECRET;
      if (fallbackSecret) {
        try {
          decoded = jwt.verify(token, fallbackSecret) as AuthenticatedUser;
        } catch {
          res.status(401).json({
            success: false,
            data: null,
            error: 'InvalidTokenSignature',
            message: 'Authentication token signature verification failed',
          });
          return;
        }
      } else {
        res.status(401).json({
          success: false,
          data: null,
          error: 'InvalidTokenSignature',
          message: 'Authentication token signature verification failed',
        });
        return;
      }
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

    // Role mapping for legacy roles
    let role = decoded.role;
    if (role === 'AGENCY') role = 'ADMIN';
    if (role === 'FREELANCER') role = 'SALES_AGENT';

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
          role: true,
          tenantId: true,
          AicloserWorkspace: { select: { status: true } },
          salesAgentProfile: { select: { status: true } },
        },
      });

      if (dbUser) {
        const isSuspended =
          dbUser.packageStatus === 'PAUSED' ||
          dbUser.packageStatus === 'EXPIRED' ||
          (dbUser.packageStatus as string) === 'SUSPENDED' ||
          (dbUser.packageStatus as string) === 'INACTIVE' ||
          dbUser.salesAgentProfile?.status === 'SUSPENDED';

        if (isSuspended) {
          res.status(403).json({
            success: false,
            data: null,
            error: 'AccountSuspended',
            message: 'Your user account or sales profile is suspended or inactive. Contact your administrator.',
          });
          return;
        }

        if (dbUser.AicloserWorkspace && (dbUser.AicloserWorkspace.status === 'SUSPENDED' || dbUser.AicloserWorkspace.status === 'LOCKED')) {
          res.status(403).json({
            success: false,
            data: null,
            error: 'WorkspaceLocked',
            message: `Workspace is ${dbUser.AicloserWorkspace.status.toLowerCase()}. Access is restricted.`,
          });
          return;
        }

        // Canonical server authority takes precedence over client token claims
        authenticatedUser.role = (dbUser.role as any) || authenticatedUser.role;
        if (dbUser.tenantId) {
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
