import { Router, Request, Response } from 'express';
import { scryptSync, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requirePermissions, requireRoles, PERM_TEAM_VIEW, PERM_TEAM_MANAGE } from '../../middlewares/rbac.js';
import { validateBody } from '../../middlewares/validate.js';
import { SalesAgentStatus } from '@prisma/client';

export const teamRouter = Router();

teamRouter.use(authenticate, enforceTenantIsolation);

const updateAgentSchema = z.object({
  status: z.nativeEnum(SalesAgentStatus).optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
  canClaimLeads: z.boolean().optional(),
  maxActiveLeads: z.number().optional(),
  parentAgentId: z.string().nullable().optional(),
  permissions: z.record(z.any()).optional(),
  role: z.enum(['ADMIN', 'MANAGER', 'SALES_AGENT', 'CLOSER', 'SUPER_ADMIN']).optional(),
  name: z.string().optional(),
  maxCapacity: z.number().optional(),
  displayName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  password: z.string().min(6).optional(),
});

// GET /me - Get own profile (accessible by any authenticated workspace user)
teamRouter.get('/me', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  const [profile, myPaymentLinks] = await Promise.all([
    prisma.salesAgentProfile.findFirst({
      where: { userId: user.userId, tenantId },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            email: true,
            phone: true,
            role: true,
          },
        },
        parentAgent: {
          select: {
            id: true,
            agentCode: true,
            user: { select: { displayName: true, email: true } },
          },
        },
        _count: {
          select: {
            leadAssignments: true,
            mobileCalls: true,
          },
        },
      },
    }),
    prisma.upiPaymentLink.findMany({
      where: { tenantId, createdByUserId: user.userId },
      select: { status: true, totalAmount: true },
    }),
  ]);

  const myPending = myPaymentLinks.filter(
    (pl) => pl.status === 'PENDING' || pl.status === 'CUSTOMER_CONFIRMED'
  );
  const myPaid = myPaymentLinks.filter((pl) => pl.status === 'PAID');
  const myPipelineValue = myPending.reduce((sum, pl) => sum + Number(pl.totalAmount || 0), 0);
  const myDealsWon = myPaid.length;

  if (!profile) {
    res.json({
      success: true,
      data: {
        userId: user.userId,
        displayName: user.displayName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        agentCode: null,
        status: 'ACTIVE',
        commissionPercent: null,
        canClaimLeads: false,
        permissions: {},
        assignedLeadsCount: 0,
        callsCount: 0,
        pipelineValue: myPipelineValue,
        dealsWon: myDealsWon,
      },
    });
    return;
  }

  res.json({
    success: true,
    data: {
      id: profile.id,
      userId: profile.user.id,
      displayName: profile.user.displayName,
      email: profile.user.email,
      phone: profile.user.phone,
      role: profile.user.role,
      agentCode: profile.agentCode,
      status: profile.status,
      commissionPercent: profile.commissionPercent ? Number(profile.commissionPercent) : 0,
      canClaimLeads: profile.canClaimLeads,
      maxActiveLeads: profile.maxActiveLeads,
      parentAgentId: profile.parentAgentId,
      reportingManager: profile.parentAgent ? {
        id: profile.parentAgent.id,
        agentCode: profile.parentAgent.agentCode,
        name: profile.parentAgent.user?.displayName,
      } : null,
      permissions: profile.permissions || {},
      assignedLeadsCount: profile._count.leadAssignments,
      callsCount: profile._count.mobileCalls,
      pipelineValue: myPipelineValue,
      dealsWon: myDealsWon,
      createdAt: profile.createdAt,
    },
  });
});

// GET / - List team members (Restricted to team:view permission - ADMIN and MANAGER by default)
teamRouter.get('/', requirePermissions(PERM_TEAM_VIEW), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const statusQuery = typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : undefined;
  const assignableQuery = String(req.query.assignable ?? '').trim().toLowerCase() === 'true';

  const whereClause: any = {
    tenantId,
    user: { role: { notIn: ['SUPER_ADMIN'] } },
  };
  if (statusQuery) {
    whereClause.status = statusQuery as SalesAgentStatus;
  } else if (assignableQuery) {
    whereClause.status = 'ACTIVE';
  }

  const [workspace, profiles, paymentLinks] = await Promise.all([
    prisma.aicloserWorkspace.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    }),
    prisma.salesAgentProfile.findMany({
      where: whereClause,
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            email: true,
            phone: true,
            role: true,
          },
        },
        parentAgent: {
          select: {
            id: true,
            agentCode: true,
            user: { select: { displayName: true, email: true } },
          },
        },
        _count: {
          select: {
            leadAssignments: true,
            mobileCalls: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.upiPaymentLink.findMany({
      where: { tenantId },
      select: {
        id: true,
        createdByUserId: true,
        status: true,
        totalAmount: true,
      },
    }),
  ]);

  const canSeeCommissions = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';

  let filteredProfiles = profiles;
  if (assignableQuery) {
    // Exclude Admin and Super Admin from lead assignment lists; must be ACTIVE
    filteredProfiles = profiles.filter(
      (p) => p.status === 'ACTIVE' && p.user.role !== 'ADMIN' && p.user.role !== 'SUPER_ADMIN'
    );
  }

  const team = filteredProfiles.map((p) => {
    // Real Pipeline Value: sum of payment URLs shared with leads where payment is NOT received yet (PENDING / CUSTOMER_CONFIRMED)
    const memberLinks = paymentLinks.filter(
      (pl) => pl.createdByUserId === p.user.id || pl.createdByUserId === p.id
    );
    const pendingLinks = memberLinks.filter(
      (pl) => pl.status === 'PENDING' || pl.status === 'CUSTOMER_CONFIRMED'
    );
    const paidLinks = memberLinks.filter((pl) => pl.status === 'PAID');

    const pipelineValue = pendingLinks.reduce((sum, pl) => sum + Number(pl.totalAmount || 0), 0);
    const dealsWon = paidLinks.length;
    const wonAmount = paidLinks.reduce((sum, pl) => sum + Number(pl.totalAmount || 0), 0);

    return {
      id: p.id,
      userId: p.user.id,
      displayName: p.user.displayName,
      email: p.user.email,
      phone: p.user.phone,
      role: p.user.role,
      agentCode: p.agentCode,
      status: p.status,
      commissionPercent: canSeeCommissions || p.userId === user.userId
        ? (p.commissionPercent ? Number(p.commissionPercent) : 0)
        : undefined,
      canClaimLeads: p.canClaimLeads,
      maxActiveLeads: p.maxActiveLeads,
      parentAgentId: p.parentAgentId,
      reportingManager: p.parentAgent ? {
        id: p.parentAgent.id,
        agentCode: p.parentAgent.agentCode,
        name: p.parentAgent.user?.displayName,
      } : null,
      permissions: p.permissions,
      assignedLeadsCount: p._count.leadAssignments,
      callsCount: p._count.mobileCalls,
      pipelineValue,
      dealsWon,
      wonAmount,
      pendingPaymentsCount: pendingLinks.length,
      createdAt: p.createdAt,
    };
  });

  res.json({
    success: true,
    data: {
      workspaceId: workspace?.id || tenantId,
      workspaceName: workspace?.name || 'Workspace',
      members: team,
    },
    members: team,
  });
});

// ==========================================
// GET /audit-logs - Security & role audit trail for workspace (restricted to team:view permission)
teamRouter.get('/audit-logs', requirePermissions(PERM_TEAM_VIEW), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const limitQuery = Number(req.query.limit);
  const take = !isNaN(limitQuery) && limitQuery > 0 ? Math.min(limitQuery, 100) : 50;

  const logs = await prisma.salesActivityLog.findMany({
    where: { tenantId },
    include: {
      actor: {
        select: {
          id: true,
          displayName: true,
          email: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take,
  });

  const formatted = logs.map((l) => ({
    id: l.id,
    action: l.action,
    detail: l.note || l.action,
    user: l.actor?.displayName || l.actor?.email || 'System',
    time: l.createdAt.toISOString(),
    metadata: l.metadata,
  }));

  res.json({
    success: true,
    data: formatted,
    logs: formatted,
  });
});

// ==========================================
// Team Member Invitation & Provisioning
// ==========================================

const inviteMemberSchema = z.object({
  email: z.string().email('Valid email address required'),
  displayName: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  role: z.enum(['CLOSER', 'SALES_AGENT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN']).optional().default('SALES_AGENT'),
  password: z.string().min(6).optional(),
  maxCapacity: z.number().int().min(1).max(200).optional(),
  maxActiveLeads: z.number().int().min(1).max(200).optional(),
  canClaimLeads: z.boolean().optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
  parentAgentId: z.string().nullable().optional(),
  reportingManagerId: z.string().nullable().optional(),
  permissions: z.record(z.any()).optional(),
});

const handleInvite = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body as z.infer<typeof inviteMemberSchema>;

  const normalizedEmail = body.email.toLowerCase().trim();
  const rawRole = (body.role || 'SALES_AGENT').toUpperCase();
  const normalizedRole = rawRole === 'CLOSER' ? 'SALES_AGENT' : rawRole;

  // Phone normalization
  let normalizedPhone: string | null = null;
  if (body.phone && body.phone.trim()) {
    const rawDigits = body.phone.replace(/\D/g, '');
    if (rawDigits.length >= 10) {
      normalizedPhone = body.phone.startsWith('+') ? body.phone.trim() : (rawDigits.length === 10 ? `+91${rawDigits}` : `+${rawDigits}`);
    } else {
      normalizedPhone = body.phone.trim();
    }
  }

  // Deduplication check
  const existingUser = await prisma.appAuthUser.findFirst({
    where: {
      OR: [
        { email: normalizedEmail },
        ...(normalizedPhone ? [{ phone: normalizedPhone }, { loginPhoneAliases: { has: normalizedPhone } }] : []),
      ],
    },
  });

  const parentId = body.parentAgentId || body.reportingManagerId || null;
  if (parentId) {
    const manager = await prisma.salesAgentProfile.findFirst({
      where: { id: parentId, tenantId },
    });
    if (!manager) {
      res.status(400).json({
        success: false,
        error: 'InvalidReportingManager',
        message: 'The selected reporting manager does not exist in this workspace',
      });
      return;
    }
  }

  const displayName = (body.displayName || body.name || normalizedEmail.split('@')[0] || 'Sales Agent').trim();

  // Role permissions defaults
  const roleDefaults: Record<string, Record<string, boolean>> = {
    ADMIN: {
      'leads:view': true,
      'contacts:view': true,
      'leads:create': true,
      'leads:claim': true,
      'leads:reassign': true,
      'calls:view': true,
      'calls:playback': true,
      'chat:view': true,
      'chat:send': true,
      'payouts:view': true,
      'payouts:approve': true,
      'team:view': true,
      'team:manage': true,
      'customer:unmask_phone': true,
    },
    MANAGER: {
      'leads:view': true,
      'contacts:view': true,
      'leads:create': true,
      'leads:claim': true,
      'leads:reassign': true,
      'calls:view': true,
      'calls:playback': true,
      'chat:view': true,
      'chat:send': true,
      'payouts:view': true,
      'payouts:approve': true,
      'team:view': true,
      'team:manage': true,
      'customer:unmask_phone': true,
    },
    SALES_AGENT: {
      'leads:view': true,
      'contacts:view': true,
      'leads:create': true,
      'leads:claim': true,
      'leads:reassign': false,
      'calls:view': true,
      'calls:playback': true,
      'chat:view': true,
      'chat:send': true,
      'payouts:view': true,
      'payouts:approve': false,
      'team:view': false,
      'team:manage': false,
      'customer:unmask_phone': false,
    },
  };

  const defaultPerms = roleDefaults[normalizedRole] || roleDefaults.SALES_AGENT;
  const finalPermissions = {
    ...defaultPerms,
    ...(body.permissions || {}),
  };

  const rawPassword = body.password || (normalizedRole === 'MANAGER' ? 'Manager@123' : normalizedRole === 'ADMIN' ? 'Admin@123' : 'Closer@123');
  const salt = randomBytes(16).toString('hex');
  const passwordHash = scryptSync(rawPassword, salt, 64).toString('hex');

  const prefix = normalizedRole === 'MANAGER' ? 'MGR' : normalizedRole === 'ADMIN' ? 'ADM' : 'AG';
  const agentCode = `${prefix}-${randomUUID().slice(0, 6).toUpperCase()}`;

  if (existingUser) {
    if (existingUser.tenantId === tenantId) {
      const existingProfile = await prisma.salesAgentProfile.findFirst({
        where: { userId: existingUser.id, tenantId },
      });

      if (existingProfile) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: `Team member with email "${normalizedEmail}" already exists in this workspace`,
          data: {
            id: existingProfile.id,
            userId: existingUser.id,
            displayName: existingUser.displayName,
            email: existingUser.email,
            role: existingUser.role,
          },
        });
        return;
      }

      // If user existed without profile, create profile
      const profile = await prisma.salesAgentProfile.create({
        data: {
          userId: existingUser.id,
          tenantId,
          agentCode,
          status: SalesAgentStatus.ACTIVE,
          canClaimLeads: body.canClaimLeads !== undefined ? body.canClaimLeads : true,
          maxActiveLeads: body.maxCapacity || body.maxActiveLeads || 15,
          commissionPercent: body.commissionPercent ?? (normalizedRole === 'SALES_AGENT' ? 20 : 0),
          parentAgentId: parentId,
          permissions: finalPermissions,
        },
      });

      res.status(201).json({
        success: true,
        message: 'Team member profile created for existing workspace user',
        data: {
          id: profile.id,
          userId: existingUser.id,
          displayName: existingUser.displayName,
          email: existingUser.email,
          phone: existingUser.phone,
          role: existingUser.role,
          agentCode: profile.agentCode,
          status: profile.status,
          maxCapacity: profile.maxActiveLeads,
          parentAgentId: profile.parentAgentId,
          permissions: profile.permissions,
          createdAt: profile.createdAt,
        },
      });
      return;
    } else {
      res.status(400).json({
        success: false,
        error: 'UserAlreadyExists',
        message: `A user with email "${normalizedEmail}" already belongs to another workspace`,
      });
      return;
    }
  }

  // Atomic creation of user and profile
  const userId = `usr-${randomUUID().slice(0, 12)}`;
  const appPermissions = Object.keys(finalPermissions).filter((k) => finalPermissions[k]);

  const result = await prisma.$transaction(async (tx) => {
    const newUser = await tx.appAuthUser.create({
      data: {
        id: userId,
        tenantId,
        displayName,
        email: normalizedEmail,
        phone: normalizedPhone,
        loginPhoneAliases: normalizedPhone ? [normalizedPhone] : [],
        role: normalizedRole as any,
        assignedRole: normalizedRole as any,
        passwordSalt: salt,
        passwordHash: passwordHash,
        otpCode: '000000',
        packageStatus: 'ACTIVE',
        permissions: appPermissions,
      },
    });

    const newProfile = await tx.salesAgentProfile.create({
      data: {
        userId: newUser.id,
        tenantId,
        agentCode,
        status: SalesAgentStatus.ACTIVE,
        canClaimLeads: body.canClaimLeads !== undefined ? body.canClaimLeads : true,
        maxActiveLeads: body.maxCapacity || body.maxActiveLeads || 15,
        commissionPercent: body.commissionPercent ?? (normalizedRole === 'SALES_AGENT' ? 20 : 0),
        parentAgentId: parentId,
        permissions: finalPermissions,
      },
    });

    await tx.salesActivityLog.create({
      data: {
        tenantId,
        actorUserId: req.user?.userId,
        action: 'TEAM_MEMBER_INVITED',
        note: `Team member ${displayName} (${normalizedRole}) invited to workspace with code ${agentCode}`,
        metadata: { userId: newUser.id, profileId: newProfile.id, role: normalizedRole },
      },
    }).catch(() => undefined);

    return { user: newUser, profile: newProfile };
  });

  res.status(201).json({
    success: true,
    message: 'Team member added successfully',
    data: {
      id: result.profile.id,
      userId: result.user.id,
      displayName: result.user.displayName,
      email: result.user.email,
      phone: result.user.phone,
      role: result.user.role,
      agentCode: result.profile.agentCode,
      status: result.profile.status,
      commissionPercent: result.profile.commissionPercent ? Number(result.profile.commissionPercent) : 0,
      canClaimLeads: result.profile.canClaimLeads,
      maxCapacity: result.profile.maxActiveLeads,
      parentAgentId: result.profile.parentAgentId,
      permissions: result.profile.permissions,
      createdAt: result.profile.createdAt,
    },
  });
};

// POST /invite - Invite team member to workspace
teamRouter.post('/invite', requirePermissions(PERM_TEAM_MANAGE), validateBody(inviteMemberSchema), handleInvite);
teamRouter.post('/', requirePermissions(PERM_TEAM_MANAGE), validateBody(inviteMemberSchema), handleInvite);

const breakStartSchema = z.object({
  durationMinutes: z.number().int().positive().max(240).optional(),
});

// POST /break/start - Start agent break mode
teamRouter.post('/break/start', validateBody(breakStartSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const body = req.body as z.infer<typeof breakStartSchema>;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const wsSettings = (workspace?.settings as Record<string, any>) || {};
  const breakSettings = wsSettings.breakSettings || {};
  const allowedMinutes = Number(breakSettings.durationMinutes) || 30;
  const durationMinutes = body.durationMinutes || allowedMinutes;

  const now = Date.now();
  const breakExpiresAt = new Date(now + durationMinutes * 60 * 1000).toISOString();
  const breakStartedAt = new Date(now).toISOString();

  // Find agent profile if exists
  const profile = await prisma.salesAgentProfile.findFirst({
    where: { userId: user.userId, tenantId },
  });

  const breakState = {
    isOnBreak: true,
    breakStartedAt,
    breakExpiresAt,
    durationMinutes,
  };

  // 1. Update in workspace.settings.activeBreaks
  const activeBreaks = { ...(wsSettings.activeBreaks || {}) };
  activeBreaks[user.userId] = breakState;
  if (profile) {
    activeBreaks[profile.id] = breakState;
  }

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...wsSettings,
        activeBreaks,
      } as any,
      updatedAt: new Date(),
    },
  });

  // 2. Also record in profile permissions if profile exists
  if (profile) {
    const perms = (profile.permissions && typeof profile.permissions === 'object' && !Array.isArray(profile.permissions))
      ? { ...(profile.permissions as Record<string, any>) }
      : {};
    perms.activeBreak = breakState;
    await prisma.salesAgentProfile.update({
      where: { id: profile.id },
      data: { permissions: perms as any, updatedAt: new Date() },
    }).catch(() => undefined);
  }

  res.json({
    success: true,
    isOnBreak: true,
    breakStartedAt,
    breakExpiresAt,
    durationMinutes,
    remainingSeconds: durationMinutes * 60,
    message: `Break started for ${durationMinutes} minutes`,
    error: null,
  });
});

// POST /break/end - End active break early
teamRouter.post('/break/end', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const wsSettings = (workspace?.settings as Record<string, any>) || {};
  const activeBreaks = { ...(wsSettings.activeBreaks || {}) };

  const profile = await prisma.salesAgentProfile.findFirst({
    where: { userId: user.userId, tenantId },
  });

  delete activeBreaks[user.userId];
  if (profile) {
    delete activeBreaks[profile.id];
  }

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...wsSettings,
        activeBreaks,
      } as any,
      updatedAt: new Date(),
    },
  });

  if (profile) {
    const perms = (profile.permissions && typeof profile.permissions === 'object' && !Array.isArray(profile.permissions))
      ? { ...(profile.permissions as Record<string, any>) }
      : {};
    delete perms.activeBreak;
    await prisma.salesAgentProfile.update({
      where: { id: profile.id },
      data: { permissions: perms as any, updatedAt: new Date() },
    }).catch(() => undefined);
  }

  res.json({
    success: true,
    isOnBreak: false,
    message: 'Break ended successfully',
    error: null,
  });
});

// GET /break/status - Check current break status (auto-resumes if expired)
teamRouter.get('/break/status', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const wsSettings = (workspace?.settings as Record<string, any>) || {};
  const breakSettings = wsSettings.breakSettings || {};
  const allowedMinutes = Number(breakSettings.durationMinutes) || 30;

  const activeBreaks = wsSettings.activeBreaks || {};
  const profile = await prisma.salesAgentProfile.findFirst({
    where: { userId: user.userId, tenantId },
  });

  const breakData = activeBreaks[user.userId] || (profile ? activeBreaks[profile.id] : null);
  const now = Date.now();

  if (breakData && breakData.isOnBreak) {
    const expTime = breakData.breakExpiresAt ? new Date(breakData.breakExpiresAt).getTime() : 0;
    if (expTime > now) {
      const remainingSeconds = Math.max(0, Math.round((expTime - now) / 1000));
      res.json({
        success: true,
        isOnBreak: true,
        remainingSeconds,
        breakStartedAt: breakData.breakStartedAt,
        breakExpiresAt: breakData.breakExpiresAt,
        allowedMinutes,
        error: null,
      });
      return;
    } else {
      // Auto-resume: break expired!
      const updatedActiveBreaks = { ...activeBreaks };
      delete updatedActiveBreaks[user.userId];
      if (profile) delete updatedActiveBreaks[profile.id];

      await prisma.aicloserWorkspace.update({
        where: { id: tenantId },
        data: {
          settings: {
            ...wsSettings,
            activeBreaks: updatedActiveBreaks,
          } as any,
          updatedAt: new Date(),
        },
      }).catch(() => undefined);
    }
  }

  res.json({
    success: true,
    isOnBreak: false,
    remainingSeconds: 0,
    allowedMinutes,
    error: null,
  });
});

// GET /break/team - List team members currently on break (for Admin / Manager monitoring)
teamRouter.get('/break/team', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  try {
    const workspace = await prisma.aicloserWorkspace.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const wsSettings = (workspace?.settings as any) || {};
    const activeBreaks = wsSettings.activeBreaks || {};
    const now = Date.now();
    const onBreakList: Array<{
      userId: string;
      name: string;
      remainingSeconds: number;
      breakStartedAt?: string;
      breakExpiresAt: string;
    }> = [];

    const userIds = Object.keys(activeBreaks);
    if (userIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: userIds }, tenantId },
        select: { id: true, displayName: true, email: true },
      });
      const userMap = new Map(users.map((u) => [u.id, u.displayName || u.email]));

      for (const [uid, bData] of Object.entries<any>(activeBreaks)) {
        if (bData && bData.isOnBreak) {
          const expTime = bData.breakExpiresAt ? new Date(bData.breakExpiresAt).getTime() : 0;
          if (expTime > now) {
            const remainingSeconds = Math.max(0, Math.floor((expTime - now) / 1000));
            const name = userMap.get(uid) || "Sales Agent";
            if (!onBreakList.some((item) => item.userId === uid || item.name === name)) {
              onBreakList.push({
                userId: uid,
                name,
                remainingSeconds,
                breakStartedAt: bData.breakStartedAt,
                breakExpiresAt: bData.breakExpiresAt,
              });
            }
          }
        }
      }
    }

    res.json({
      success: true,
      activeBreaks: onBreakList,
      totalOnBreak: onBreakList.length,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'TeamBreakFetchFailed',
      message: err.message,
      activeBreaks: [],
      totalOnBreak: 0,
    });
  }
});

// PATCH /:id - Update team member settings (Strictly restricted to team:manage permission)
teamRouter.patch('/:id', requirePermissions(PERM_TEAM_MANAGE), validateBody(updateAgentSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const rawBody = req.body as z.infer<typeof updateAgentSchema>;
  const body = {
    ...rawBody,
    role: rawBody.role === 'CLOSER' ? ('SALES_AGENT' as const) : rawBody.role,
    displayName: rawBody.displayName || rawBody.name,
    maxActiveLeads: rawBody.maxActiveLeads ?? rawBody.maxCapacity,
  };
  delete (body as any).name;
  delete (body as any).maxCapacity;

  const profile = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      OR: [{ id }, { userId: id }],
    },
    include: {
      user: true,
    },
  });

  if (!profile) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Team member profile not found in this workspace' });
    return;
  }

  // Handle password hashing if provided
  let passwordUpdates: { passwordSalt: string; passwordHash: string } | {} = {};
  if (body.password) {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(body.password, salt, 64).toString('hex');
    passwordUpdates = { passwordSalt: salt, passwordHash: hash };
  }

  // Handle phone normalization if provided
  let normalizedPhone: string | undefined = undefined;
  if (body.phone !== undefined) {
    const trimmed = body.phone.trim();
    if (trimmed) {
      const rawDigits = trimmed.replace(/\D/g, '');
      if (rawDigits.length >= 10) {
        normalizedPhone = trimmed.startsWith('+') ? trimmed : (rawDigits.length === 10 ? `+91${rawDigits}` : `+${rawDigits}`);
      } else {
        normalizedPhone = trimmed;
      }
    } else {
      normalizedPhone = undefined;
    }
  }

  // Update AppAuthUser if applicable
  if (profile.userId) {
    const userUpdateData: any = {
      ...passwordUpdates,
      ...(body.role ? { role: body.role as any, assignedRole: body.role as any } : {}),
      ...(body.displayName !== undefined ? { displayName: body.displayName.trim() } : {}),
      ...(normalizedPhone !== undefined ? { phone: normalizedPhone, loginPhoneAliases: [normalizedPhone] } : {}),
      ...(body.email !== undefined ? { email: body.email.toLowerCase().trim() } : {}),
    };

    if (Object.keys(userUpdateData).length > 0) {
      await prisma.appAuthUser.update({
        where: { id: profile.userId },
        data: userUpdateData,
      }).catch((err) => {
        console.warn('[teamRouter.patch] AppAuthUser update error:', err.message);
      });
    }
  }

  const updated = await prisma.salesAgentProfile.update({
    where: { id: profile.id },
    data: {
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.commissionPercent !== undefined ? { commissionPercent: body.commissionPercent } : {}),
      ...(body.canClaimLeads !== undefined ? { canClaimLeads: body.canClaimLeads } : {}),
      ...(body.maxActiveLeads !== undefined ? { maxActiveLeads: body.maxActiveLeads } : {}),
      ...(body.parentAgentId !== undefined ? { parentAgentId: body.parentAgentId } : {}),
      ...(body.permissions !== undefined ? { permissions: body.permissions as any } : {}),
    },
    include: {
      user: {
        select: {
          id: true,
          displayName: true,
          email: true,
          phone: true,
          role: true,
        },
      },
      parentAgent: {
        select: {
          id: true,
          agentCode: true,
          user: { select: { displayName: true } },
        },
      },
    },
  });

  const updatedKeys = Object.keys(body).filter((k) => k !== 'password');
  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      actorUserId: req.user?.userId,
      action: 'TEAM_MEMBER_UPDATED',
      note: `Team member ${updated.user?.displayName || updated.agentCode} updated (${updatedKeys.join(', ')})`,
      metadata: {
        targetProfileId: profile.id,
        userId: profile.userId,
        updatedFields: updatedKeys,
        hasPasswordChanged: Boolean(body.password),
      },
    },
  }).catch(() => undefined);

  res.json({
    success: true,
    data: {
      id: updated.id,
      userId: updated.user?.id || profile.userId,
      displayName: updated.user?.displayName,
      email: updated.user?.email,
      phone: updated.user?.phone,
      role: updated.user?.role,
      agentCode: updated.agentCode,
      status: updated.status,
      commissionPercent: updated.commissionPercent ? Number(updated.commissionPercent) : 0,
      canClaimLeads: updated.canClaimLeads,
      maxActiveLeads: updated.maxActiveLeads,
      parentAgentId: updated.parentAgentId,
      reportingManager: updated.parentAgent ? {
        id: updated.parentAgent.id,
        agentCode: updated.parentAgent.agentCode,
        name: updated.parentAgent.user?.displayName,
      } : null,
      permissions: updated.permissions,
      updatedAt: updated.updatedAt,
    },
    message: 'Team member settings updated successfully',
  });
});


// ==========================================
// Manager Hierarchy & Permissions Matrix
// ==========================================

// GET /permissions/matrix - Get system permissions catalog and default role templates
teamRouter.get('/permissions/matrix', async (req: Request, res: Response) => {
  const permissionsCatalog = [
    // CRM & Leads
    { key: 'leads:view', label: 'View Leads & Pipeline', category: 'Leads & Pipeline', description: 'Access workspace leads and Kanban stages' },
    { key: 'contacts:view', label: 'View Contacts Directory', category: 'Leads & Pipeline', description: 'Access contacts list with deduplication' },
    { key: 'leads:create', label: 'Create Manual Leads', category: 'Leads & Pipeline', description: 'Add new prospective leads into pipeline' },
    { key: 'leads:claim', label: 'Claim Pool Leads', category: 'Leads & Pipeline', description: 'Grab unassigned leads within 10-minute rotation slot' },
    { key: 'leads:reassign', label: 'Reassign & Transfer Leads', category: 'Leads & Pipeline', description: 'Transfer lead ownership and thread context' },
    { key: 'leads:export', label: 'Export Leads (.xlsx)', category: 'Leads & Pipeline', description: 'Download client contact spreadsheets' },
    { key: 'leads:delete', label: 'Soft-Delete to Recycle Bin', category: 'Leads & Pipeline', description: 'Move inactive leads into recycle bin' },
    { key: 'leads:permanent_delete', label: 'Permanently Purge Leads', category: 'Leads & Pipeline', description: 'Permanently remove leads from database' },

    // Telephony & SIM Relays
    { key: 'calls:view', label: 'View Calls & Logs', category: 'Telephony & SIM', description: 'Inspect telephony call duration and timestamps' },
    { key: 'calls:playback', label: 'Play Audio Recordings', category: 'Telephony & SIM', description: 'Stream recorded phone calls and AI transcripts' },
    { key: 'telephony:make_call', label: 'Trigger SIM Phone Calls', category: 'Telephony & SIM', description: 'Initiate outbound calls via Android companion relay' },

    // Omnichannel Chat & WhatsApp
    { key: 'chat:view', label: 'View Conversations', category: 'Omnichannel Chat', description: 'Read live customer WhatsApp and Instagram threads' },
    { key: 'chat:send', label: 'Send WhatsApp Messages', category: 'Omnichannel Chat', description: 'Reply to client messages and send attachments' },
    { key: 'chat:share', label: 'Share Chat with Teammates', category: 'Omnichannel Chat', description: 'Grant internal chat visibility to teammates' },
    { key: 'whatsapp:marketing', label: 'Broadcast Bulk Campaigns', category: 'Omnichannel Chat', description: 'Send approved WhatsApp marketing templates' },

    // Finance & Payments
    { key: 'payments:create', label: 'Generate UPI Payment Links', category: 'Payments & Revenue', description: 'Create dynamic QR payment links for leads' },
    { key: 'payments:settle', label: 'Approve & Settle Payments', category: 'Payments & Revenue', description: 'Verify payment proofs and close deals won' },
    { key: 'payouts:view', label: 'View Own Commissions', category: 'Payments & Revenue', description: 'Inspect earned commissions and payout status' },
    { key: 'payouts:approve', label: 'Approve Team Payouts', category: 'Payments & Revenue', description: 'Authorize sales commission payouts' },

    // Workspace Governance & Integrations
    { key: 'team:view', label: 'View Team Directory', category: 'Workspace Governance', description: 'View teammates, online status and availability' },
    { key: 'team:manage', label: 'Manage Team & Roles', category: 'Workspace Governance', description: 'Invite team members and adjust permissions' },
    { key: 'integrations:manage', label: 'Manage Ingestion Gateways', category: 'Workspace Governance', description: 'Configure IndiaMART, JustDial and webhooks' },
    { key: 'customer:unmask_phone', label: 'Unmask Customer Numbers', category: 'Workspace Governance', description: 'View raw unmasked customer phone numbers' },
  ];

  const roleDefaults = {
    ADMIN: permissionsCatalog.reduce((acc, p) => ({ ...acc, [p.key]: true }), {}),
    MANAGER: {
      'leads:view': true,
      'contacts:view': true,
      'leads:create': true,
      'leads:claim': true,
      'leads:reassign': true,
      'leads:export': true,
      'leads:delete': true,
      'leads:permanent_delete': false,
      'calls:view': true,
      'calls:playback': true,
      'telephony:make_call': true,
      'chat:view': true,
      'chat:send': true,
      'chat:share': true,
      'whatsapp:marketing': true,
      'payments:create': true,
      'payments:settle': true,
      'payouts:view': true,
      'payouts:approve': true,
      'team:view': true,
      'team:manage': false,
      'integrations:manage': false,
      'customer:unmask_phone': true,
    },
    SALES_AGENT: {
      'leads:view': true,
      'contacts:view': true,
      'leads:create': true,
      'leads:claim': true,
      'leads:reassign': false,
      'leads:export': false,
      'leads:delete': false,
      'leads:permanent_delete': false,
      'calls:view': true,
      'calls:playback': false,
      'telephony:make_call': true,
      'chat:view': true,
      'chat:send': true,
      'chat:share': true,
      'whatsapp:marketing': false,
      'payments:create': true,
      'payments:settle': false,
      'payouts:view': true,
      'payouts:approve': false,
      'team:view': true,
      'team:manage': false,
      'integrations:manage': false,
      'customer:unmask_phone': false,
    },
  };

  const workspace = await prisma.aicloserWorkspace.findUnique({ where: { id: req.tenantId! }, select: { settings: true } });
  const saved = (workspace?.settings as { rolePermissions?: Record<string, Record<string, boolean>> } | null)?.rolePermissions || {};
  res.json({
    success: true,
    data: {
      catalog: permissionsCatalog,
      roleDefaults: Object.fromEntries(Object.entries(roleDefaults).map(([role, defaults]) => [role, { ...defaults, ...(saved[role] || {}) }])),
    },
    error: null,
  });
});

const matrixBodySchema = z.union([
  z.object({
    roles: z.record(z.record(z.any())),
  }),
  z.record(z.record(z.any())),
]);

teamRouter.put('/permissions/matrix', requireRoles('ADMIN', 'SUPER_ADMIN'), validateBody(matrixBodySchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const rawBody = req.body as any;
  let roles: Record<string, Record<string, any>> = (rawBody && 'roles' in rawBody && rawBody.roles) ? rawBody.roles : rawBody;
  // Handle double wrapping if passed as { roles: { roles: ... } }
  if (roles && 'roles' in roles && typeof (roles as any).roles === 'object') {
    roles = (roles as any).roles;
  }
  await prisma.$transaction(async (tx) => {
    const workspace = await tx.aicloserWorkspace.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
    const settings = (workspace.settings as Record<string, unknown>) || {};
    const previous = (settings.rolePermissions as Record<string, Record<string, boolean>>) || {};
    await tx.aicloserWorkspace.update({ where: { id: tenantId }, data: { settings: { ...settings, rolePermissions: { ...previous, ...roles } } } });
    for (const role of ['ADMIN', 'MANAGER', 'SALES_AGENT'] as const) {
      if (roles[role]) await tx.salesAgentProfile.updateMany({ where: { tenantId, user: { role } }, data: { permissions: roles[role] } });
    }
  });
  res.json({ success: true, data: { saved: true, roles }, error: null });
});

// PATCH /:id/manager - Assign agent under a reporting manager
const assignManagerSchema = z.object({
  managerProfileId: z.string().nullable(),
});

teamRouter.patch('/:id/manager', requirePermissions(PERM_TEAM_MANAGE), validateBody(assignManagerSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { managerProfileId } = req.body;

  const profile = await prisma.salesAgentProfile.findFirst({
    where: { id, tenantId },
  });

  if (!profile) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Team member profile not found' });
    return;
  }

  // If assigning a manager, verify that manager belongs to the same tenant
  if (managerProfileId) {
    if (managerProfileId === profile.id) {
      res.status(400).json({ success: false, error: 'InvalidManager', message: 'An agent cannot report to themselves' });
      return;
    }

    const managerProfile = await prisma.salesAgentProfile.findFirst({
      where: { id: managerProfileId, tenantId },
      include: { user: { select: { displayName: true, role: true } } },
    });

    if (!managerProfile) {
      res.status(404).json({ success: false, error: 'NotFound', message: 'Reporting manager profile not found in workspace' });
      return;
    }

    // Role validation: reporting manager must have role MANAGER, ADMIN, or SUPER_ADMIN
    if (managerProfile.user.role !== 'MANAGER' && managerProfile.user.role !== 'ADMIN' && managerProfile.user.role !== 'SUPER_ADMIN') {
      res.status(400).json({
        success: false,
        error: 'InvalidManagerRole',
        message: 'The selected reporting manager must hold role MANAGER or ADMIN',
      });
      return;
    }

    // Cycle detection: traverse ancestor tree to ensure no circular loop
    let currentAncestorId: string | null = managerProfile.parentAgentId;
    const visitedHierarchy = new Set<string>([profile.id, managerProfile.id]);

    while (currentAncestorId) {
      if (visitedHierarchy.has(currentAncestorId)) {
        res.status(400).json({
          success: false,
          error: 'HierarchyCycleDetected',
          message: 'Circular reporting chain detected. An agent cannot report to their subordinate or form a loop.',
        });
        return;
      }
      visitedHierarchy.add(currentAncestorId);

      const ancestor = await prisma.salesAgentProfile.findUnique({
        where: { id: currentAncestorId },
        select: { parentAgentId: true },
      });
      currentAncestorId = ancestor?.parentAgentId || null;
    }
  }

  const updated = await prisma.salesAgentProfile.update({
    where: { id: profile.id },
    data: { parentAgentId: managerProfileId, updatedAt: new Date() },
    include: {
      parentAgent: {
        select: { id: true, agentCode: true, user: { select: { displayName: true } } },
      },
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      actorUserId: req.user?.userId,
      action: 'TEAM_MANAGER_ASSIGNED',
      note: managerProfileId ? `Agent ${profile.agentCode} assigned to manager ${updated.parentAgent?.user?.displayName}` : `Manager unassigned for agent ${profile.agentCode}`,
      metadata: { targetProfileId: id, managerProfileId },
    },
  }).catch(() => undefined);

  res.json({
    success: true,
    message: 'Reporting manager updated successfully',
    data: {
      id: updated.id,
      parentAgentId: updated.parentAgentId,
      reportingManager: updated.parentAgent ? {
        id: updated.parentAgent.id,
        agentCode: updated.parentAgent.agentCode,
        name: updated.parentAgent.user?.displayName,
      } : null,
    },
    error: null,
  });
});

// PATCH /:id/status - Update member active / suspended status
const updateStatusSchema = z.object({
  status: z.nativeEnum(SalesAgentStatus),
});

teamRouter.patch('/:id/status', requirePermissions(PERM_TEAM_MANAGE), validateBody(updateStatusSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { status } = req.body;

  const profile = await prisma.salesAgentProfile.findFirst({
    where: { id, tenantId },
  });

  if (!profile) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Team member profile not found' });
    return;
  }

  const updated = await prisma.salesAgentProfile.update({
    where: { id: profile.id },
    data: { status, updatedAt: new Date() },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      actorUserId: req.user?.userId,
      action: 'TEAM_MEMBER_STATUS_CHANGED',
      note: `Agent ${profile.agentCode} status set to ${status}`,
      metadata: { targetProfileId: id, newStatus: status },
    },
  }).catch(() => undefined);

  res.json({
    success: true,
    message: `Team member status updated to ${status}`,
    data: { id: updated.id, status: updated.status },
    error: null,
  });
});

// GET /:id/permissions - Get team member permissions (accepts profile ID or user ID)
teamRouter.get('/:id/permissions', requirePermissions(PERM_TEAM_VIEW), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const profile = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      OR: [{ id }, { userId: id }],
    },
    include: {
      user: { select: { id: true, displayName: true, email: true, role: true } },
    },
  });

  if (!profile) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Team member profile not found' });
    return;
  }

  res.json({
    success: true,
    data: {
      id: profile.id,
      userId: profile.userId,
      role: profile.user?.role,
      displayName: profile.user?.displayName,
      permissions: (profile.permissions as Record<string, boolean>) || {},
    },
    error: null,
  });
});

// Update permissions schema
const updatePermissionsSchema = z.union([
  z.object({
    permissions: z.record(z.any()),
  }),
  z.record(z.any()),
]);

const handleUpdatePermissions = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const rawBody = req.body as any;
  const permissions = (rawBody && 'permissions' in rawBody && rawBody.permissions) ? rawBody.permissions : rawBody;

  const profile = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      OR: [{ id }, { userId: id }],
    },
  });

  if (!profile) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Team member profile not found' });
    return;
  }

  const updated = await prisma.salesAgentProfile.update({
    where: { id: profile.id },
    data: { permissions, updatedAt: new Date() },
  });

  res.json({
    success: true,
    message: 'Team member permissions updated successfully',
    data: { id: updated.id, userId: updated.userId, permissions: updated.permissions },
    error: null,
  });
};

// PUT /:id/permissions & PATCH /:id/permissions - Direct permissions map update (accepts profile ID or user ID)
teamRouter.patch('/:id/permissions', requirePermissions(PERM_TEAM_MANAGE), validateBody(updatePermissionsSchema), handleUpdatePermissions);
teamRouter.put('/:id/permissions', requirePermissions(PERM_TEAM_MANAGE), validateBody(updatePermissionsSchema), handleUpdatePermissions);

// DELETE /:id - Permanently delete / remove team member from workspace with safe lead reassignment
teamRouter.delete('/:id', requirePermissions(PERM_TEAM_MANAGE), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  try {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: {
        tenantId,
        OR: [{ id }, { userId: id }],
      },
      include: {
        user: { select: { id: true, email: true, role: true, displayName: true } },
      },
    });

    if (!profile) {
      // Check if direct AppAuthUser
      const directUser = await prisma.appAuthUser.findFirst({
        where: { id, tenantId },
      });
      if (directUser) {
        if (directUser.role === 'ADMIN' || directUser.role === 'SUPER_ADMIN') {
          res.status(403).json({ success: false, error: 'CannotDeleteAdmin', message: 'Workspace admin/owner account cannot be removed' });
          return;
        }
        await prisma.salesAgentProfile.deleteMany({ where: { userId: directUser.id, tenantId } }).catch(() => undefined);
        await prisma.appAuthUser.delete({ where: { id: directUser.id } }).catch(async () => {
          await prisma.appAuthUser.update({ where: { id: directUser.id }, data: { packageStatus: 'PAUSED' } });
        });
        res.json({ success: true, message: 'Team member removed from workspace', data: { id: directUser.id } });
        return;
      }

      res.status(404).json({ success: false, error: 'NotFound', message: 'Team member profile not found in workspace' });
      return;
    }

    // Safety guard: Admin / Super Admin cannot be deleted
    if (profile.user?.role === 'ADMIN' || profile.user?.role === 'SUPER_ADMIN') {
      res.status(403).json({
        success: false,
        error: 'CannotDeleteAdmin',
        message: 'Workspace owner/admin account cannot be removed.',
      });
      return;
    }

    const userId = profile.userId;

    // 1. Safe Lead Reassignment: Find active leads not closed won/lost
    const activeLeads = await prisma.salesLeadAssignment.findMany({
      where: {
        assignedAgentId: profile.id,
        tenantId,
        stage: {
          notIn: ['CLOSED', 'LOST', 'CLOSED_WON', 'CLOSED_LOST'],
        },
      },
    });

    // Move active leads into SalesLeadPoolItem with status 'OPEN'
    for (const lead of activeLeads) {
      let existingPoolItem = null;
      if (lead.conversationId) {
        existingPoolItem = await prisma.salesLeadPoolItem.findFirst({
          where: {
            tenantId,
            conversationId: lead.conversationId,
          },
        });
      }

      if (existingPoolItem) {
        await prisma.salesLeadPoolItem.update({
          where: { id: existingPoolItem.id },
          data: {
            status: 'OPEN',
            assignedAgentId: null,
            claimedByAgentId: null,
            convertedAssignmentId: null,
            notes: (existingPoolItem.notes ? existingPoolItem.notes + ' | ' : '') + `Returned to open pool upon agent ${profile.agentCode} removal`,
          },
        }).catch(() => undefined);
      } else {
        await prisma.salesLeadPoolItem.create({
          data: {
            tenantId,
            customerName: lead.customerName,
            customerPhone: lead.customerPhone,
            customerEmail: lead.customerEmail,
            source: lead.source || 'reassigned_pool',
            serviceInterest: lead.serviceInterest,
            segment: lead.segment,
            priority: lead.priority || 'normal',
            budgetAmount: lead.budgetAmount,
            status: 'OPEN',
            conversationId: lead.conversationId || undefined,
            notes: lead.notes
              ? `${lead.notes} (Pooled from deleted agent ${profile.agentCode})`
              : `Pooled from deleted agent ${profile.agentCode}`,
          },
        }).catch((err) => {
          console.warn('[teamRouter.delete] Pool item creation fallback:', err.message);
        });
      }
    }

    // 2. Release foreign key references in SalesLeadPoolItem to prevent FK violation
    const linkedPoolItems = await prisma.salesLeadPoolItem.findMany({
      where: {
        tenantId,
        OR: [
          { assignedAgentId: profile.id },
          { claimedByAgentId: profile.id },
        ],
      },
      select: { id: true },
    });
    if (linkedPoolItems.length > 0) {
      await prisma.salesLeadPoolItem.updateMany({
        where: { id: { in: linkedPoolItems.map((p) => p.id) } },
        data: {
          assignedAgentId: null,
          claimedByAgentId: null,
          status: 'OPEN',
        },
      }).catch(() => undefined);
    }

    // Nullify convertedAssignmentId for any assignments belonging to this agent
    const allAgentAssignments = await prisma.salesLeadAssignment.findMany({
      where: { assignedAgentId: profile.id },
      select: { id: true },
    });
    const allAssignmentIds = allAgentAssignments.map((a) => a.id);
    if (allAssignmentIds.length > 0) {
      await prisma.salesLeadPoolItem.updateMany({
        where: { convertedAssignmentId: { in: allAssignmentIds } },
        data: { convertedAssignmentId: null },
      }).catch(() => undefined);
    }

    // 3. Delete lead assignments
    await prisma.salesLeadAssignment.deleteMany({
      where: { assignedAgentId: profile.id },
    }).catch(() => undefined);

    // 4. Unassign reporting children to prevent foreign key errors
    await prisma.salesAgentProfile.updateMany({
      where: { parentAgentId: profile.id, tenantId },
      data: { parentAgentId: null },
    }).catch(() => undefined);

    // 5. Unlink any commission rules referencing this agent
    await prisma.salesCommissionRule.updateMany({
      where: { agentId: profile.id },
      data: { agentId: null },
    }).catch(() => undefined);

    // 6. Delete or suspend SalesAgentProfile
    await prisma.salesAgentProfile.delete({
      where: { id: profile.id },
    }).catch(async (err) => {
      console.warn('[teamRouter.delete] Profile delete fallback to SUSPENDED:', err.message);
      await prisma.salesAgentProfile.update({
        where: { id: profile.id },
        data: { status: SalesAgentStatus.SUSPENDED, permissions: {} },
      });
    });

    // 7. Delete or pause associated AppAuthUser
    if (userId) {
      await prisma.appAuthUser.delete({
        where: { id: userId },
      }).catch(async (err) => {
        console.warn('[teamRouter.delete] AppAuthUser delete fallback to PAUSED:', err.message);
        await prisma.appAuthUser.update({
          where: { id: userId },
          data: { packageStatus: 'PAUSED' },
        }).catch(() => undefined);
      });

      // Clear sessions
      await prisma.appClientSession.deleteMany({
        where: { userId },
      }).catch(() => undefined);
    }

    // 8. Record audit activity log
    await prisma.salesActivityLog.create({
      data: {
        tenantId,
        actorUserId: req.user?.userId,
        action: 'TEAM_MEMBER_DELETED',
        note: `Team member ${profile.user?.displayName || profile.agentCode} removed from workspace. ${activeLeads.length} active leads moved to pool.`,
        metadata: {
          targetProfileId: profile.id,
          userId,
          reassignedLeadsCount: activeLeads.length,
        },
      },
    }).catch(() => undefined);

    res.json({
      success: true,
      message: `Team member removed from workspace. ${activeLeads.length} active leads moved to lead pool.`,
      data: {
        id: profile.id,
        userId,
        reassignedLeadsCount: activeLeads.length,
      },
      error: null,
    });
  } catch (error) {
    console.error('[teamRouter.delete] Error deleting team member:', error);
    res.status(500).json({
      success: false,
      error: 'DeleteFailed',
      message: error instanceof Error ? error.message : 'Could not delete team member',
    });
  }
});
