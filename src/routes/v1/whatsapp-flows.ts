import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { logger } from '../../lib/logger.js';

export const whatsappFlowsRouter = Router();

whatsappFlowsRouter.use(authenticate, enforceTenantIsolation);

function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `plugin-${randomUUID().slice(0, 8)}`
  );
}

function fromDbStatus(status: string): 'ACTIVE' | 'PAUSED' | 'ERROR' | 'DRAFT' {
  const s = String(status).trim().toLowerCase();
  if (s === 'active') return 'ACTIVE';
  if (s === 'paused') return 'PAUSED';
  if (s === 'error') return 'ERROR';
  return 'DRAFT';
}

function toDbStatus(status?: string): string {
  const s = String(status || 'draft').trim().toLowerCase();
  if (s === 'active') return 'active';
  if (s === 'paused') return 'paused';
  if (s === 'error') return 'error';
  return 'draft';
}

function serializeFlow(record: any) {
  const settings = (record.settingsJson && typeof record.settingsJson === 'object' ? record.settingsJson : {}) as Record<string, any>;
  const nodes = Array.isArray(record.nodesJson) ? record.nodesJson : [];
  const edges = Array.isArray(record.edgesJson) ? record.edgesJson : [];

  return {
    id: record.id,
    name: record.name,
    summary: record.description || '',
    status: fromDbStatus(record.status),
    triggerMode: (settings.triggerMode === 'ANY_INCOMING' ? 'ANY_INCOMING' : 'KEYWORD') as 'ANY_INCOMING' | 'KEYWORD',
    triggerKeyword: String(settings.triggerKeyword || 'Get OTP'),
    channel: 'OFFICIAL_GIGXOMI' as const,
    pluginKey: String(settings.pluginKey || slugify(record.name)),
    pluginVersion: Number(record.version || 1),
    pluginStatus: (settings.pluginStatus || 'INTERNAL_ONLY') as 'INTERNAL_ONLY' | 'READY_TO_DEPLOY' | 'DEPLOYED',
    testedAt: settings.testedAt || null,
    deployments: Array.isArray(settings.deployments) ? settings.deployments : [],
    nodes,
    edges,
    createdAt: record.createdAt ? new Date(record.createdAt).toISOString() : new Date().toISOString(),
    updatedAt: record.updatedAt ? new Date(record.updatedAt).toISOString() : new Date().toISOString(),
  };
}

function serializeRun(record: any) {
  const context = (record.contextJson && typeof record.contextJson === 'object' ? record.contextJson : {}) as Record<string, any>;
  const s = String(record.status || 'success').trim().toLowerCase();
  const normalizedStatus = s === 'waiting' || s === 'running' ? 'WAITING' : s === 'failed' ? 'FAILED' : 'SUCCESS';

  return {
    id: record.id,
    flowId: record.flowId,
    flowName: record.flow?.name || context.flowName || 'WhatsApp Flow',
    status: normalizedStatus as 'SUCCESS' | 'WAITING' | 'FAILED',
    summary: context.summary || `Executed node ${record.currentNodeId || 'start'}`,
    createdAt: record.startedAt ? new Date(record.startedAt).toISOString() : new Date().toISOString(),
    startedAt: record.startedAt ? new Date(record.startedAt).toISOString() : new Date().toISOString(),
  };
}

async function getTenantFlowsAndRuns(tenantId: string) {
  const [dbFlows, dbRuns] = await Promise.all([
    prisma.whatsAppFlow.findMany({
      where: {
        OR: [{ tenantId }, { platformScope: 'platform', tenantId: null }],
      },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.whatsAppFlowRun.findMany({
      where: { tenantId },
      include: { flow: { select: { name: true } } },
      orderBy: { startedAt: 'desc' },
      take: 50,
    }),
  ]);

  const flows = dbFlows.map(serializeFlow);
  const runs = dbRuns.map(serializeRun);

  return { flows, runs };
}

// 1. List all flows and recent runs
whatsappFlowsRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { flows, runs } = await getTenantFlowsAndRuns(tenantId);

  res.json({
    success: true,
    ok: true,
    flows,
    runs,
    data: { flows, runs },
    error: null,
  });
});

// 2. Flow execution runs across tenant
whatsappFlowsRouter.get('/runs', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const dbRuns = await prisma.whatsAppFlowRun.findMany({
    where: { tenantId },
    include: { flow: { select: { name: true } } },
    orderBy: { startedAt: 'desc' },
    take: 100,
  });

  const runs = dbRuns.map(serializeRun);
  res.json({ success: true, ok: true, runs, data: runs, error: null });
});

// 3. Get single flow by ID
whatsappFlowsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const dbFlow = await prisma.whatsAppFlow.findFirst({
    where: {
      id,
      OR: [{ tenantId }, { platformScope: 'platform', tenantId: null }],
    },
  });

  if (!dbFlow) {
    res.status(404).json({ success: false, ok: false, error: 'Flow not found in workspace' });
    return;
  }

  const dbRuns = await prisma.whatsAppFlowRun.findMany({
    where: { flowId: dbFlow.id, tenantId },
    include: { flow: { select: { name: true } } },
    orderBy: { startedAt: 'desc' },
    take: 20,
  });

  const flow = serializeFlow(dbFlow);
  const runs = dbRuns.map(serializeRun);

  res.json({
    success: true,
    ok: true,
    flow,
    runs,
    data: { flow, runs },
    error: null,
  });
});

// 4. Create or Save Flow (POST /)
whatsappFlowsRouter.post('/', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body || {};

  const name = String(body.name || '').trim();
  if (!name) {
    res.status(400).json({ success: false, ok: false, error: 'Flow name is required' });
    return;
  }

  const targetId = body.id && body.id !== 'draft' && !body.id.startsWith('draft-')
    ? String(body.id)
    : `flow_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const summary = String(body.summary || body.description || '').trim();
  const dbStatus = toDbStatus(body.status);
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  const edges = Array.isArray(body.edges) ? body.edges : [];

  const settingsJson = {
    triggerMode: body.triggerMode === 'ANY_INCOMING' ? 'ANY_INCOMING' : 'KEYWORD',
    triggerKeyword: String(body.triggerKeyword || 'Get OTP'),
    pluginKey: String(body.pluginKey || slugify(name)),
    pluginStatus: String(body.pluginStatus || (dbStatus === 'active' ? 'DEPLOYED' : 'INTERNAL_ONLY')),
    testedAt: body.testedAt || new Date().toISOString(),
    deployments: Array.isArray(body.deployments) ? body.deployments : [],
  };

  const saved = await prisma.whatsAppFlow.upsert({
    where: { id: targetId },
    create: {
      id: targetId,
      tenantId,
      name,
      description: summary,
      status: dbStatus,
      nodesJson: nodes as any,
      edgesJson: edges as any,
      settingsJson: settingsJson as any,
      version: Number(body.pluginVersion || 1),
      createdBy: req.user?.userId,
      updatedBy: req.user?.userId,
    },
    update: {
      name,
      description: summary,
      status: dbStatus,
      nodesJson: nodes as any,
      edgesJson: edges as any,
      settingsJson: settingsJson as any,
      version: { increment: 1 },
      updatedBy: req.user?.userId,
    },
  });

  const flow = serializeFlow(saved);
  const { flows, runs } = await getTenantFlowsAndRuns(tenantId);

  logger.info('WhatsApp Flow saved successfully', { tenantId, flowId: flow.id, action: 'FLOW_SAVED' });

  res.status(200).json({
    success: true,
    ok: true,
    flow,
    flows,
    runs,
    data: flow,
    message: 'Flow saved successfully',
    error: null,
  });
});

// 5. Update Flow Meta or Content (PATCH /:id or PATCH / with id in body)
const handlePatchFlow = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id || req.body?.id || '').trim();

  if (!id) {
    res.status(400).json({ success: false, ok: false, error: 'Flow id is required for update' });
    return;
  }

  const existing = await prisma.whatsAppFlow.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ success: false, ok: false, error: 'Flow not found in workspace' });
    return;
  }

  const body = req.body || {};
  const updateData: any = {
    updatedBy: req.user?.userId,
  };

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) {
      res.status(400).json({ success: false, ok: false, error: 'Flow name cannot be empty' });
      return;
    }
    updateData.name = name;
  }

  if (body.summary !== undefined || body.description !== undefined) {
    updateData.description = String(body.summary || body.description || '').trim();
  }

  if (body.status !== undefined) {
    updateData.status = toDbStatus(body.status);
  }

  if (Array.isArray(body.nodes)) {
    updateData.nodesJson = body.nodes as any;
  }

  if (Array.isArray(body.edges)) {
    updateData.edgesJson = body.edges as any;
  }

  const currentSettings = (existing.settingsJson && typeof existing.settingsJson === 'object' ? existing.settingsJson : {}) as Record<string, any>;
  const newSettings = { ...currentSettings };

  if (body.triggerMode !== undefined) newSettings.triggerMode = body.triggerMode;
  if (body.triggerKeyword !== undefined) newSettings.triggerKeyword = body.triggerKeyword;
  if (body.pluginKey !== undefined) newSettings.pluginKey = body.pluginKey;
  if (body.pluginStatus !== undefined) newSettings.pluginStatus = body.pluginStatus;
  if (body.deployments !== undefined) newSettings.deployments = body.deployments;
  if (body.testedAt !== undefined) newSettings.testedAt = body.testedAt;

  updateData.settingsJson = newSettings as any;

  const updated = await prisma.whatsAppFlow.update({
    where: { id },
    data: updateData,
  });

  const flow = serializeFlow(updated);
  const { flows, runs } = await getTenantFlowsAndRuns(tenantId);

  res.json({
    success: true,
    ok: true,
    flow,
    flows,
    runs,
    data: flow,
    message: 'Flow updated successfully',
    error: null,
  });
};

whatsappFlowsRouter.patch('/:id', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), handlePatchFlow);
whatsappFlowsRouter.patch('/', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), handlePatchFlow);

// 6. Delete Flow (DELETE /:id or DELETE / with id in body)
const handleDeleteFlow = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id || req.body?.id || '').trim();

  if (!id) {
    res.status(400).json({ success: false, ok: false, error: 'Flow id is required for deletion' });
    return;
  }

  const existing = await prisma.whatsAppFlow.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ success: false, ok: false, error: 'Flow not found in workspace' });
    return;
  }

  await prisma.whatsAppFlow.delete({ where: { id } });

  const { flows, runs } = await getTenantFlowsAndRuns(tenantId);

  res.json({
    success: true,
    ok: true,
    flows,
    runs,
    message: 'Flow deleted successfully',
    error: null,
  });
};

whatsappFlowsRouter.delete('/:id', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), handleDeleteFlow);
whatsappFlowsRouter.delete('/', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), handleDeleteFlow);

// 7. Toggle Flow Status (POST /:id/toggle)
whatsappFlowsRouter.post('/:id/toggle', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const existing = await prisma.whatsAppFlow.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ success: false, ok: false, error: 'Flow not found in workspace' });
    return;
  }

  const currentStatus = String(existing.status).toLowerCase();
  const nextStatus = currentStatus === 'active' ? 'draft' : 'active';

  const updated = await prisma.whatsAppFlow.update({
    where: { id },
    data: { status: nextStatus, updatedBy: req.user?.userId },
  });

  const flow = serializeFlow(updated);
  const { flows, runs } = await getTenantFlowsAndRuns(tenantId);

  res.json({
    success: true,
    ok: true,
    flow,
    flows,
    runs,
    data: flow,
    message: `Flow status toggled to ${flow.status}`,
    error: null,
  });
});

// 8. Get Flow Runs (GET /:id/runs)
whatsappFlowsRouter.get('/:id/runs', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const flowId = String(req.params.id);

  const dbRuns = await prisma.whatsAppFlowRun.findMany({
    where: { flowId, tenantId },
    include: { flow: { select: { name: true } } },
    orderBy: { startedAt: 'desc' },
    take: 50,
  });

  const runs = dbRuns.map(serializeRun);
  res.json({ success: true, ok: true, runs, data: runs, error: null });
});

// 9. Test Run Simulation (POST /:id/test-run)
whatsappFlowsRouter.post('/:id/test-run', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const flowId = String(req.params.id);

  const flow = await prisma.whatsAppFlow.findFirst({
    where: { id: flowId, tenantId },
  });

  if (!flow) {
    res.status(404).json({ success: false, ok: false, error: 'Flow not found in workspace' });
    return;
  }

  const runId = `run_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const newRun = await prisma.whatsAppFlowRun.create({
    data: {
      id: runId,
      flowId,
      tenantId,
      contactId: 'simulated_user',
      channel: 'whatsapp',
      status: 'completed',
      currentNodeId: 'end',
      contextJson: {
        summary: `Test run completed successfully for ${flow.name}`,
        flowName: flow.name,
        simulated: true,
      },
    },
    include: { flow: { select: { name: true } } },
  });

  const run = serializeRun(newRun);
  res.status(201).json({
    success: true,
    ok: true,
    run,
    data: run,
    message: 'Test run executed successfully',
    error: null,
  });
});
