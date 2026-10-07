import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';

export const contactsRouter = Router();

contactsRouter.use(authenticate, enforceTenantIsolation);

const listContactsQuerySchema = z.object({
  page: z.string().optional().transform((v) => (v ? Math.max(1, Number(v)) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, Math.max(1, Number(v))) : 25)),
  search: z.string().optional(),
  tag: z.string().optional(),
});

contactsRouter.get('/', validateQuery(listContactsQuerySchema), async (req: Request, res: Response) => {
  const { page, limit, search, tag } = req.query as unknown as {
    page: number;
    limit: number;
    search?: string;
    tag?: string;
  };

  const tenantId = req.tenantId!;
  const where: Record<string, unknown> = { tenantId };

  if (tag) {
    where.tags = { has: tag };
  }

  if (search) {
    where.OR = [
      { fullName: { contains: search, mode: 'insensitive' } },
      { e164Phone: { contains: search } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, contacts] = await Promise.all([
    prisma.marketingContact.count({ where }),
    prisma.marketingContact.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  res.json({
    success: true,
    data: {
      contacts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
});

const createContactSchema = z.object({
  fullName: z.string().min(1, 'Contact full name is required'),
  e164Phone: z.string().min(5, 'E.164 phone is required'),
  email: z.string().email().optional(),
  tags: z.array(z.string()).default([]),
  customFields: z.record(z.unknown()).optional(),
  source: z.string().default('MANUAL'),
});

contactsRouter.post('/', validateBody(createContactSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { fullName, e164Phone, email, tags, customFields, source } = req.body;

  // Tenant-scoped deduplication check
  const existing = await prisma.marketingContact.findUnique({
    where: {
      tenantId_e164Phone: {
        tenantId,
        e164Phone,
      },
    },
  });

  if (existing) {
    // Return existing contact without creating duplicate
    res.status(200).json({
      success: true,
      deduplicated: true,
      message: 'Contact already exists in this workspace',
      data: existing,
    });
    return;
  }

  const contact = await prisma.marketingContact.create({
    data: {
      tenantId, // Root ownership strictly enforced
      fullName,
      e164Phone,
      email,
      tags,
      customFields: customFields ? (customFields as Prisma.InputJsonValue) : Prisma.JsonNull,
      source,
    },
  });

  res.status(201).json({ success: true, deduplicated: false, data: contact });
});

contactsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const contact = await prisma.marketingContact.findFirst({
    where: { id, tenantId },
  });

  if (!contact) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Contact not found in this workspace' });
    return;
  }

  res.json({ success: true, data: contact });
});
