import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { validateBody } from '../../middlewares/validate.js';

export const labelsRouter = Router();

labelsRouter.use(authenticate, enforceTenantIsolation);

export interface WorkspaceLabel {
  name: string;
  color: string;
  usageCount: number;
  createdAt: string;
}

// GET /api/v1/labels - Returns distinct tags from leads + predefined workspace labels with usageCount
labelsRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  // 1. Fetch predefined labels from workspace settings
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const settings = (workspace?.settings as Record<string, any>) || {};
  const predefinedLabels: Array<{ name: string; color?: string; createdAt?: string }> = Array.isArray(settings.labels)
    ? settings.labels
    : [];

  // 2. Fetch tags from all SalesLeadAssignment records for this tenant
  const leadTags = await prisma.salesLeadAssignment.findMany({
    where: { tenantId },
    select: { tags: true },
  });

  // 3. Compute usage counts for all tags
  const tagCountMap = new Map<string, number>();
  const leadTagSet = new Set<string>();

  for (const lead of leadTags) {
    if (Array.isArray(lead.tags)) {
      for (const tag of lead.tags) {
        const trimmed = String(tag).trim();
        if (trimmed) {
          leadTagSet.add(trimmed);
          const lower = trimmed.toLowerCase();
          tagCountMap.set(lower, (tagCountMap.get(lower) || 0) + 1);
        }
      }
    }
  }

  // Predefined label map
  const labelMap = new Map<string, WorkspaceLabel>();

  // Add workspace predefined labels
  for (const pl of predefinedLabels) {
    if (pl && pl.name) {
      const lower = pl.name.toLowerCase();
      labelMap.set(lower, {
        name: pl.name,
        color: pl.color || '#6366f1',
        usageCount: tagCountMap.get(lower) || 0,
        createdAt: pl.createdAt || new Date().toISOString(),
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
        usageCount: tagCountMap.get(lower) || 0,
        createdAt: new Date().toISOString(),
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
  const now = new Date().toISOString();
  const newLabel = {
    name: name.trim(),
    color: color || '#3b82f6',
    createdAt: now,
  };

  if (existingIdx !== -1) {
    labels[existingIdx] = newLabel;
  } else {
    labels.push(newLabel);
  }

  // Count existing usage if any
  const count = await prisma.salesLeadAssignment.count({
    where: { tenantId, tags: { has: name.trim() } },
  });

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        labels,
      } as any,
      updatedAt: new Date(),
    },
  });

  res.status(201).json({
    success: true,
    message: 'Label created successfully',
    data: {
      ...newLabel,
      usageCount: count,
    },
    error: null,
  });
});

const updateLabelSchema = z.object({
  newName: z.string().optional(),
  name: z.string().optional(),
  color: z.string().optional(),
}).refine((data) => Boolean(data.newName || data.name), {
  message: 'name or newName is required',
});

// PUT /api/v1/labels/:name - Update label name & color, and cascade updates to SalesLeadAssignment tags
labelsRouter.put('/:name', requireRoles('ADMIN', 'SUPER_ADMIN', 'MANAGER'), validateBody(updateLabelSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const oldName = decodeURIComponent(String(req.params.name)).trim();
  const rawBody = req.body as { newName?: string; name?: string; color?: string };
  const newName = String(rawBody.newName || rawBody.name || '').trim();
  const color = rawBody.color;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const labels: Array<{ name: string; color?: string; createdAt?: string }> = Array.isArray(settings.labels)
    ? [...settings.labels]
    : [];

  const targetIdx = labels.findIndex((l) => l.name.toLowerCase() === oldName.toLowerCase());
  const updatedColor = color || (targetIdx !== -1 ? labels[targetIdx].color : '#3b82f6') || '#3b82f6';
  const now = new Date().toISOString();

  if (targetIdx !== -1) {
    labels[targetIdx] = {
      ...labels[targetIdx],
      name: newName.trim(),
      color: updatedColor,
    };
  } else {
    labels.push({
      name: newName.trim(),
      color: updatedColor,
      createdAt: now,
    });
  }

  // If newName !== oldName, batch update all SalesLeadAssignment records where tags has oldName
  const leadsWithTag = await prisma.salesLeadAssignment.findMany({
    where: { tenantId, tags: { has: oldName } },
    select: { id: true, tags: true },
  });

  if (newName.toLowerCase() !== oldName.toLowerCase()) {
    for (const l of leadsWithTag) {
      const updatedTags = Array.from(new Set(l.tags.map((t) => (t.toLowerCase() === oldName.toLowerCase() ? newName.trim() : t))));
      await prisma.salesLeadAssignment.update({
        where: { id: l.id },
        data: { tags: updatedTags },
      });
    }
  }

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        labels,
      } as any,
      updatedAt: new Date(),
    },
  });

  res.json({
    success: true,
    message: 'Label updated successfully',
    data: {
      name: newName.trim(),
      color: updatedColor,
      usageCount: leadsWithTag.length,
    },
    error: null,
  });
});

// DELETE /api/v1/labels/:name - Delete label from settings and purge from all leads in the tenant
labelsRouter.delete('/:name', requireRoles('ADMIN', 'SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const targetName = decodeURIComponent(String(req.params.name)).trim();

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const labels: Array<{ name: string; color?: string; createdAt?: string }> = Array.isArray(settings.labels)
    ? settings.labels.filter((l) => l.name.toLowerCase() !== targetName.toLowerCase())
    : [];

  // Batch update all SalesLeadAssignment records in the tenant to remove the tag
  const leadsWithTag = await prisma.salesLeadAssignment.findMany({
    where: { tenantId, tags: { has: targetName } },
    select: { id: true, tags: true },
  });

  for (const l of leadsWithTag) {
    const updatedTags = l.tags.filter((t) => t.toLowerCase() !== targetName.toLowerCase());
    await prisma.salesLeadAssignment.update({
      where: { id: l.id },
      data: { tags: updatedTags },
    });
  }

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        labels,
      } as any,
      updatedAt: new Date(),
    },
  });

  res.json({
    success: true,
    message: 'Label deleted successfully',
    deletedName: targetName,
    affectedLeadsCount: leadsWithTag.length,
    error: null,
  });
});
