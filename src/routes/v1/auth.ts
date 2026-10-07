import { Router, Request, Response } from 'express';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { authenticate } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import { AuthenticatedUser } from '../../types/auth.js';
import { acquireClientSession, ClientSlotOccupiedError, closeClientSession, touchClientSession } from '../../lib/client-sessions.js';

export const authRouter = Router();

const loginSchema = z.object({
  identifier: z.string().min(3, 'Phone or email required'),
  password: z.string().min(1, 'Password required'),
  clientType: z.enum(['MOBILE', 'DESKTOP']).default('DESKTOP'),
  installationId: z.string().min(1).max(200).optional(),
  deviceId: z.string().max(200).optional(),
  deviceName: z.string().max(200).optional(),
  platform: z.string().max(80).optional(),
  appVersion: z.string().max(80).optional(),
});

function passwordsMatch(password: string, salt: string, expectedHash: string) {
  try {
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHash, 'hex');
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function invalidCredentials(res: Response) {
  res.status(401).json({
    success: false,
    error: 'InvalidCredentials',
    message: 'Invalid email/phone or password',
  });
}

authRouter.post('/login', validateBody(loginSchema), async (req: Request, res: Response) => {
  const { identifier, password, clientType, deviceId, deviceName, platform, appVersion } = req.body;
  const installationId = req.body.installationId || req.header('x-installation-id') || null;

  // Search user by email or phone
  const user = await prisma.appAuthUser.findFirst({
    where: {
      OR: [
        { email: identifier.toLowerCase() },
        { phone: identifier },
        { loginPhoneAliases: { has: identifier } },
      ],
    },
    select: {
      id: true,
      role: true,
      tenantId: true,
      displayName: true,
      phone: true,
      email: true,
      passwordHash: true,
      passwordSalt: true,
    },
  });

  if (!user) {
    invalidCredentials(res);
    return;
  }

  if (!passwordsMatch(password, user.passwordSalt, user.passwordHash)) {
    invalidCredentials(res);
    return;
  }

  if (!installationId) {
    res.status(400).json({
      success: false,
      error: 'MissingClientIdentity',
      message: 'clientType and installationId are required to create a licensed session',
    });
    return;
  }

  let clientSession;
  try {
    clientSession = await acquireClientSession({
      userId: user.id,
      tenantId: user.tenantId,
      channel: clientType,
      installationId,
      deviceId: deviceId ?? (clientType === 'MOBILE' ? installationId : null),
      deviceName: deviceName ?? null,
      platform: platform ?? (clientType === 'MOBILE' ? 'ANDROID' : 'WEB'),
      appVersion: appVersion ?? null,
    });
  } catch (error) {
    if (error instanceof ClientSlotOccupiedError) {
      res.status(409).json({
        success: false,
        error: error.code,
        message: `This user already has an active ${clientType.toLowerCase()} session`,
        data: {
          clientType,
          lastActiveAt: error.lastActiveAt?.toISOString() ?? null,
          deviceName: error.deviceName,
        },
      });
      return;
    }
    throw error;
  }

  // Issue session JWT
  const userPayload: AuthenticatedUser = {
    userId: user.id,
    role: user.role as AuthenticatedUser['role'],
    tenantId: user.tenantId,
    displayName: user.displayName,
    phone: user.phone,
    email: user.email,
    sessionId: clientSession.session.sessionId,
    clientType,
  };

  const token = jwt.sign(userPayload, env.JWT_SECRET, { expiresIn: '30d' });

  // Update account-level last login after the licensed session is acquired.
  await prisma.appAuthUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  // Set secure HTTP-only cookie
  res.cookie('aicloser_token', token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.json({
    success: true,
    data: {
      token,
      user: userPayload,
      resumed: clientSession.resumed,
    },
  });
});

authRouter.post('/heartbeat', authenticate, async (req: Request, res: Response) => {
  if (!req.user?.sessionId) {
    res.status(401).json({ success: false, error: 'SessionBindingRequired', message: 'A licensed client session is required' });
    return;
  }
  const session = await touchClientSession(req.user.sessionId);
  if (!session) {
    res.status(401).json({ success: false, error: 'SessionRevoked', message: 'This client session is no longer active' });
    return;
  }
  res.json({ success: true, data: { lastActiveAt: session.lastActiveAt } });
});

authRouter.get('/me', authenticate, (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      user: req.user,
      tenantId: req.user?.tenantId,
    },
  });
});

authRouter.post('/logout', authenticate, async (req: Request, res: Response) => {
  if (req.user?.sessionId) await closeClientSession(req.user.sessionId, 'LOGGED_OUT');
  res.clearCookie('aicloser_token');
  res.clearCookie('gx_session');
  res.json({ success: true, message: 'Logged out successfully' });
});
