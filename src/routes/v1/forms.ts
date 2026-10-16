import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';

export const formsRouter = Router();

// Public submission endpoints (no authentication required)
const submitPublicForm = async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const { customerName, customerPhone, customerEmail, serviceInterest, budgetAmount, customFields } = req.body;

  if (!customerName || !customerPhone) {
    res.status(400).json({ ok: false, success: false, error: 'Name and phone number are required' });
    return;
  }

  // Find workspace containing this form slug
  const workspaces = await prisma.aicloserWorkspace.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, settings: true },
  });

  let targetWorkspaceId: string | null = null;
  let targetForm: any = null;

  for (const ws of workspaces) {
    const settings = (ws.settings as any) || {};
    const forms: any[] = settings.forms || [];
    const matched = forms.find((f: any) => f.slug?.toLowerCase() === slug && f.isActive !== false);
    if (matched) {
      targetWorkspaceId = ws.id;
      targetForm = matched;
      break;
    }
  }

  if (!targetWorkspaceId || !targetForm) {
    res.status(404).json({ ok: false, success: false, error: 'FormNotFound', message: 'Form not found or currently inactive' });
    return;
  }

  const cleanPhone = String(customerPhone).replace(/\D/g, '');
  const e164Phone = cleanPhone.length === 10 ? `+91${cleanPhone}` : `+${cleanPhone}`;

  // Find assigned closer: round robin or specific agent
  let assignedAgentId = targetForm.assignedAgentId;
  if (!assignedAgentId || assignedAgentId === 'round_robin') {
    const activeAgents = await prisma.salesAgentProfile.findMany({
      where: { tenantId: targetWorkspaceId, status: { not: 'SUSPENDED' } },
      select: { id: true },
      take: 1,
    });
    assignedAgentId = activeAgents[0]?.id;
  }

  if (!assignedAgentId) {
    // Fallback to any agent profile in tenant
    const anyAgent = await prisma.salesAgentProfile.findFirst({
      where: { tenantId: targetWorkspaceId },
      select: { id: true },
    });
    assignedAgentId = anyAgent?.id;
  }

  if (!assignedAgentId) {
    res.status(500).json({ ok: false, success: false, error: 'NoAgentAvailable', message: 'No sales closer profile configured in workspace' });
    return;
  }

  // Create or upsert lead
  const lead = await prisma.salesLeadAssignment.upsert({
    where: {
      tenantId_customerPhone: {
        tenantId: targetWorkspaceId,
        customerPhone: e164Phone,
      },
    },
    create: {
      tenantId: targetWorkspaceId,
      assignedAgentId,
      customerName,
      customerPhone: e164Phone,
      customerEmail: customerEmail || null,
      source: targetForm.source || 'inbound_web_form',
      serviceInterest: serviceInterest || null,
      budgetAmount: budgetAmount ? Number(budgetAmount) : null,
      stage: targetForm.targetStage || 'NEW',
      tags: targetForm.tags || ['Inbound Web Lead'],
      customFields: customFields || {},
    },
    update: {
      customerName: customerName || undefined,
      customerEmail: customerEmail || undefined,
      serviceInterest: serviceInterest || undefined,
      budgetAmount: budgetAmount ? Number(budgetAmount) : undefined,
      customFields: customFields || undefined,
    },
  });

  // Also upsert MarketingContact
  await prisma.marketingContact.upsert({
    where: {
      tenantId_e164Phone: {
        tenantId: targetWorkspaceId,
        e164Phone,
      },
    },
    create: {
      tenantId: targetWorkspaceId,
      fullName: customerName,
      e164Phone,
      email: customerEmail || null,
      source: targetForm.source || 'INBOUND_FORM',
      leadId: lead.id,
      assignedAgentId,
      optInStatus: 'OPTED_IN',
      optInSource: 'WEB_FORM',
      tags: targetForm.tags || ['Inbound Web Lead'],
    },
    update: {
      fullName: customerName,
      email: customerEmail || undefined,
    },
  }).catch(() => null);

  res.json({
    ok: true,
    success: true,
    leadId: lead.id,
    message: targetForm.successMessage || 'Thank you! A sales specialist has been assigned and will connect with you shortly.',
    redirectUrl: targetForm.redirectUrl || null,
  });
};

formsRouter.post('/submit/:slug', submitPublicForm);
formsRouter.post('/:slug/submit', submitPublicForm);

// Authenticated workspace routes
formsRouter.use(authenticate, enforceTenantIsolation);

// GET /forms (list workspace forms)
formsRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const forms = settings.forms || [];

  res.json({
    ok: true,
    success: true,
    data: forms,
    forms,
    error: null,
  });
});

// POST /forms (create form)
formsRouter.post('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body;

  if (!body.title || !body.slug) {
    res.status(400).json({ ok: false, success: false, error: 'Title and slug are required' });
    return;
  }

  const slug = String(body.slug).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const forms: any[] = settings.forms || [];

  const newForm = {
    id: `form_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: body.title,
    slug,
    description: body.description || '',
    source: body.source || 'inbound_web_form',
    fieldIds: body.fieldIds || [],
    assignedAgentId: body.assignedAgentId || 'round_robin',
    targetStage: body.targetStage || 'NEW',
    tags: body.tags || ['Inbound Web Lead'],
    successMessage: body.successMessage || 'Thank you for reaching out! A specialist will connect with you shortly.',
    redirectUrl: body.redirectUrl || '',
    isActive: body.isActive !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  forms.push(newForm);
  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: { settings: { ...settings, forms } },
  });

  res.status(201).json({
    ok: true,
    success: true,
    data: newForm,
    form: newForm,
  });
});

// GET /forms/:id (get single form)
formsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const forms: any[] = settings.forms || [];
  const form = forms.find((f: any) => f.id === req.params.id || f.slug === req.params.id);

  if (!form) {
    res.status(404).json({ ok: false, success: false, error: 'FormNotFound' });
    return;
  }

  res.json({ ok: true, success: true, data: form, form });
});

// PUT & PATCH /forms/:id (update form)
const updateFormHandler = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const forms: any[] = settings.forms || [];
  const idx = forms.findIndex((f: any) => f.id === req.params.id);

  if (idx === -1) {
    res.status(404).json({ ok: false, success: false, error: 'FormNotFound' });
    return;
  }

  forms[idx] = {
    ...forms[idx],
    ...req.body,
    id: forms[idx].id,
    updatedAt: new Date().toISOString(),
  };

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: { settings: { ...settings, forms } },
  });

  res.json({ ok: true, success: true, data: forms[idx], form: forms[idx] });
};

formsRouter.put('/:id', updateFormHandler);
formsRouter.patch('/:id', updateFormHandler);

// DELETE /forms/:id (delete form)
formsRouter.delete('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const forms: any[] = settings.forms || [];
  const filtered = forms.filter((f: any) => f.id !== req.params.id);

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: { settings: { ...settings, forms: filtered } },
  });

  res.json({ ok: true, success: true });
});

// GET /forms/:id/submissions (get leads submitted through this form)
formsRouter.get('/:id/submissions', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as any) || {};
  const forms: any[] = settings.forms || [];
  const form = forms.find((f: any) => f.id === req.params.id);

  if (!form) {
    res.status(404).json({ ok: false, success: false, error: 'FormNotFound' });
    return;
  }

  const leads = await prisma.salesLeadAssignment.findMany({
    where: {
      tenantId,
      source: form.source || 'inbound_web_form',
    },
    include: {
      assignedAgent: { select: { agentCode: true, user: { select: { displayName: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  res.json({ ok: true, success: true, data: leads, submissions: leads });
});
