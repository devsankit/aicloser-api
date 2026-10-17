import { Router, Request, Response } from 'express';
import { scryptSync, timingSafeEqual, randomUUID, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { authenticate } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import { AuthenticatedUser } from '../../types/auth.js';
import { acquireClientSession, ClientSlotOccupiedError, closeClientSession, touchClientSession } from '../../lib/client-sessions.js';
import { logger } from '../../lib/logger.js';

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
  replaceExisting: z.boolean().optional(),
  force: z.boolean().optional(),
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
  const installationId = req.body.installationId || req.header('x-installation-id') || (clientType === 'DESKTOP' ? 'web-session-' + randomUUID().slice(0, 12) : null);

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
      replaceExisting: req.body.replaceExisting !== false,
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
    phone: user.phone ?? '',
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

  // Set secure HTTP-only cookies (dual bridge: modern aicloser_token and legacy gx_session)
  const cookieOptions = {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };
  res.cookie('aicloser_token', token, cookieOptions);
  res.cookie('gx_session', token, cookieOptions);

  res.json({
    success: true,
    data: {
      token,
      user: userPayload,
      resumed: clientSession.resumed,
    },
    error: null,
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

authRouter.get('/me', authenticate, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  const dbUser = userId ? await prisma.appAuthUser.findUnique({
    where: { id: userId },
    include: {
      salesAgentProfile: true,
      AicloserWorkspace: true,
    },
  }) : null;

  const rolePermissions = (dbUser?.AicloserWorkspace?.settings as { rolePermissions?: Record<string, Record<string, boolean>> } | null)?.rolePermissions?.[dbUser?.role || 'SALES_AGENT'] || {};
  const freshPermissions = { ...rolePermissions, ...((dbUser?.salesAgentProfile?.permissions as Record<string, boolean>) || {}) };

  res.json({
    success: true,
    data: {
      user: {
        ...req.user,
        role: (dbUser?.role as AuthenticatedUser['role']) || req.user?.role,
        displayName: dbUser?.displayName || req.user?.displayName,
        email: dbUser?.email || req.user?.email,
        phone: dbUser?.phone || req.user?.phone,
        agentProfileId: dbUser?.salesAgentProfile?.id,
        agentCode: dbUser?.salesAgentProfile?.agentCode,
        permissions: freshPermissions,
      },
      tenantId: dbUser?.tenantId || req.user?.tenantId,
      workspace: dbUser?.AicloserWorkspace ? {
        id: dbUser.AicloserWorkspace.id,
        name: dbUser.AicloserWorkspace.name,
        slug: dbUser.AicloserWorkspace.slug,
        planTier: dbUser.AicloserWorkspace.planTier,
      } : null,
    },
  });
});

authRouter.post('/logout', authenticate, async (req: Request, res: Response) => {
  if (req.user?.sessionId) await closeClientSession(req.user.sessionId, 'LOGGED_OUT');
  res.clearCookie('aicloser_token');
  res.clearCookie('gx_session');
  res.json({ success: true, message: 'Logged out successfully' });
});


// ==========================================
// Company Registration / Signup Endpoint
// ==========================================
const signupSchema = z.object({
  companyName: z.string().min(2, 'Company name is required'),
  adminName: z.string().min(2, 'Admin full name is required'),
  email: z.string().email('Valid email is required'),
  phone: z.string().min(10, 'Valid 10-digit phone number is required'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  industry: z.string().optional(),
  teamSize: z.string().optional(),
});

authRouter.post('/signup', validateBody(signupSchema), async (req: Request, res: Response) => {
  const { companyName, adminName, email, phone, password, industry, teamSize } = req.body;
  const normalizedEmail = email.toLowerCase().trim();
  const rawDigits = phone.replace(/\D/g, '');
  const normalizedPhone = phone.startsWith('+') ? phone.trim() : (rawDigits.length === 10 ? `+91${rawDigits}` : `+${rawDigits}`);

  // Deduplication check
  const existing = await prisma.appAuthUser.findFirst({
    where: {
      OR: [
        { email: normalizedEmail },
        { phone: normalizedPhone },
        { loginPhoneAliases: { has: normalizedPhone } },
      ],
    },
  });

  if (existing) {
    res.status(409).json({
      success: false,
      error: 'Conflict',
      message: 'An account with this email or phone number already exists',
    });
    return;
  }

  const workspaceId = 'ws-' + randomUUID().slice(0, 10);
  const userId = 'usr-' + randomUUID().slice(0, 10);
  const baseSlug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';
  const workspaceSlug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;

  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');

  const planTierSelected = req.body.planTier || 'STARTER';

  // Atomic transactional provisioning: Workspace + Owner User + Owner Profile
  const { workspace, user } = await prisma.$transaction(async (tx) => {
    const ws = await tx.aicloserWorkspace.create({
      data: {
        id: workspaceId,
        name: companyName,
        slug: workspaceSlug,
        planTier: planTierSelected,
        status: 'ACTIVE',
        settings: {
          industry: industry || 'B2B Sales',
          teamSize: teamSize || '1-10',
          roundRobinSettings: {
            enabled: true,
            mode: 'STRICT_ROUND_ROBIN',
            maxActiveLeadsPerCloser: 50,
            lastAssignedAgentId: null,
          },
          sourceDistributionRules: [],
          security: {
            maskCustomerPhone: false,
          },
          aiBotConfig: {
            enabled: false,
            personaPrompt: 'You are an elite B2B consultative closer.',
            trainingQA: [],
            objectionHandlers: [],
          },
        },
      },
    });

    const usr = await tx.appAuthUser.create({
      data: {
        id: userId,
        role: 'ADMIN',
        assignedRole: 'ADMIN',
        tenantId: ws.id,
        displayName: adminName,
        email: normalizedEmail,
        phone: normalizedPhone,
        passwordSalt: salt,
        passwordHash: hash,
        otpCode: '000000',
        packageStatus: 'ACTIVE',
        packageName: planTierSelected,
      },
    });

    const adminCode = 'OWNER-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    await tx.salesAgentProfile.create({
      data: {
        userId: usr.id,
        tenantId: ws.id,
        agentCode: adminCode,
        status: 'ACTIVE',
        canClaimLeads: false, // Strict admin exclusion from round robin
      },
    });

    return { workspace: ws, user: usr };
  });

  const installationId = req.body.installationId || req.header('x-installation-id') || ('web-session-' + randomUUID().slice(0, 12));
  let clientSession;
  try {
    clientSession = await acquireClientSession({
      userId: user.id,
      tenantId: workspace.id,
      channel: 'DESKTOP',
      installationId,
      deviceId: installationId,
      deviceName: 'Desktop Web',
      platform: 'WEB',
      replaceExisting: true,
    });
  } catch (err) {
    logger.warn('Failed to acquire initial client session during signup', { error: err instanceof Error ? err.message : err });
  }

  // 4. Issue session JWT
  const userPayload: AuthenticatedUser = {
    userId: user.id,
    role: 'ADMIN',
    tenantId: workspace.id,
    displayName: user.displayName,
    phone: user.phone ?? '',
    email: user.email,
    sessionId: clientSession?.session?.sessionId || randomUUID(),
    clientType: 'DESKTOP',
  };

  const token = jwt.sign(userPayload, env.JWT_SECRET, { expiresIn: '30d' });

  const cookieOptions = {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };
  res.cookie('aicloser_token', token, cookieOptions);
  res.cookie('gx_session', token, cookieOptions);

  res.status(201).json({
    success: true,
    message: 'Company workspace registered successfully',
    data: {
      token,
      user: userPayload,
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        plan: workspace.planTier,
      },
    },
    error: null,
  });
});
