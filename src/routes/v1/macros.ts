import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody } from '../../middlewares/validate.js';

export const macrosRouter = Router();

macrosRouter.use(authenticate, enforceTenantIsolation);

export interface QuickMacro {
  id: string;
  name: string;
  content: string;
  category?: string;
  createdAt?: string;
  updatedAt?: string;
}

const DEFAULT_MACROS: QuickMacro[] = [
  {
    id: 'macro-1',
    name: 'Callback',
    content: 'I have scheduled a callback for you. Our specialist will connect with you shortly!',
    category: 'Follow-up',
  },
  {
    id: 'macro-2',
    name: 'Pricing Sheet',
    content: 'Sharing our complete package comparison. Standard: ₹48k/mo, Pro CRM + Telephony: ₹96k/mo.',
    category: 'Sales',
  },
  {
    id: 'macro-3',
    name: 'UPI Payment QR',
    content: 'You can complete your onboarding advance payment securely via UPI: upi://pay?pa=sales@aicloser&pn=AICloser',
    category: 'Payment',
  },
  {
    id: 'macro-4',
    name: 'Follow-up',
    content: 'Just checking in regarding our discussion earlier. Would 4:00 PM today work for a brief follow-up call?',
    category: 'Follow-up',
  },
];

// GET /api/v1/macros - Fetch all quick macros for workspace
macrosRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const macros: QuickMacro[] = Array.isArray(settings.macros) && settings.macros.length > 0
    ? settings.macros
    : DEFAULT_MACROS;

  res.json({
    success: true,
    data: macros,
    macros,
    error: null,
  });
});

const createMacroSchema = z.object({
  name: z.string().min(1, 'Macro name is required'),
  content: z.string().min(1, 'Macro content is required'),
  category: z.string().optional(),
});

// POST /api/v1/macros - Create a new quick macro
macrosRouter.post('/', validateBody(createMacroSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body as z.infer<typeof createMacroSchema>;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const currentMacros: QuickMacro[] = Array.isArray(settings.macros)
    ? [...settings.macros]
    : [...DEFAULT_MACROS];

  const now = new Date().toISOString();
  const newMacro: QuickMacro = {
    id: `macro-${Date.now()}-${randomUUID().slice(0, 4)}`,
    name: body.name.trim(),
    content: body.content.trim(),
    category: body.category || 'General',
    createdAt: now,
    updatedAt: now,
  };

  currentMacros.push(newMacro);

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        macros: currentMacros,
      } as any,
      updatedAt: new Date(),
    },
  });

  res.status(201).json({
    success: true,
    data: newMacro,
    message: 'Quick macro created successfully',
    error: null,
  });
});

const updateMacroSchema = z.object({
  name: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  category: z.string().optional(),
});

// PATCH /api/v1/macros/:id - Update an existing quick macro
macrosRouter.patch('/:id', validateBody(updateMacroSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof updateMacroSchema>;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const currentMacros: QuickMacro[] = Array.isArray(settings.macros)
    ? [...settings.macros]
    : [...DEFAULT_MACROS];

  const idx = currentMacros.findIndex((m) => m.id === id);
  if (idx === -1) {
    res.status(404).json({
      success: false,
      error: 'NotFound',
      message: `Quick macro with ID '${id}' not found`,
    });
    return;
  }

  const updatedMacro: QuickMacro = {
    ...currentMacros[idx],
    ...(body.name ? { name: body.name.trim() } : {}),
    ...(body.content ? { content: body.content.trim() } : {}),
    ...(body.category ? { category: body.category.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };

  currentMacros[idx] = updatedMacro;

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        macros: currentMacros,
      } as any,
      updatedAt: new Date(),
    },
  });

  res.json({
    success: true,
    data: updatedMacro,
    message: 'Quick macro updated successfully',
    error: null,
  });
});

// PUT /api/v1/macros/:id - Alias for PATCH
macrosRouter.put('/:id', validateBody(updateMacroSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof updateMacroSchema>;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const currentMacros: QuickMacro[] = Array.isArray(settings.macros)
    ? [...settings.macros]
    : [...DEFAULT_MACROS];

  const idx = currentMacros.findIndex((m) => m.id === id);
  if (idx === -1) {
    res.status(404).json({
      success: false,
      error: 'NotFound',
      message: `Quick macro with ID '${id}' not found`,
    });
    return;
  }

  const updatedMacro: QuickMacro = {
    ...currentMacros[idx],
    ...(body.name ? { name: body.name.trim() } : {}),
    ...(body.content ? { content: body.content.trim() } : {}),
    ...(body.category ? { category: body.category.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };

  currentMacros[idx] = updatedMacro;

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        macros: currentMacros,
      } as any,
      updatedAt: new Date(),
    },
  });

  res.json({
    success: true,
    data: updatedMacro,
    message: 'Quick macro updated successfully',
    error: null,
  });
});

// DELETE /api/v1/macros/:id - Delete a quick macro
macrosRouter.delete('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const currentMacros: QuickMacro[] = Array.isArray(settings.macros)
    ? [...settings.macros]
    : [...DEFAULT_MACROS];

  const exists = currentMacros.some((m) => m.id === id);
  if (!exists) {
    res.status(404).json({
      success: false,
      error: 'NotFound',
      message: `Quick macro with ID '${id}' not found`,
    });
    return;
  }

  const filteredMacros = currentMacros.filter((m) => m.id !== id);

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        macros: filteredMacros,
      } as any,
      updatedAt: new Date(),
    },
  });

  res.json({
    success: true,
    message: 'Quick macro deleted successfully',
    deletedId: id,
    error: null,
  });
});
