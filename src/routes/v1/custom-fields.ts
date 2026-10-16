import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { validateBody } from '../../middlewares/validate.js';
import { logger } from '../../lib/logger.js';

export const customFieldsRouter = Router();
customFieldsRouter.use(authenticate, enforceTenantIsolation);

const fieldTypeEnum = z.enum(['TEXT', 'NUMBER', 'DROPDOWN', 'DATE', 'BOOLEAN', 'text', 'number', 'dropdown', 'date', 'boolean']);

const createFieldSchema = z.object({
  fieldLabel: z.string().trim().min(1, 'Field label is required').max(100),
  fieldKey: z.string().trim().min(1, 'Field key is required').max(80).regex(/^[a-z0-9_]+$/, 'Field key must be lowercase alphanumeric with underscores'),
  fieldType: fieldTypeEnum.default('text'),
  options: z.array(z.string().trim().min(1)).default([]),
  defaultValue: z.string().optional(),
  isRequired: z.boolean().default(false),
  showInKanban: z.boolean().default(true),
  showInTable: z.boolean().default(true),
});

const updateFieldSchema = z.object({
  fieldLabel: z.string().trim().min(1).max(100).optional(),
  fieldType: fieldTypeEnum.optional(),
  options: z.array(z.string().trim().min(1)).optional(),
  defaultValue: z.string().optional(),
  isRequired: z.boolean().optional(),
  showInKanban: z.boolean().optional(),
  showInTable: z.boolean().optional(),
});

// Helper: Check if agent has access to a specific lead
async function checkLeadAccess(req: Request, leadId: string, tenantId: string): Promise<{ authorized: boolean; lead: any }> {
  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id: leadId, tenantId },
  });

  if (!lead) {
    return { authorized: false, lead: null };
  }

  if (req.user?.role !== 'SALES_AGENT') {
    return { authorized: true, lead };
  }

  // Check workspace chat/lead visibility policy
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const settings = (workspace?.settings as Record<string, unknown>) || {};
  if (settings.chatVisibility === 'COMPANY_WIDE') {
    return { authorized: true, lead };
  }

  const profile = await prisma.salesAgentProfile.findFirst({
    where: { userId: req.user.userId, tenantId },
    select: { id: true },
  });

  if (profile && lead.assignedAgentId === profile.id) {
    return { authorized: true, lead };
  }

  return { authorized: false, lead };
}

// 1. GET / - List all custom field definitions for the current tenant
customFieldsRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const fields = await prisma.customFieldDefinition.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
  });

  res.json({
    success: true,
    data: { fields },
    error: null,
  });
});

// 2. POST / - Create a new custom field definition (Admin / Manager only)
customFieldsRouter.post('/', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(createFieldSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { fieldLabel, fieldKey, fieldType, options, defaultValue, isRequired, showInKanban, showInTable } = req.body;

  const existing = await prisma.customFieldDefinition.findUnique({
    where: { tenantId_fieldKey: { tenantId, fieldKey } },
  });

  if (existing) {
    res.status(409).json({
      success: false,
      error: 'Conflict',
      message: `A custom field with key "${fieldKey}" already exists in this workspace`,
    });
    return;
  }

  const field = await prisma.customFieldDefinition.create({
    data: {
      tenantId,
      fieldLabel,
      fieldKey,
      fieldType: fieldType.toLowerCase(),
      options: Array.isArray(options) ? options : [],
      defaultValue,
      isRequired: Boolean(isRequired),
      showInKanban: showInKanban !== false,
      showInTable: showInTable !== false,
    },
  });

  res.status(201).json({
    success: true,
    data: { field },
    error: null,
  });
});

// 3. GET /:id - Get definition by ID
customFieldsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  // Skip if param is 'lead' - caught by /lead/:leadId
  if (id === 'lead') return;

  const field = await prisma.customFieldDefinition.findFirst({
    where: { id: Array.isArray(id) ? id[0] : id, tenantId },
  });

  if (!field) {
    res.status(404).json({
      success: false,
      error: 'NotFound',
      message: 'Custom field definition not found in this workspace',
    });
    return;
  }

  res.json({
    success: true,
    data: { field },
    error: null,
  });
});

// 4. PUT /:id and PATCH /:id - Update definition (Admin / Manager only)
const handleUpdateDefinition = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const existing = await prisma.customFieldDefinition.findFirst({
    where: { id: Array.isArray(id) ? id[0] : id, tenantId },
  });

  if (!existing) {
    res.status(404).json({
      success: false,
      error: 'NotFound',
      message: 'Custom field definition not found in this workspace',
    });
    return;
  }

  const dataToUpdate: any = { ...req.body };
  if (dataToUpdate.fieldType) {
    dataToUpdate.fieldType = dataToUpdate.fieldType.toLowerCase();
  }

  const updated = await prisma.customFieldDefinition.update({
    where: { id: existing.id },
    data: dataToUpdate,
  });

  res.json({
    success: true,
    data: { field: updated },
    error: null,
  });
};

customFieldsRouter.put('/:id', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(updateFieldSchema), handleUpdateDefinition);
customFieldsRouter.patch('/:id', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(updateFieldSchema), handleUpdateDefinition);

// 5. DELETE /:id - Delete a custom field definition (Admin / Manager only)
customFieldsRouter.delete('/:id', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { id } = req.params;

  const existing = await prisma.customFieldDefinition.findFirst({
    where: { id: Array.isArray(id) ? id[0] : id, tenantId },
  });

  if (!existing) {
    res.status(404).json({
      success: false,
      error: 'NotFound',
      message: 'Custom field definition not found in this workspace',
    });
    return;
  }

  await prisma.customFieldDefinition.delete({
    where: { id: existing.id },
  });

  res.json({
    success: true,
    data: { deleted: true, id: existing.id },
    error: null,
  });
});

// 6. GET /lead/:leadId - Read custom field values for a specific lead
customFieldsRouter.get('/lead/:leadId', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const leadId = String(req.params.leadId);

  const { authorized, lead } = await checkLeadAccess(req, leadId, tenantId);

  if (!lead) {
    res.status(404).json({
      success: false,
      error: 'NotFound',
      message: 'Lead not found in this workspace',
    });
    return;
  }

  if (!authorized) {
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'You do not have permission to view custom fields for this lead',
    });
    return;
  }

  // Fetch definitions for the tenant
  const definitions = await prisma.customFieldDefinition.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
  });

  const rawValues = (lead.customFields as Record<string, any>) || {};

  // Enrich definitions with actual values from lead
  const fields = definitions.map((def) => {
    const val = rawValues[def.fieldKey] !== undefined ? rawValues[def.fieldKey] : (def.defaultValue || null);
    return {
      definitionId: def.id,
      fieldKey: def.fieldKey,
      fieldLabel: def.fieldLabel,
      fieldType: def.fieldType,
      options: def.options,
      isRequired: def.isRequired,
      showInKanban: def.showInKanban,
      showInTable: def.showInTable,
      value: val,
    };
  });

  res.json({
    success: true,
    data: {
      leadId,
      customerName: lead.customerName,
      customerPhone: lead.customerPhone,
      values: rawValues,
      fields,
    },
    error: null,
  });
});

// 7. PUT/PATCH /lead/:leadId - Update lead custom-field values with validation
const updateLeadValuesSchema = z.object({
  values: z.record(z.any()).optional(),
}).passthrough();

const handleUpdateLeadValues = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const leadId = String(req.params.leadId);

  const { authorized, lead } = await checkLeadAccess(req, leadId, tenantId);

  if (!lead) {
    res.status(404).json({
      success: false,
      error: 'NotFound',
      message: 'Lead not found in this workspace',
    });
    return;
  }

  if (!authorized) {
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'You do not have permission to modify custom fields for this lead',
    });
    return;
  }

  // Accept either { values: { key: val } } or flat { key: val }
  const incomingValues: Record<string, any> = req.body.values && typeof req.body.values === 'object'
    ? req.body.values
    : { ...req.body };
  delete incomingValues.values;

  // Fetch definitions to validate
  const definitions = await prisma.customFieldDefinition.findMany({
    where: { tenantId },
  });
  const defMap = new Map(definitions.map((d) => [d.fieldKey, d]));

  const validationErrors: string[] = [];
  const currentValues = (lead.customFields as Record<string, any>) || {};
  const mergedValues: Record<string, any> = { ...currentValues };

  for (const [key, val] of Object.entries(incomingValues)) {
    const def = defMap.get(key);
    if (!def) {
      // Store custom unindexed fields directly
      mergedValues[key] = val;
      continue;
    }

    // Check required
    if (def.isRequired && (val === null || val === undefined || val === '')) {
      validationErrors.push(`Field "${def.fieldLabel}" (${key}) is required`);
      continue;
    }

    if (val === null || val === undefined || val === '') {
      mergedValues[key] = null;
      continue;
    }

    // Type checking
    const normType = def.fieldType.toLowerCase();
    if (normType === 'number') {
      const num = Number(val);
      if (isNaN(num)) {
        validationErrors.push(`Field "${def.fieldLabel}" (${key}) must be a valid number`);
      } else {
        mergedValues[key] = num;
      }
    } else if (normType === 'dropdown') {
      if (def.options.length > 0 && !def.options.includes(String(val))) {
        validationErrors.push(`Field "${def.fieldLabel}" (${key}) must be one of: ${def.options.join(', ')}`);
      } else {
        mergedValues[key] = String(val);
      }
    } else if (normType === 'boolean') {
      if (typeof val === 'boolean') {
        mergedValues[key] = val;
      } else if (val === 'true' || val === 1 || val === '1') {
        mergedValues[key] = true;
      } else if (val === 'false' || val === 0 || val === '0') {
        mergedValues[key] = false;
      } else {
        validationErrors.push(`Field "${def.fieldLabel}" (${key}) must be a boolean`);
      }
    } else if (normType === 'date') {
      const d = new Date(val);
      if (isNaN(d.getTime())) {
        validationErrors.push(`Field "${def.fieldLabel}" (${key}) must be a valid ISO date string`);
      } else {
        mergedValues[key] = d.toISOString();
      }
    } else {
      mergedValues[key] = String(val);
    }
  }

  if (validationErrors.length > 0) {
    res.status(400).json({
      success: false,
      error: 'ValidationError',
      message: validationErrors.join('; '),
      errors: validationErrors,
    });
    return;
  }

  // Update lead
  const updatedLead = await prisma.salesLeadAssignment.update({
    where: { id: lead.id },
    data: {
      customFields: mergedValues,
      updatedAt: new Date(),
    },
  });

  // Log activity
  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: lead.id,
      actorUserId: req.user?.userId,
      action: 'CUSTOM_FIELDS_UPDATED',
      note: `Updated custom fields for ${lead.customerName || lead.id}`,
      metadata: { updatedKeys: Object.keys(incomingValues) },
    },
  }).catch(() => undefined);

  res.json({
    success: true,
    message: 'Lead custom field values updated successfully',
    data: {
      leadId: lead.id,
      customFields: updatedLead.customFields,
    },
    error: null,
  });
};

customFieldsRouter.put('/lead/:leadId', validateBody(updateLeadValuesSchema), handleUpdateLeadValues);
customFieldsRouter.patch('/lead/:leadId', validateBody(updateLeadValuesSchema), handleUpdateLeadValues);
