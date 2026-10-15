import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AuthenticatedUser } from '../types/auth.js';
import { getActiveClientSession } from '../lib/client-sessions.js';

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    let token: string | null = null;

    // 1. Check Authorization Bearer header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } 
    // 2. Check query string (Critical for native EventSource SSE which cannot send headers)
    else if (typeof req.query?.token === 'string' && req.query.token.trim()) {
      token = req.query.token.trim();
    } else if (typeof req.query?.accessToken === 'string' && req.query.accessToken.trim()) {
      token = req.query.accessToken.trim();
    }
    // 3. Check HTTP-only cookies
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

    const decoded = jwt.verify(token, env.JWT_SECRET) as AuthenticatedUser;

    if (!decoded.userId || !decoded.role) {
      res.status(401).json({
        success: false,
        data: null,
        error: 'Unauthorized',
        message: 'Malformed token claims',
      });
      return;
    }

    if (decoded.sessionId) {
      const clientSession = await getActiveClientSession(decoded.sessionId);
      if (!clientSession || clientSession.status !== 'ACTIVE' || clientSession.userId !== decoded.userId) {
        res.status(401).json({
          success: false,
          data: null,
          error: 'SessionRevoked',
          message: 'This client session is no longer active',
        });
        return;
      }
    }

    req.user = decoded;
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
