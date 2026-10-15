import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { validateBody } from '../../middlewares/validate.js';
import { logger } from '../../lib/logger.js';

export const stagesRouter = Router();

stagesRouter.use(authenticate, enforceTenantIsolation);

export interface PipelineStageConfig {
  id: string;
  key: string;
  label: string;
  color: string;
  probability: number;
  position: number;
  isCustom?: boolean;
}

export const DEFAULT_PIPELINE_STAGES: PipelineStageConfig[] = [
  { id: 'NEW', key: 'NEW', label: 'New Lead', color: '#3B82F6', probability: 0.1, position: 1 },
  { id: 'CONTACTED', key: 'CONTACTED', label: 'Contacted', color: '#8B5CF6', probability: 0.2, position: 2 },
  { id: 'IN_PROGRESS', key: 'IN_PROGRESS', label: 'In Progress', color: '#EC4899', probability: 0.35, position: 3 },
  { id: 'DEMO_SCHEDULED', key: 'DEMO_SCHEDULED', label: 'Demo Booked', color: '#EAB308', probability: 0.5, position: 4 },
  { id: 'FOLLOW_UP', key: 'FOLLOW_UP', label: 'Follow Up', color: '#F97316', probability: 0.6, position: 5 },
  { id: 'NEGOTIATION', key: 'NEGOTIATION', label: 'Negotiation', color: '#6366F1', probability: 0.8, position: 6 },
  { id: 'CLOSED_WON', key: 'CLOSED_WON', label: 'Closed Won', color: '#10B981', probability: 1.0, position: 7 },
  { id: 'CLOSED_LOST', key: 'CLOSED_LOST', label: 'Closed Lost', color: '#EF4444', probability: 0.0, position: 8 },
];

async function getWorkspaceStages(tenantId: string): Promise<PipelineStageConfig[]> {
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  if (Array.isArray(settings.pipelineStages) && settings.pipelineStages.length > 0) {
    return settings.pipelineStages;
  }
  return DEFAULT_PIPELINE_STAGES;
}

async function saveWorkspaceStages(tenantId: string, stages: PipelineStageConfig[]): Promise<void> {
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const existingSettings = (workspace?.settings as Record<string, any>) || {};
  const updatedSettings = {
    ...existingSettings,
    pipelineStages: stages,
  };

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: { settings: updatedSettings as any, updatedAt: new Date() },
  });
}

// 1. GET / - List all pipeline stages for the workspace with lead counts
stagesRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const [stages, stageLeadCounts] = await Promise.all([
    getWorkspaceStages(tenantId),
    prisma.salesLeadAssignment.groupBy({
      by: ['stage'],
      where: { tenantId },
      _count: true,
    }),
  ]);

  const countMap = new Map(stageLeadCounts.map((s) => [s.stage, s._count]));

  const enrichedStages = stages.map((st) => ({
    ...st,
    leadsCount: countMap.get(st.key as any) || 0,
  }));

  res.json({
    success: true,
    data: enrichedStages,
    error: null,
  });
});

const createStageSchema = z.object({
  label: z.string().trim().min(1, 'Stage label is required').max(60),
  color: z.string().trim().regex(/^#([0-9A-F]{3}){1,2}$/i, 'Valid hex color code required (e.g. #3B82F6)').default('#3B82F6'),
  probability: z.number().min(0).max(1).default(0.5),
  key: z.string().trim().min(1).max(40).optional(),
});

// 2. POST / - Create a new custom pipeline status/stage (Admin / Manager only)
stagesRouter.post('/', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(createStageSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body as z.infer<typeof createStageSchema>;

  const currentStages = await getWorkspaceStages(tenantId);

  const rawKey = body.key || body.label.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const stageKey = rawKey.startsWith('CUSTOM_') ? rawKey : `CUSTOM_${rawKey}`;
  const stageId = `stage_${Date.now()}`;

  // Check duplicate key
  if (currentStages.some((s) => s.key === stageKey)) {
    res.status(409).json({
      success: false,
      error: 'DuplicateStage',
      message: `A stage with key "${stageKey}" already exists in this workspace`,
    });
    return;
  }

  const newStage: PipelineStageConfig = {
    id: stageId,
    key: stageKey,
    label: body.label,
    color: body.color,
    probability: body.probability,
    position: currentStages.length + 1,
    isCustom: true,
  };

  const updatedStages = [...currentStages, newStage];
  await saveWorkspaceStages(tenantId, updatedStages);

  logger.info('Created custom pipeline stage', { tenantId, stageKey, label: body.label });

  res.status(201).json({
    success: true,
    message: `Stage "${body.label}" created successfully`,
    data: newStage,
    error: null,
  });
});

const bulkUpdateStagesSchema = z.array(
  z.object({
    id: z.string().min(1),
    key: z.string().min(1),
    label: z.string().min(1),
    color: z.string().min(1),
    probability: z.number().min(0).max(1),
    position: z.number().int(),
    isCustom: z.boolean().optional(),
  })
).min(1, 'At least one stage configuration is required');

// 3. PUT / - Bulk update and reorder stages (Admin / Manager only)
stagesRouter.put('/', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(bulkUpdateStagesSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const newStages = req.body as PipelineStageConfig[];

  // Re-index positions cleanly
  const normalizedStages = newStages.map((s, idx) => ({
    ...s,
    position: idx + 1,
  }));

  await saveWorkspaceStages(tenantId, normalizedStages);

  res.json({
    success: true,
    message: 'Pipeline stages updated and reordered successfully',
    data: normalizedStages,
    error: null,
  });
});

const patchStageSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  color: z.string().trim().regex(/^#([0-9A-F]{3}){1,2}$/i, 'Valid hex color required').optional(),
  probability: z.number().min(0).max(1).optional(),
  position: z.number().int().min(1).optional(),
});

// 4. PATCH /:id - Update single stage properties (Admin / Manager only)
stagesRouter.patch('/:id', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(patchStageSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof patchStageSchema>;

  const currentStages = await getWorkspaceStages(tenantId);
  const targetIndex = currentStages.findIndex((s) => s.id === id || s.key === id);

  if (targetIndex === -1) {
    res.status(404).json({ success: false, error: 'NotFound', message: `Stage "${id}" not found in workspace` });
    return;
  }

  const existing = currentStages[targetIndex];
  const updatedStage: PipelineStageConfig = {
    ...existing,
    ...(body.label ? { label: body.label } : {}),
    ...(body.color ? { color: body.color } : {}),
    ...(body.probability !== undefined ? { probability: body.probability } : {}),
    ...(body.position !== undefined ? { position: body.position } : {}),
  };

  currentStages[targetIndex] = updatedStage;
  await saveWorkspaceStages(tenantId, currentStages);

  res.json({
    success: true,
    message: `Stage "${updatedStage.label}" updated successfully`,
    data: updatedStage,
    error: null,
  });
});

// 5. DELETE /:id - Delete a custom stage (Admin / Manager only)
stagesRouter.delete('/:id', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  // Protect system baseline stages
  const protectedStages = ['NEW', 'CLOSED_WON', 'CLOSED_LOST'];
  if (protectedStages.includes(id)) {
    res.status(400).json({
      success: false,
      error: 'ProtectedStage',
      message: `System baseline stage "${id}" cannot be deleted`,
    });
    return;
  }

  const currentStages = await getWorkspaceStages(tenantId);
  const target = currentStages.find((s) => s.id === id || s.key === id);

  if (!target) {
    res.status(404).json({ success: false, error: 'NotFound', message: `Stage "${id}" not found` });
    return;
  }

  // Check if active leads exist in this stage
  const leadsInStage = await prisma.salesLeadAssignment.count({
    where: { tenantId, stage: target.key as any },
  });

  if (leadsInStage > 0) {
    res.status(409).json({
      success: false,
      error: 'StageHasActiveLeads',
      message: `Cannot delete stage "${target.label}" because ${leadsInStage} active lead(s) are currently in this stage. Reassign them first.`,
    });
    return;
  }

  const filteredStages = currentStages.filter((s) => s.id !== id && s.key !== id);
  await saveWorkspaceStages(tenantId, filteredStages);

  res.json({
    success: true,
    message: `Stage "${target.label}" deleted from workspace`,
    data: { deletedStageId: id },
    error: null,
  });
});

// 6. POST /reset - Reset workspace pipeline stages to system defaults (Admin / Manager only)
stagesRouter.post('/reset', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  await saveWorkspaceStages(tenantId, DEFAULT_PIPELINE_STAGES);

  res.json({
    success: true,
    message: 'Pipeline stages reset to default settings',
    data: DEFAULT_PIPELINE_STAGES,
    error: null,
  });
});

