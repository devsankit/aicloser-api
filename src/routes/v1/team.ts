import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requirePermissions, PERM_TEAM_VIEW, PERM_TEAM_MANAGE } from '../../middlewares/rbac.js';
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
  permissions: z.record(z.boolean()).optional(),
});

// GET /me - Get own profile (accessible by any authenticated workspace user)
teamRouter.get('/me', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  const profile = await prisma.salesAgentProfile.findFirst({
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
  });

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
      createdAt: profile.createdAt,
    },
  });
});

// GET / - List team members (Restricted to team:view permission - ADMIN and MANAGER by default)
teamRouter.get('/', requirePermissions(PERM_TEAM_VIEW), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  const profiles = await prisma.salesAgentProfile.findMany({
    where: { tenantId },
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
  });

  const canSeeCommissions = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';

  const team = profiles.map((p) => ({
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
    createdAt: p.createdAt,
  }));

  res.json({
    success: true,
    data: team,
  });
});

// PATCH /:id - Update team member settings (Strictly restricted to team:manage permission)
teamRouter.patch('/:id', requirePermissions(PERM_TEAM_MANAGE), validateBody(updateAgentSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof updateAgentSchema>;

  const profile = await prisma.salesAgentProfile.findFirst({
    where: { id, tenantId },
  });

  if (!profile) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Team member profile not found in this workspace' });
    return;
  }

  const updated = await prisma.salesAgentProfile.update({
    where: { id: profile.id },
    data: {
      status: body.status,
      commissionPercent: body.commissionPercent,
      canClaimLeads: body.canClaimLeads,
      maxActiveLeads: body.maxActiveLeads,
      ...(body.parentAgentId !== undefined ? { parentAgentId: body.parentAgentId } : {}),
      ...(body.permissions !== undefined ? { permissions: body.permissions as any } : {}),
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      actorUserId: req.user?.userId,
      action: 'TEAM_MEMBER_SETTINGS_UPDATED',
      note: 'Team member settings updated for agent ' + profile.agentCode,
      metadata: { targetProfileId: id, changes: body },
    },
  }).catch(() => undefined);

  res.json({
    success: true,
    data: updated,
    message: 'Team member settings updated successfully',
  });
});


// ==========================================
// Manager Hierarchy & Permissions Matrix
// ==========================================

// GET /permissions/matrix - Get system permissions catalog and default role templates
teamRouter.get('/permissions/matrix', async (req: Request, res: Response) => {
  const permissionsCatalog = [
    { key: 'leads:view', label: 'View Leads', category: 'CRM' },
    { key: 'leads:create', label: 'Create Leads', category: 'CRM' },
    { key: 'leads:claim', label: 'Claim Pool Leads', category: 'CRM' },
    { key: 'leads:reassign', label: 'Reassign Leads', category: 'CRM' },
    { key: 'calls:view', label: 'View Calls & Logs', category: 'Calls' },
    { key: 'calls:playback', label: 'Play Audio Recordings', category: 'Calls' },
    { key: 'chat:view', label: 'View Conversations', category: 'Chat' },
    { key: 'chat:send', label: 'Send WhatsApp Messages', category: 'Chat' },
    { key: 'payouts:view', label: 'View Own Payouts', category: 'Finance' },
    { key: 'payouts:approve', label: 'Approve Team Payouts', category: 'Finance' },
    { key: 'team:view', label: 'View Team Members', category: 'Team' },
    { key: 'team:manage', label: 'Manage Closers & Hierarchy', category: 'Team' },
    { key: 'customer:unmask_phone', label: 'Unmask Customer Phone Numbers', category: 'Security' },
  ];

  const roleDefaults = {
    ADMIN: permissionsCatalog.reduce((acc, p) => ({ ...acc, [p.key]: true }), {}),
    MANAGER: {
      'leads:view': true,
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

  res.json({
    success: true,
    data: {
      catalog: permissionsCatalog,
      roleDefaults,
    },
    error: null,
  });
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
      include: { user: { select: { displayName: true } } },
    });

    if (!managerProfile) {
      res.status(404).json({ success: false, error: 'NotFound', message: 'Reporting manager profile not found in workspace' });
      return;
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

// PATCH /:id/permissions - Direct permissions map update
const updatePermissionsSchema = z.object({
  permissions: z.record(z.boolean()),
});

teamRouter.patch('/:id/permissions', requirePermissions(PERM_TEAM_MANAGE), validateBody(updatePermissionsSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { permissions } = req.body;

  const profile = await prisma.salesAgentProfile.findFirst({
    where: { id, tenantId },
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
    data: { id: updated.id, permissions: updated.permissions },
    error: null,
  });
});
