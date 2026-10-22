import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles } from '../../middlewares/rbac.js';

export const workspaceRouter = Router();

workspaceRouter.use(authenticate, enforceTenantIsolation);

// GET /api/v1/workspace/plan - Authoritative source of workspace plan
workspaceRouter.get('/plan', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
  });

  const subscription = await prisma.userSubscription.findFirst({
    where: {
      userId: req.user?.userId || '',
      status: 'ACTIVE',
    },
    orderBy: { createdAt: 'desc' },
  });

  const activeSeats = await prisma.appAuthUser.count({
    where: { tenantId },
  });

  const maxSeats = workspace?.maxSeats || 5;

  res.json({
    success: true,
    data: {
      workspaceId: tenantId,
      workspaceName: workspace?.name || 'My Workspace',
      slug: workspace?.slug || tenantId,
      packageId: subscription?.packageId || `pkg-${workspace?.planTier?.toLowerCase() || 'pro'}`,
      packageName: workspace?.planTier ? `AI Closer ${workspace.planTier}` : 'AI Closer Pro',
      packageType: subscription?.packageType || 'AGENCY',
      packageVersion: '2.0',
      subscriptionId: subscription?.id || null,
      subscriptionStatus: subscription?.status || (workspace?.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE'),
      paymentStatus: subscription?.paymentStatus || 'PAID',
      startDate: subscription?.startsAt || workspace?.createdAt || new Date().toISOString(),
      expiryDate: subscription?.expiresAt || new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      status: workspace?.status || 'ACTIVE',
      isSuspended: workspace?.status === 'SUSPENDED',
      isActivationLocked: workspace?.status === 'LOCKED',
      seatLimit: maxSeats,
      activeSeats,
      remainingSeats: Math.max(0, maxSeats - activeSeats),
      serverTimestamp: new Date().toISOString(),
      sourceOfTruthVersion: '2.0.0',
    },
    error: null,
  });
});

// GET /api/v1/workspace/entitlements - Detailed feature flags and limits
workspaceRouter.get('/entitlements', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
  });

  const tier = (workspace?.planTier || 'PRO').toUpperCase();
  const isEnterprise = tier === 'ENTERPRISE';
  const isPro = tier === 'PRO' || isEnterprise;

  res.json({
    success: true,
    data: {
      workspaceId: tenantId,
      planTier: tier,
      entitlements: {
        whatsappOfficialApi: true,
        whatsappBulkCampaigns: isPro,
        whatsappAutomations: isPro,
        aiConsultativeSalesReply: true,
        aiLeadScoring: true,
        aiCallTranscription: isEnterprise,
        unlimitedCallRecordings: true,
        googleDriveVaultSync: true,
        realtimeSseEvents: true,
        exportDataCsv: true,
        developerWebhooks: isPro,
        developerApiKeys: isEnterprise,
        customLeadFields: true,
        multiSimTracking: true,
        kanbanPipelines: true,
        leadDeduplication: true,
      },
      limits: {
        maxAgents: workspace?.maxSeats || 5,
        maxContactsPerImport: isEnterprise ? 50000 : 5000,
        maxActiveCampaigns: isEnterprise ? 50 : 10,
        monthlyWhatsAppMessages: isEnterprise ? 200000 : 25000,
        recordingRetentionDays: isEnterprise ? 365 : 90,
      },
      serverTimestamp: new Date().toISOString(),
    },
    error: null,
  });
});

// GET /api/v1/workspace/usage - Current consumption vs limits
workspaceRouter.get('/usage', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const [
    totalLeads,
    totalContacts,
    totalConversations,
    totalCalls,
    activeSeats,
    workspace,
  ] = await Promise.all([
    prisma.salesLeadAssignment.count({ where: { tenantId } }),
    prisma.marketingContact.count({ where: { tenantId } }),
    prisma.appConversation.count({ where: { tenantId } }),
    prisma.salesMobileCall.count({ where: { tenantId } }),
    prisma.appAuthUser.count({ where: { tenantId } }),
    prisma.aicloserWorkspace.findUnique({ where: { id: tenantId } }),
  ]);

  const maxSeats = workspace?.maxSeats || 5;

  res.json({
    success: true,
    data: {
      workspaceId: tenantId,
      usage: {
        seats: {
          used: activeSeats,
          limit: maxSeats,
          remaining: Math.max(0, maxSeats - activeSeats),
        },
        leads: {
          total: totalLeads,
          limit: null, // unlimited
        },
        contacts: {
          total: totalContacts,
          limit: 50000,
        },
        conversations: {
          total: totalConversations,
          limit: null,
        },
        callsLogged: {
          total: totalCalls,
          limit: null,
        },
      },
      serverTimestamp: new Date().toISOString(),
    },
    error: null,
  });
});

// GET /api/v1/workspace/settings - Retrieve workspace settings
workspaceRouter.get('/settings', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};

  res.json({
    success: true,
    data: settings,
    settings,
    allowManagerLeadDeletion: Boolean(settings.allowManagerLeadDeletion),
    error: null,
  });
});

// PATCH /api/v1/workspace/settings - Update workspace settings (Admin / Super Admin)
workspaceRouter.patch('/settings', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body || {};

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const currentSettings = (workspace?.settings as Record<string, any>) || {};
  const updatedSettings = {
    ...currentSettings,
    ...body,
  };

  const updated = await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: updatedSettings,
      updatedAt: new Date(),
    },
  });

  res.json({
    success: true,
    message: 'Workspace settings updated successfully',
    data: updated.settings,
    settings: updated.settings,
    allowManagerLeadDeletion: Boolean((updated.settings as Record<string, any>)?.allowManagerLeadDeletion),
    error: null,
  });
});

// PUT /api/v1/workspace/settings - Alias for PATCH
workspaceRouter.put('/settings', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body || {};

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const currentSettings = (workspace?.settings as Record<string, any>) || {};
  const updatedSettings = {
    ...currentSettings,
    ...body,
  };

  const updated = await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: updatedSettings,
      updatedAt: new Date(),
    },
  });

  res.json({
    success: true,
    message: 'Workspace settings updated successfully',
    data: updated.settings,
    settings: updated.settings,
    allowManagerLeadDeletion: Boolean((updated.settings as Record<string, any>)?.allowManagerLeadDeletion),
    error: null,
  });
});

