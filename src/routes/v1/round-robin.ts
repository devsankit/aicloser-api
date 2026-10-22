import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { validateBody } from '../../middlewares/validate.js';
import { logger } from '../../lib/logger.js';

export const roundRobinRouter = Router();

roundRobinRouter.use(authenticate, enforceTenantIsolation);

export interface RoundRobinSettings {
  enabled: boolean;
  mode: 'STRICT_ROUND_ROBIN' | 'WEIGHTED' | 'LOAD_BALANCED';
  maxActiveLeadsPerCloser: number;
  allowNonAdminModifyLeads: boolean;
  allowNonAdminDeleteLeads: boolean;
  allowNonAdminImportData: boolean;
  allowNonAdminExportData: boolean;
  allowNonAdminBulkCampaigns: boolean;
  allowQrLeadsRoundRobin: boolean;
  workingHoursOnly: boolean;
  workingHours: {
    start: string; // HH:mm
    end: string;   // HH:mm
    timezone: string;
  };
  excludeInactiveClosers: boolean;
  closerWeights: Record<string, number>;
  lastAssignedAgentId: string | null;
  batchSize: number;
  maxVisibleToCloser?: number;
  breakDurationMinutes?: number;
}

const DEFAULT_ROUND_ROBIN_SETTINGS: RoundRobinSettings = {
  enabled: true,
  mode: 'STRICT_ROUND_ROBIN',
  maxActiveLeadsPerCloser: 50,
  maxVisibleToCloser: 5,
  breakDurationMinutes: 30,
  allowNonAdminModifyLeads: true,
  allowNonAdminDeleteLeads: false,
  allowNonAdminImportData: true,
  allowNonAdminExportData: false,
  allowNonAdminBulkCampaigns: false,
  allowQrLeadsRoundRobin: false,
  workingHoursOnly: false,
  workingHours: {
    start: '09:00',
    end: '19:00',
    timezone: 'Asia/Kolkata',
  },
  excludeInactiveClosers: true,
  closerWeights: {},
  lastAssignedAgentId: null,
  batchSize: 1,
};

async function getRoundRobinSettings(tenantId: string): Promise<RoundRobinSettings> {
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  if (settings.roundRobinSettings && typeof settings.roundRobinSettings === 'object') {
    return { ...DEFAULT_ROUND_ROBIN_SETTINGS, ...settings.roundRobinSettings };
  }
  return DEFAULT_ROUND_ROBIN_SETTINGS;
}

async function saveRoundRobinSettings(tenantId: string, rr: Partial<RoundRobinSettings>): Promise<RoundRobinSettings> {
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const currentSettings = (workspace?.settings as Record<string, any>) || {};
  const currentRR = (currentSettings.roundRobinSettings as Record<string, any>) || DEFAULT_ROUND_ROBIN_SETTINGS;
  const mergedRR = { ...currentRR, ...rr };
  const currentBreaks = (currentSettings.breakSettings as Record<string, any>) || {};
  const updatedBreaks = (rr as any).breakDurationMinutes !== undefined
    ? { ...currentBreaks, durationMinutes: (rr as any).breakDurationMinutes }
    : currentBreaks;

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...currentSettings,
        roundRobinSettings: mergedRR,
        breakSettings: updatedBreaks,
      },
      updatedAt: new Date(),
    },
  });

  return mergedRR as RoundRobinSettings;
}

// 1. GET / - Get workspace round robin settings and distribution telemetry
roundRobinRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const settings = await getRoundRobinSettings(tenantId);

  // Fetch closers and active lead counts using clean relation count
  const profiles = await prisma.salesAgentProfile.findMany({
    where: { tenantId },
    include: {
      user: { select: { id: true, displayName: true, email: true, phone: true } },
      _count: {
        select: {
          leadAssignments: {
            where: { stage: { notIn: ['CLOSED_WON', 'CLOSED_LOST', 'LOST'] as any } },
          },
        },
      },
    },
  });

  const closers = profiles.map((p) => {
    const activeLeads = p._count?.leadAssignments || 0;
    const isAtQuota = activeLeads >= settings.maxActiveLeadsPerCloser;
    const isAvailable = p.status === 'ACTIVE' && (!settings.excludeInactiveClosers || p.status === 'ACTIVE') && !isAtQuota;

    return {
      agentId: p.id,
      userId: p.userId,
      name: p.user?.displayName || 'Unknown Agent',
      email: p.user?.email || null,
      phone: p.user?.phone || null,
      status: p.status,
      activeLeads,
      maxQuota: settings.maxActiveLeadsPerCloser,
      weight: settings.closerWeights[p.id] || 1,
      isAtQuota,
      isAvailable,
    };
  });

  res.json({
    success: true,
    data: {
      settings,
      closers,
      summary: {
        totalClosers: profiles.length,
        availableClosers: closers.filter((c) => c.isAvailable).length,
        roundRobinActive: settings.enabled,
      },
    },
    error: null,
  });
});

const updateSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['STRICT_ROUND_ROBIN', 'WEIGHTED', 'LOAD_BALANCED']).optional(),
  maxActiveLeadsPerCloser: z.number().int().min(1).max(5000).optional(),
  allowNonAdminModifyLeads: z.boolean().optional(),
  allowNonAdminDeleteLeads: z.boolean().optional(),
  allowNonAdminImportData: z.boolean().optional(),
  allowNonAdminExportData: z.boolean().optional(),
  allowNonAdminBulkCampaigns: z.boolean().optional(),
  allowQrLeadsRoundRobin: z.boolean().optional(),
  workingHoursOnly: z.boolean().optional(),
  workingHours: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
    timezone: z.string().default('Asia/Kolkata'),
  }).optional(),
  excludeInactiveClosers: z.boolean().optional(),
  closerWeights: z.record(z.number().min(0).max(100)).optional(),
  batchSize: z.number().int().min(1).max(100).optional(),
  maxVisibleToCloser: z.number().int().min(1).max(100).optional(),
  breakDurationMinutes: z.number().int().min(5).max(240).optional(),
});

// 2. PUT/PATCH / - Update round robin settings (Admin / Manager only)
const handleUpdateSettings = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const updated = await saveRoundRobinSettings(tenantId, req.body);

  logger.info('Updated round robin settings', { tenantId, mode: updated.mode, enabled: updated.enabled });

  res.json({
    success: true,
    message: 'Round robin settings updated successfully',
    data: updated,
    error: null,
  });
};

roundRobinRouter.put('/', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(updateSettingsSchema), handleUpdateSettings);
roundRobinRouter.patch('/', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(updateSettingsSchema), handleUpdateSettings);

// 3. GET /rules - List assignment / distribution rules
roundRobinRouter.get('/rules', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const rules = await prisma.salesRoundRobinRule.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    success: true,
    data: { rules },
    error: null,
  });
});

const createRuleSchema = z.object({
  title: z.string().trim().min(1, 'Rule title is required').max(100),
  teamId: z.string().optional(),
  isActive: z.boolean().default(true),
  maxActiveLeads: z.number().int().min(1).optional(),
  requireTrainingLevel: z.string().optional(),
  priorityMode: z.string().optional(),
  batchSize: z.number().int().min(1).default(1),
});

// 4. POST /rules - Create distribution rule (Admin / Manager only)
roundRobinRouter.post('/rules', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(createRuleSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body as z.infer<typeof createRuleSchema>;

  const rule = await prisma.salesRoundRobinRule.create({
    data: {
      tenantId,
      title: body.title,
      teamId: body.teamId,
      isActive: body.isActive,
      maxActiveLeads: body.maxActiveLeads,
      requireTrainingLevel: body.requireTrainingLevel,
      priorityMode: body.priorityMode,
      batchSize: body.batchSize || 1,
    },
  });

  res.status(201).json({
    success: true,
    message: `Rule "${rule.title}" created successfully`,
    data: { rule },
    error: null,
  });
});

const updateRuleSchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  teamId: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  maxActiveLeads: z.number().int().min(1).optional().nullable(),
  requireTrainingLevel: z.string().optional().nullable(),
  priorityMode: z.string().optional().nullable(),
  batchSize: z.number().int().min(1).optional(),
});

// 5. GET /rules/:id - Get rule detail
roundRobinRouter.get('/rules/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const rule = await prisma.salesRoundRobinRule.findFirst({
    where: { id: Array.isArray(id) ? id[0] : id, tenantId },
  });

  if (!rule) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Round robin rule not found in workspace' });
    return;
  }

  res.json({ success: true, data: { rule }, error: null });
});

// 6. PUT/PATCH /rules/:id - Update rule (Admin / Manager only)
const handleUpdateRule = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const existing = await prisma.salesRoundRobinRule.findFirst({
    where: { id: Array.isArray(id) ? id[0] : id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Round robin rule not found in workspace' });
    return;
  }

  const updated = await prisma.salesRoundRobinRule.update({
    where: { id: existing.id },
    data: req.body,
  });

  res.json({
    success: true,
    message: `Rule "${updated.title}" updated successfully`,
    data: { rule: updated },
    error: null,
  });
};

roundRobinRouter.put('/rules/:id', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(updateRuleSchema), handleUpdateRule);
roundRobinRouter.patch('/rules/:id', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(updateRuleSchema), handleUpdateRule);

// 7. DELETE /rules/:id - Delete rule (Admin / Manager only)
roundRobinRouter.delete('/rules/:id', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const existing = await prisma.salesRoundRobinRule.findFirst({
    where: { id: Array.isArray(id) ? id[0] : id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Round robin rule not found in workspace' });
    return;
  }

  await prisma.salesRoundRobinRule.delete({
    where: { id: existing.id },
  });

  res.json({
    success: true,
    message: `Rule "${existing.title}" deleted successfully`,
    data: { deletedId: existing.id },
    error: null,
  });
});

// 8. GET /closers - List eligible closers with quota and status
roundRobinRouter.get('/closers', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const settings = await getRoundRobinSettings(tenantId);

  // Strictly fetch non-admin active sales agents only
  const profiles = await prisma.salesAgentProfile.findMany({
    where: {
      tenantId,
      user: {
        role: 'SALES_AGENT', // STRICT ADMIN & MANAGER EXCLUSION
        packageStatus: 'ACTIVE',
      },
    },
    include: {
      user: { select: { id: true, displayName: true, email: true } },
      _count: {
        select: {
          leadAssignments: {
            where: { stage: { notIn: ['CLOSED_WON', 'CLOSED_LOST', 'LOST'] as any } },
          },
        },
      },
    },
  });

  const data = profiles.map((p) => {
    const activeLeads = p._count?.leadAssignments || 0;
    const isAtQuota = activeLeads >= settings.maxActiveLeadsPerCloser;
    return {
      agentId: p.id,
      userId: p.userId,
      name: p.user?.displayName || 'Agent',
      email: p.user?.email || null,
      status: p.status,
      activeLeads,
      maxQuota: settings.maxActiveLeadsPerCloser,
      eligible: p.status === 'ACTIVE' && !isAtQuota,
    };
  });

  res.json({
    success: true,
    data: { closers: data },
    error: null,
  });
});

// 9. POST /assign - Assign lead(s) using round-robin logic with quota enforcement
const assignLeadSchema = z.object({
  leadId: z.string().optional(),
  leadIds: z.array(z.string()).optional(),
  preferredCloserId: z.string().optional(),
});

roundRobinRouter.post('/assign', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(assignLeadSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { leadId, leadIds, preferredCloserId } = req.body as z.infer<typeof assignLeadSchema>;

  const targets: string[] = [];
  if (leadId) targets.push(leadId);
  if (Array.isArray(leadIds)) targets.push(...leadIds);

  if (targets.length === 0) {
    res.status(400).json({ success: false, error: 'BadRequest', message: 'Provide leadId or leadIds array to assign' });
    return;
  }

  const settings = await getRoundRobinSettings(tenantId);
  if (!settings.enabled) {
    res.status(400).json({ success: false, error: 'RoundRobinDisabled', message: 'Round-robin assignment is disabled in workspace settings' });
    return;
  }

  // Strictly fetch non-admin active sales agents only
  const profiles = await prisma.salesAgentProfile.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      user: {
        role: 'SALES_AGENT', // STRICT ADMIN & MANAGER EXCLUSION
        packageStatus: 'ACTIVE',
      },
    },
    include: {
      user: { select: { id: true, displayName: true, email: true } },
      _count: {
        select: {
          leadAssignments: {
            where: { stage: { notIn: ['CLOSED_WON', 'CLOSED_LOST', 'LOST'] as any } },
          },
        },
      },
    },
  });

  if (profiles.length === 0) {
    res.status(409).json({ success: false, error: 'NoActiveClosers', message: 'No active closers found in workspace for lead assignment' });
    return;
  }

  // Filter closers below quota
  let eligible = profiles.filter((p) => {
    const active = p._count?.leadAssignments || 0;
    return active < settings.maxActiveLeadsPerCloser;
  });

  if (eligible.length === 0) {
    res.status(409).json({
      success: false,
      error: 'AllClosersAtQuota',
      message: `All ${profiles.length} active closers have reached their quota limit of ${settings.maxActiveLeadsPerCloser} active leads`,
    });
    return;
  }

  // Handle preferred closer if valid and eligible
  if (preferredCloserId) {
    const preferred = eligible.find((p) => p.id === preferredCloserId);
    if (preferred) {
      eligible = [preferred];
    }
  }

  // Select next closer using mode
  let selectedCloser = eligible[0];

  if (settings.mode === 'LOAD_BALANCED') {
    eligible.sort((a, b) => (a._count?.leadAssignments || 0) - (b._count?.leadAssignments || 0));
    selectedCloser = eligible[0];
  } else {
    // STRICT_ROUND_ROBIN
    const lastIndex = eligible.findIndex((p) => p.id === settings.lastAssignedAgentId);
    const nextIndex = lastIndex >= 0 ? (lastIndex + 1) % eligible.length : 0;
    selectedCloser = eligible[nextIndex];
  }

  const assignedResults: Array<{ leadId: string; customerName: string | null; assignedAgentId: string; agentName: string }> = [];

  for (const tid of targets) {
    const lead = await prisma.salesLeadAssignment.findFirst({
      where: { id: tid, tenantId },
    });

    if (!lead) continue;

    const updated = await prisma.salesLeadAssignment.update({
      where: { id: lead.id },
      data: {
        assignedAgentId: selectedCloser.id,
        stage: lead.stage === 'NEW' ? 'ASSIGNED' : lead.stage,
        updatedAt: new Date(),
      },
    });

    await prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: lead.id,
        actorUserId: req.user?.userId,
        action: 'ROUND_ROBIN_ASSIGNMENT',
        note: `Assigned lead to ${selectedCloser.user?.displayName || 'Agent'} via ${settings.mode}`,
        metadata: { agentId: selectedCloser.id, previousAgentId: lead.assignedAgentId },
      },
    }).catch(() => undefined);

    assignedResults.push({
      leadId: updated.id,
      customerName: updated.customerName,
      assignedAgentId: selectedCloser.id,
      agentName: selectedCloser.user?.displayName || 'Agent',
    });
  }

  // Update last assigned agent ID
  await saveRoundRobinSettings(tenantId, { lastAssignedAgentId: selectedCloser.id });

  res.json({
    success: true,
    message: `Assigned ${assignedResults.length} lead(s) to ${selectedCloser.user?.displayName || 'Agent'}`,
    data: {
      assignments: assignedResults,
      assignedAgent: {
        agentId: selectedCloser.id,
        name: selectedCloser.user?.displayName || 'Agent',
        email: selectedCloser.user?.email || null,
        currentLoad: (selectedCloser._count?.leadAssignments || 0) + assignedResults.length,
      },
    },
    error: null,
  });
});


// ==========================================
// 10. Source-Wise Distribution Rules
// ==========================================

export interface SourceDistributionRule {
  source: string; // e.g. WHATSAPP, GOOGLE_SHEETS, CSV, EXCEL, INDIAMART, JUSTDIAL, EMAIL
  action: 'ROUND_ROBIN' | 'POOL' | 'MANUAL';
  allowedCloserIds?: string[];
  maxDailyLeads?: number;
  enabled: boolean;
}

// GET /source-rules - List configured distribution rules per lead source
roundRobinRouter.get('/source-rules', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const sourceRules: SourceDistributionRule[] = settings.sourceDistributionRules || [];

  res.json({
    success: true,
    data: {
      rules: sourceRules,
      availableSources: ['WHATSAPP', 'GOOGLE_SHEETS', 'CSV', 'EXCEL', 'INDIAMART', 'JUSTDIAL', 'FACEBOOK_ADS', 'EMAIL', 'MANUAL'],
    },
    error: null,
  });
});

// POST /source-rules - Upsert a source distribution rule
const sourceRuleSchema = z.object({
  source: z.string().min(1, 'Source name is required'),
  action: z.enum(['ROUND_ROBIN', 'POOL', 'MANUAL']),
  allowedCloserIds: z.array(z.string()).optional(),
  maxDailyLeads: z.number().int().min(1).optional(),
  enabled: z.boolean().default(true),
});

roundRobinRouter.post('/source-rules', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(sourceRuleSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { source, action, allowedCloserIds, maxDailyLeads, enabled } = req.body;
  const upperSource = source.toUpperCase().trim();

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const currentRules: SourceDistributionRule[] = settings.sourceDistributionRules || [];

  const existingIdx = currentRules.findIndex((r) => r.source.toUpperCase() === upperSource);
  const ruleObj: SourceDistributionRule = {
    source: upperSource,
    action,
    allowedCloserIds: allowedCloserIds || [],
    maxDailyLeads,
    enabled: enabled !== false,
  };

  if (existingIdx >= 0) {
    currentRules[existingIdx] = ruleObj;
  } else {
    currentRules.push(ruleObj);
  }

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        sourceDistributionRules: currentRules,
      } as any,
      updatedAt: new Date(),
    },
  });

  res.json({
    success: true,
    message: `Distribution rule for source "${upperSource}" saved successfully`,
    data: { rule: ruleObj, totalRules: currentRules.length },
    error: null,
  });
});

// DELETE /source-rules/:source - Remove a source distribution rule
roundRobinRouter.delete('/source-rules/:source', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { source } = req.params;
  const upperSource = String(Array.isArray(source) ? source[0] : source).toUpperCase().trim();

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const currentRules: SourceDistributionRule[] = settings.sourceDistributionRules || [];

  const filtered = currentRules.filter((r) => r.source.toUpperCase() !== upperSource);

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        sourceDistributionRules: filtered,
      } as any,
      updatedAt: new Date(),
    },
  });

  res.json({
    success: true,
    message: `Distribution rule for source "${upperSource}" removed`,
    data: { deletedSource: upperSource, remainingRules: filtered.length },
    error: null,
  });
});
