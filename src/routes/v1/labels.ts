import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { validateBody } from '../../middlewares/validate.js';

export const labelsRouter = Router();

labelsRouter.use(authenticate, enforceTenantIsolation);

// GET /api/v1/labels - Returns distinct tags from leads + predefined workspace labels
labelsRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  // 1. Fetch predefined labels from workspace settings
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const settings = (workspace?.settings as Record<string, any>) || {};
  const predefinedLabels: Array<{ name: string; color?: string; id?: string }> = Array.isArray(settings.labels)
    ? settings.labels
    : [];

  // 2. Fetch distinct tags from SalesLeadAssignment for this tenant
  const leadTags = await prisma.salesLeadAssignment.findMany({
    where: { tenantId },
    select: { tags: true },
  });

  const leadTagSet = new Set<string>();
  for (const lead of leadTags) {
    if (Array.isArray(lead.tags)) {
      for (const tag of lead.tags) {
        const trimmed = String(tag).trim();
        if (trimmed) leadTagSet.add(trimmed);
      }
    }
  }

  // Predefined label map
  const labelMap = new Map<string, { name: string; color?: string }>();

  // Add workspace predefined labels
  for (const pl of predefinedLabels) {
    if (pl && pl.name) {
      labelMap.set(pl.name.toLowerCase(), {
        name: pl.name,
        color: pl.color || '#6366f1',
      });
    }
  }

  // Add lead tags not in predefined
  const defaultPalette = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];
  let colorIdx = 0;
  for (const tag of leadTagSet) {
    const lower = tag.toLowerCase();
    if (!labelMap.has(lower)) {
      labelMap.set(lower, {
        name: tag,
        color: defaultPalette[colorIdx % defaultPalette.length],
      });
      colorIdx++;
    }
  }

  const result = Array.from(labelMap.values());

  res.json({
    success: true,
    data: result,
    tags: Array.from(leadTagSet),
    labels: result,
    error: null,
  });
});

const createLabelSchema = z.object({
  name: z.string().min(1, 'Label name is required'),
  color: z.string().optional().default('#3b82f6'),
});

// POST /api/v1/labels - Admin/Manager can create a new workspace label saved into workspace.settings.labels
labelsRouter.post('/', requireRoles('ADMIN', 'SUPER_ADMIN', 'MANAGER'), validateBody(createLabelSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { name, color } = req.body as z.infer<typeof createLabelSchema>;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const labels: Array<{ name: string; color?: string; createdAt?: string }> = Array.isArray(settings.labels)
    ? [...settings.labels]
    : [];

  const existingIdx = labels.findIndex((l) => l.name.toLowerCase() === name.trim().toLowerCase());
  const newLabel = {
    name: name.trim(),
    color: color || '#3b82f6',
    createdAt: new Date().toISOString(),
  };

  if (existingIdx !== -1) {
    labels[existingIdx] = newLabel;
  } else {
    labels.push(newLabel);
  }

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        labels,
      },
    },
  });

  res.json({
    success: true,
    message: 'Label created successfully',
    data: newLabel,
    error: null,
  });
});
