import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody } from '../../middlewares/validate.js';

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

// List all custom field definitions for the current tenant
customFieldsRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const fields = await prisma.customFieldDefinition.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
  });

  res.json({
    success: true,
    data: { fields },
  });
});

// Create a new custom field definition
customFieldsRouter.post('/', validateBody(createFieldSchema), async (req: Request, res: Response) => {
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
      options,
      defaultValue,
      isRequired,
      showInKanban,
      showInTable,
    },
  });

  res.status(201).json({
    success: true,
    data: { field },
  });
});

// Update an existing custom field definition
customFieldsRouter.put('/:id', validateBody(updateFieldSchema), async (req: Request, res: Response) => {
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

  const updated = await prisma.customFieldDefinition.update({
    where: { id: existing.id },
    data: req.body,
  });

  res.json({
    success: true,
    data: { field: updated },
  });
});

// Delete a custom field definition
customFieldsRouter.delete('/:id', async (req: Request, res: Response) => {
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
  });
});