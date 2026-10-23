import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { logger } from '../../lib/logger.js';

export const formsRouter = Router();

const requireFormAdmin = requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN');

// ==========================================
// Public Form Retrieval & Submission (No Auth Required)
// ==========================================

const getFormBySlugOrId = async (req: Request, res: Response) => {
  const param = String(req.params.slug || req.params.id || '').trim().toLowerCase();

  if (!param) {
    res.status(400).json({ ok: false, success: false, error: 'SlugRequired', message: 'Form slug is required' });
    return;
  }

  // Look up across all active workspaces
  const workspaces = await prisma.aicloserWorkspace.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, name: true, settings: true },
  });

  let matchedForm: any = null;
  let matchedWorkspaceId: string | null = null;

  for (const ws of workspaces) {
    const settings = (ws.settings as Record<string, any>) || {};
    const forms: any[] = Array.isArray(settings.forms) ? settings.forms : [];
    const found = forms.find(
      (f: any) =>
        (f.slug && String(f.slug).toLowerCase() === param) ||
        (f.id && String(f.id).toLowerCase() === param)
    );
    if (found) {
      matchedForm = found;
      matchedWorkspaceId = ws.id;
      break;
    }
  }

  if (!matchedForm) {
    res.status(404).json({
      ok: false,
      success: false,
      error: 'FormNotFound',
      message: `Form "${param}" not found or currently inactive`,
    });
    return;
  }

  const formData = {
    id: matchedForm.id,
    slug: matchedForm.slug,
    title: matchedForm.title || 'Inbound Inquiry',
    description: matchedForm.description || '',
    fields: matchedForm.fields || matchedForm.fieldIds || [],
    submitRedirect: matchedForm.submitRedirect || matchedForm.redirectUrl || '',
    redirectUrl: matchedForm.submitRedirect || matchedForm.redirectUrl || '',
    notifyEmails: matchedForm.notifyEmails || [],
    status: matchedForm.status || (matchedForm.isActive !== false ? 'ACTIVE' : 'INACTIVE'),
    isActive: matchedForm.isActive !== false && matchedForm.status !== 'INACTIVE',
    assignedAgentId: matchedForm.assignedAgentId || 'round_robin',
    targetStage: matchedForm.targetStage || 'NEW',
    tags: matchedForm.tags || ['Inbound Web Lead'],
    successMessage: matchedForm.successMessage || 'Thank you! A sales specialist has been assigned and will connect with you shortly.',
    createdAt: matchedForm.createdAt || new Date().toISOString(),
    updatedAt: matchedForm.updatedAt || new Date().toISOString(),
    workspaceId: matchedWorkspaceId,
  };

  res.json({
    ok: true,
    success: true,
    data: formData,
    form: formData,
    error: null,
  });
};

// Mount public form endpoints
formsRouter.get('/public/:slug', getFormBySlugOrId);
formsRouter.get('/:slug', getFormBySlugOrId);

const submitPublicForm = async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const body = req.body || {};

  const customerName = String(body.customerName || body.name || body.fullName || 'Inbound Lead').trim();
  const rawPhone = String(body.customerPhone || body.phone || body.mobile || body.contactNumber || '').trim();
  const customerEmail = body.customerEmail || body.email ? String(body.customerEmail || body.email).trim() : null;
  const serviceInterest = body.serviceInterest || body.service || body.interest ? String(body.serviceInterest || body.service || body.interest).trim() : null;
  const budgetAmount = body.budgetAmount || body.budget ? Number(body.budgetAmount || body.budget) : null;
  const customFields = body.customFields && typeof body.customFields === 'object' ? body.customFields : {};

  if (!rawPhone) {
    res.status(400).json({ ok: false, success: false, error: 'PhoneRequired', message: 'A valid customer phone number is required' });
    return;
  }

  // Find workspace containing this form slug
  const workspaces = await prisma.aicloserWorkspace.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, name: true, settings: true },
  });

  let targetWorkspaceId: string | null = null;
  let targetForm: any = null;

  for (const ws of workspaces) {
    const settings = (ws.settings as Record<string, any>) || {};
    const forms: any[] = Array.isArray(settings.forms) ? settings.forms : [];
    const matched = forms.find(
      (f: any) =>
        (f.slug && String(f.slug).toLowerCase() === slug) ||
        (f.id && String(f.id).toLowerCase() === slug)
    );
    if (matched) {
      targetWorkspaceId = ws.id;
      targetForm = matched;
      break;
    }
  }

  if (!targetWorkspaceId || !targetForm) {
    res.status(404).json({ ok: false, success: false, error: 'FormNotFound', message: `Form "${slug}" not found or currently inactive` });
    return;
  }

  const cleanDigits = rawPhone.replace(/\D/g, '');
  const e164Phone = cleanDigits.length === 10 ? `+91${cleanDigits}` : (cleanDigits.startsWith('+') ? cleanDigits : `+${cleanDigits}`);

  // Find assigned closer: round robin or specific agent profile
  let assignedAgentId = targetForm.assignedAgentId;
  let activeAgent = null;

  if (assignedAgentId && assignedAgentId !== 'round_robin') {
    activeAgent = await prisma.salesAgentProfile.findFirst({
      where: { id: assignedAgentId, tenantId: targetWorkspaceId, status: { not: 'SUSPENDED' } },
    });
  }

  if (!activeAgent) {
    // Round-robin selection: agent with fewest open leads or any active agent
    activeAgent = await prisma.salesAgentProfile.findFirst({
      where: { tenantId: targetWorkspaceId, status: { not: 'SUSPENDED' } },
      orderBy: { createdAt: 'asc' },
    });
  }

  if (!activeAgent) {
    // Fallback to any agent in workspace
    activeAgent = await prisma.salesAgentProfile.findFirst({
      where: { tenantId: targetWorkspaceId },
    });
  }

  let finalLeadId: string = '';
  let finalStage: string = targetForm.targetStage || 'NEW';

  if (activeAgent) {
    // Ingest into SalesLeadAssignment
    const lead = await prisma.salesLeadAssignment.upsert({
      where: {
        tenantId_customerPhone: {
          tenantId: targetWorkspaceId,
          customerPhone: e164Phone,
        },
      },
      create: {
        tenantId: targetWorkspaceId,
        assignedAgentId: activeAgent.id,
        customerName,
        customerPhone: e164Phone,
        customerEmail,
        source: targetForm.source || 'inbound_web_form',
        serviceInterest,
        budgetAmount,
        stage: finalStage as any,
        tags: targetForm.tags || ['Inbound Web Lead'],
        customFields,
      },
      update: {
        customerName: customerName || undefined,
        customerEmail: customerEmail || undefined,
        serviceInterest: serviceInterest || undefined,
        budgetAmount: budgetAmount || undefined,
        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
      },
    });

    finalLeadId = lead.id;
    finalStage = lead.stage;

    // Log SalesActivityLog entry
    await prisma.salesActivityLog.create({
      data: {
        tenantId: targetWorkspaceId,
        assignmentId: lead.id,
        action: 'LEAD_INGESTED_WEB_FORM',
        note: `Inbound lead submitted via form "${targetForm.title || slug}" (${customerName}, ${e164Phone})`,
        metadata: {
          formSlug: slug,
          customerName,
          customerPhone: e164Phone,
          serviceInterest,
          budgetAmount,
          assignedAgentId: activeAgent.id,
        },
      },
    }).catch((err) => {
      logger.warn('Failed to write form submission activity log', { error: String(err) });
    });
  } else {
    // No agent configured in workspace: ingest directly into SalesLeadPoolItem
    const poolItem = await prisma.salesLeadPoolItem.create({
      data: {
        tenantId: targetWorkspaceId,
        customerName,
        customerPhone: e164Phone,
        customerEmail,
        source: targetForm.source || 'inbound_web_form',
        status: 'OPEN',
        serviceInterest,
        budgetAmount: budgetAmount ? budgetAmount : undefined,
        notes: `Inbound pool lead submitted via form "${targetForm.title || slug}"`,
      },
    });

    finalLeadId = poolItem.id;

    await prisma.salesActivityLog.create({
      data: {
        tenantId: targetWorkspaceId,
        action: 'LEAD_INGESTED_WEB_FORM',
        note: `Inbound pool lead submitted via form "${targetForm.title || slug}" (${customerName}, ${e164Phone})`,
        metadata: {
          poolItemId: poolItem.id,
          formSlug: slug,
          customerName,
          customerPhone: e164Phone,
          serviceInterest,
          budgetAmount,
        },
      },
    }).catch((err) => {
      logger.warn('Failed to write pool form submission activity log', { error: String(err) });
    });
  }

  // Also sync to MarketingContact for omnichannel engagement
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
      email: customerEmail,
      source: targetForm.source || 'INBOUND_FORM',
      leadId: finalLeadId,
      assignedAgentId: activeAgent?.id,
      optInStatus: 'OPTED_IN',
      optInSource: 'WEB_FORM',
      tags: targetForm.tags || ['Inbound Web Lead'],
    },
    update: {
      fullName: customerName,
      email: customerEmail || undefined,
    },
  }).catch(() => null);

  res.status(201).json({
    ok: true,
    success: true,
    leadId: finalLeadId,
    data: {
      leadId: finalLeadId,
      customerName,
      customerPhone: e164Phone,
      stage: finalStage,
      status: 'INGESTED',
    },
    message: targetForm.successMessage || 'Thank you! A sales specialist has been assigned and will connect with you shortly.',
    submitRedirect: targetForm.submitRedirect || targetForm.redirectUrl || null,
    redirectUrl: targetForm.submitRedirect || targetForm.redirectUrl || null,
    error: null,
  });
};

formsRouter.post('/submit/:slug', submitPublicForm);
formsRouter.post('/:slug/submit', submitPublicForm);

// ==========================================
// Authenticated Workspace Routes
// ==========================================
formsRouter.use(authenticate, enforceTenantIsolation);

// GET /forms - list forms in current workspace (Admin and Manager only)
formsRouter.get('/', requireFormAdmin, async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as Record<string, any>) || {};
  const forms = Array.isArray(settings.forms) ? settings.forms : [];

  res.json({
    ok: true,
    success: true,
    data: forms,
    forms,
    error: null,
  });
});

// Upsert Form Handler for PUT /:slug or POST /:slug
const upsertFormHandler = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const rawSlug = String(req.params.slug || req.body.slug || '').trim().toLowerCase();
  const slug = rawSlug.replace(/[^a-z0-9_-]/g, '-');

  if (!slug) {
    res.status(400).json({ ok: false, success: false, error: 'SlugRequired', message: 'Form slug is required' });
    return;
  }

  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as Record<string, any>) || {};
  const forms: any[] = Array.isArray(settings.forms) ? [...settings.forms] : [];

  const existingIdx = forms.findIndex(
    (f: any) =>
      (f.slug && String(f.slug).toLowerCase() === slug) ||
      (f.id && String(f.id).toLowerCase() === slug)
  );

  const body = req.body || {};
  const title = body.title || (existingIdx >= 0 ? forms[existingIdx].title : 'Inbound Inquiry Form');
  const description = body.description !== undefined ? body.description : (existingIdx >= 0 ? forms[existingIdx].description : '');
  const fields = body.fields !== undefined ? body.fields : (existingIdx >= 0 ? forms[existingIdx].fields || forms[existingIdx].fieldIds : []);
  const submitRedirect = body.submitRedirect || body.redirectUrl || (existingIdx >= 0 ? forms[existingIdx].submitRedirect || forms[existingIdx].redirectUrl : '');
  const notifyEmails = Array.isArray(body.notifyEmails) ? body.notifyEmails : (existingIdx >= 0 ? forms[existingIdx].notifyEmails || [] : []);
  const status = body.status ? (String(body.status).toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE') : (body.isActive === false ? 'INACTIVE' : 'ACTIVE');
  const isActive = status === 'ACTIVE';
  const assignedAgentId = body.assignedAgentId || (existingIdx >= 0 ? forms[existingIdx].assignedAgentId : 'round_robin');
  const targetStage = body.targetStage || (existingIdx >= 0 ? forms[existingIdx].targetStage : 'NEW');
  const tags = body.tags || (existingIdx >= 0 ? forms[existingIdx].tags : ['Inbound Web Lead']);
  const successMessage = body.successMessage || (existingIdx >= 0 ? forms[existingIdx].successMessage : 'Thank you! A sales specialist has been assigned and will connect with you shortly.');

  const formObject = {
    id: existingIdx >= 0 ? forms[existingIdx].id : `form_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    slug,
    title,
    description,
    fields,
    submitRedirect,
    redirectUrl: submitRedirect,
    notifyEmails,
    status,
    isActive,
    assignedAgentId,
    targetStage,
    tags,
    successMessage,
    createdAt: existingIdx >= 0 ? forms[existingIdx].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    forms[existingIdx] = formObject;
  } else {
    forms.push(formObject);
  }

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        forms,
      },
    },
  });

  res.status(existingIdx >= 0 ? 200 : 201).json({
    ok: true,
    success: true,
    message: existingIdx >= 0 ? 'Form updated successfully' : 'Form created successfully',
    data: formObject,
    form: formObject,
    error: null,
  });
};

// PUT & POST & PATCH /forms/:slug (upsert form configuration)
formsRouter.put('/:slug', requireFormAdmin, upsertFormHandler);
formsRouter.post('/:slug', requireFormAdmin, upsertFormHandler);
formsRouter.patch('/:slug', requireFormAdmin, upsertFormHandler);

// POST /forms (create form with auto-generated or body slug)
formsRouter.post('/', requireFormAdmin, async (req: Request, res: Response) => {
  const body = req.body || {};
  if (!body.slug && !body.title) {
    res.status(400).json({ ok: false, success: false, error: 'TitleOrSlugRequired', message: 'Title or slug is required' });
    return;
  }
  const slug = body.slug || String(body.title).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  req.params.slug = slug;
  return upsertFormHandler(req, res);
});

// DELETE /forms/:slug (delete form)
formsRouter.delete('/:slug', requireFormAdmin, async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const target = String(req.params.slug || '').trim().toLowerCase();

  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as Record<string, any>) || {};
  const forms: any[] = Array.isArray(settings.forms) ? settings.forms : [];
  const filtered = forms.filter(
    (f: any) =>
      String(f.slug || '').toLowerCase() !== target &&
      String(f.id || '').toLowerCase() !== target
  );

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        forms: filtered,
      },
    },
  });

  res.json({ ok: true, success: true, message: 'Form deleted successfully', error: null });
});

// GET /forms/:slug/submissions (get leads submitted through this form)
formsRouter.get('/:slug/submissions', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const target = String(req.params.slug || '').trim().toLowerCase();

  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (ws?.settings as Record<string, any>) || {};
  const forms: any[] = Array.isArray(settings.forms) ? settings.forms : [];
  const form = forms.find(
    (f: any) =>
      String(f.slug || '').toLowerCase() === target ||
      String(f.id || '').toLowerCase() === target
  );

  const leads = await prisma.salesLeadAssignment.findMany({
    where: {
      tenantId,
      OR: [
        { source: form?.source || 'inbound_web_form' },
        { tags: { has: 'Inbound Web Lead' } },
      ],
    },
    include: {
      assignedAgent: { select: { agentCode: true, user: { select: { displayName: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  res.json({ ok: true, success: true, data: leads, submissions: leads, error: null });
});
