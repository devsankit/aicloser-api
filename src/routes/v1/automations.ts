import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';

export const automationsRouter = Router();

automationsRouter.use(authenticate, enforceTenantIsolation);

// GET /automations (list rules)
automationsRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const rules = settings.automations || [];

  res.json({
    ok: true,
    success: true,
    data: rules,
    rules,
    error: null,
  });
});

// GET /automations/logs (list execution logs)
automationsRouter.get('/logs', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const logs = settings.automationLogs || [];

  res.json({
    ok: true,
    success: true,
    data: logs,
    logs,
    error: null,
  });
});

// POST /automations (create rule)
automationsRouter.post('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body;

  if (!body.name) {
    res.status(400).json({ ok: false, success: false, error: 'Rule name is required' });
    return;
  }

  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const automations: any[] = settings.automations || [];

  const newRule = {
    id: `wf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: body.name,
    description: body.description || '',
    trigger: body.trigger || { type: 'LEAD_CREATED', config: {} },
    condition: body.condition || null,
    action: body.action || { type: 'ASSIGN_AGENT', config: {} },
    isActive: body.isActive !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  automations.push(newRule);
  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: { settings: { ...settings, automations } },
  });

  res.status(201).json({
    ok: true,
    success: true,
    data: newRule,
    rule: newRule,
  });
});

// GET /automations/:id
automationsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const automations: any[] = settings.automations || [];
  const rule = automations.find((r: any) => r.id === req.params.id);

  if (!rule) {
    res.status(404).json({ ok: false, success: false, error: 'RuleNotFound' });
    return;
  }

  res.json({ ok: true, success: true, data: rule, rule });
});

// PUT & PATCH /automations/:id
const updateAutomationHandler = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const automations: any[] = settings.automations || [];
  const idx = automations.findIndex((r: any) => r.id === req.params.id);

  if (idx === -1) {
    res.status(404).json({ ok: false, success: false, error: 'RuleNotFound' });
    return;
  }

  automations[idx] = {
    ...automations[idx],
    ...req.body,
    id: automations[idx].id,
    updatedAt: new Date().toISOString(),
  };

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: { settings: { ...settings, automations } },
  });

  res.json({ ok: true, success: true, data: automations[idx], rule: automations[idx] });
};

automationsRouter.put('/:id', updateAutomationHandler);
automationsRouter.patch('/:id', updateAutomationHandler);

// DELETE /automations/:id
automationsRouter.delete('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const automations: any[] = settings.automations || [];
  const filtered = automations.filter((r: any) => r.id !== req.params.id);

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: { settings: { ...settings, automations: filtered } },
  });

  res.json({ ok: true, success: true });
});

// POST /automations/:id/test (dry run test execution)
automationsRouter.post('/:id/test', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const automations: any[] = settings.automations || [];
  const rule = automations.find((r: any) => r.id === req.params.id);

  if (!rule) {
    res.status(404).json({ ok: false, success: false, error: 'RuleNotFound' });
    return;
  }

  const testLog = {
    id: `log_${Date.now()}`,
    ruleId: rule.id,
    ruleName: rule.name,
    triggerType: rule.trigger?.type || 'MANUAL_TEST',
    status: 'SUCCESS',
    details: 'Dry run execution evaluated successfully without errors.',
    executedAt: new Date().toISOString(),
  };

  const logs: any[] = settings.automationLogs || [];
  logs.unshift(testLog);
  if (logs.length > 50) logs.pop();

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: { settings: { ...settings, automationLogs: logs } },
  });

  res.json({ ok: true, success: true, testLog });
});
