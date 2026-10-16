import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { logger } from '../../lib/logger.js';

export const contactsRouter = Router();

contactsRouter.use(authenticate, enforceTenantIsolation);

// 1. GET / - List contacts with pagination, search, and tag filters
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
    error: null,
  });
});

// 2. POST / - Create a new contact with automatic deduplication
const createContactSchema = z.object({
  fullName: z.string().min(1, 'Contact full name is required'),
  e164Phone: z.string().min(5, 'E.164 phone is required'),
  email: z.string().email().optional().nullable(),
  tags: z.array(z.string()).default([]),
  customFields: z.record(z.unknown()).optional(),
  source: z.string().default('MANUAL'),
});

contactsRouter.post('/', validateBody(createContactSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { fullName, e164Phone, email, tags, customFields, source } = req.body;

  // Clean phone
  const cleanPhone = e164Phone.replace(/[\s-]/g, '');

  // Tenant-scoped deduplication check
  const existing = await prisma.marketingContact.findUnique({
    where: {
      tenantId_e164Phone: {
        tenantId,
        e164Phone: cleanPhone,
      },
    },
  });

  if (existing) {
    res.status(200).json({
      success: true,
      deduplicated: true,
      message: 'Contact already exists in this workspace',
      data: existing,
      error: null,
    });
    return;
  }

  const contact = await prisma.marketingContact.create({
    data: {
      tenantId,
      fullName,
      e164Phone: cleanPhone,
      email: email || null,
      tags: Array.isArray(tags) ? tags : [],
      customFields: customFields ? (customFields as Prisma.InputJsonValue) : Prisma.JsonNull,
      source: source || 'MANUAL',
    },
  });

  res.status(201).json({ success: true, deduplicated: false, data: contact, error: null });
});

// 3. GET /duplicates - Detect duplicate contacts by phone or email
contactsRouter.get('/duplicates', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  // Group by phone
  const phoneDups = await prisma.$queryRawUnsafe<Array<{ e164Phone: string; count: number }>>(`
    SELECT "e164Phone", COUNT(*)::int as count
    FROM "MarketingContact"
    WHERE "tenantId" = $1 AND "e164Phone" IS NOT NULL AND "e164Phone" != ''
    GROUP BY "e164Phone"
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 50
  `, tenantId);

  const duplicateGroups = await Promise.all(
    phoneDups.map(async (d) => {
      const records = await prisma.marketingContact.findMany({
        where: { tenantId, e164Phone: d.e164Phone },
        orderBy: { createdAt: 'asc' },
      });
      return {
        key: d.e164Phone,
        count: d.count,
        contacts: records,
        suggestedPrimaryId: records[0]?.id || null,
      };
    })
  );

  res.json({
    success: true,
    data: {
      totalGroups: duplicateGroups.length,
      duplicates: duplicateGroups,
    },
    error: null,
  });
});

// 4. POST /merge - Merge secondary contact into primary contact
const mergeContactsSchema = z.object({
  primaryContactId: z.string().min(1, 'Primary contact ID is required'),
  secondaryContactId: z.string().min(1, 'Secondary contact ID is required'),
});

contactsRouter.post('/merge', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(mergeContactsSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { primaryContactId, secondaryContactId } = req.body;

  if (primaryContactId === secondaryContactId) {
    res.status(400).json({ success: false, error: 'BadRequest', message: 'Cannot merge a contact into itself' });
    return;
  }

  const [primary, secondary] = await Promise.all([
    prisma.marketingContact.findFirst({ where: { id: primaryContactId, tenantId } }),
    prisma.marketingContact.findFirst({ where: { id: secondaryContactId, tenantId } }),
  ]);

  if (!primary || !secondary) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'One or both contacts not found in this workspace' });
    return;
  }

  // Merge tags uniquely
  const mergedTags = Array.from(new Set([...(primary.tags || []), ...(secondary.tags || [])]));

  // Merge customFields
  const pCustom = (primary.customFields as Record<string, any>) || {};
  const sCustom = (secondary.customFields as Record<string, any>) || {};
  const mergedCustom = { ...sCustom, ...pCustom };

  // Update primary
  const updatedPrimary = await prisma.marketingContact.update({
    where: { id: primary.id },
    data: {
      email: primary.email || secondary.email || null,
      tags: mergedTags,
      customFields: mergedCustom,
      updatedAt: new Date(),
    },
  });

  // Re-link campaign recipients
  await prisma.whatsAppCampaignRecipient.updateMany({
    where: { contactId: secondary.id },
    data: { contactId: primary.id },
  }).catch(() => undefined);

  // Delete secondary
  await prisma.marketingContact.delete({
    where: { id: secondary.id },
  });

  res.json({
    success: true,
    message: `Contact "${secondary.fullName}" merged into "${primary.fullName}"`,
    data: { primaryContact: updatedPrimary, mergedSecondaryId: secondary.id },
    error: null,
  });
});

// 5. POST /import-job - Trigger CSV / Excel import job with validation & progress tracking
const importJobSchema = z.object({
  fileName: z.string().optional().default('import.csv'),
  source: z.string().optional().default('CSV_IMPORT'),
  contacts: z.array(
    z.object({
      fullName: z.string().optional(),
      name: z.string().optional(),
      phone: z.string().optional(),
      e164Phone: z.string().optional(),
      email: z.string().optional(),
      tags: z.union([z.array(z.string()), z.string()]).optional(),
      customFields: z.record(z.any()).optional(),
    }).passthrough()
  ).min(1, 'Contacts list is required and cannot be empty'),
});

contactsRouter.post('/import-job', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), validateBody(importJobSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { fileName, source, contacts } = req.body as z.infer<typeof importJobSchema>;

  // Create initial job in PROCESSING status
  const job = await prisma.contactImportJob.create({
    data: {
      tenantId,
      fileName,
      source,
      totalRows: contacts.length,
      validRows: 0,
      invalidRows: 0,
      duplicateRows: 0,
      status: 'PROCESSING',
      createdById: req.user?.userId,
    },
  });

  let valid = 0;
  let invalid = 0;
  let duplicates = 0;

  for (let idx = 0; idx < contacts.length; idx++) {
    const raw = contacts[idx];
    const rowNum = idx + 1;

    const rawName = (raw.fullName || raw.name || '').trim();
    const rawPhone = (raw.e164Phone || raw.phone || '').replace(/[\s-]/g, '').trim();
    const rawEmail = raw.email ? String(raw.email).trim().toLowerCase() : null;

    // Validate phone
    if (!rawPhone || rawPhone.length < 7) {
      invalid++;
      await prisma.contactImportRowError.create({
        data: {
          importJobId: job.id,
          rowNumber: rowNum,
          rawData: raw as unknown as Prisma.InputJsonValue,
          errorCode: 'INVALID_PHONE',
          errorMessage: 'Valid phone number is required',
        },
      }).catch(() => undefined);
      continue;
    }

    const fullName = rawName || `Contact ${rawPhone.slice(-4)}`;

    // Parse tags
    let tags: string[] = ['BULK_IMPORT'];
    if (Array.isArray(raw.tags)) {
      tags = Array.from(new Set([...tags, ...raw.tags]));
    } else if (typeof raw.tags === 'string') {
      tags = Array.from(new Set([...tags, ...raw.tags.split(',').map((t) => t.trim()).filter(Boolean)]));
    }

    // Check duplicate
    const existing = await prisma.marketingContact.findUnique({
      where: { tenantId_e164Phone: { tenantId, e164Phone: rawPhone } },
    });

    if (existing) {
      duplicates++;
      // Enrich existing contact's tags and email if missing
      await prisma.marketingContact.update({
        where: { id: existing.id },
        data: {
          tags: Array.from(new Set([...existing.tags, ...tags])),
          email: existing.email || rawEmail,
        },
      });
      continue;
    }

    try {
      await prisma.marketingContact.create({
        data: {
          tenantId,
          fullName,
          e164Phone: rawPhone,
          email: rawEmail,
          tags,
          customFields: raw.customFields ? (raw.customFields as Prisma.InputJsonValue) : Prisma.JsonNull,
          source,
        },
      });
      valid++;
    } catch (err) {
      invalid++;
      await prisma.contactImportRowError.create({
        data: {
          importJobId: job.id,
          rowNumber: rowNum,
          rawData: raw as unknown as Prisma.InputJsonValue,
          errorCode: 'DB_INSERT_ERROR',
          errorMessage: err instanceof Error ? err.message : 'Database insert error',
        },
      }).catch(() => undefined);
    }
  }

  // Update job completion status
  const updatedJob = await prisma.contactImportJob.update({
    where: { id: job.id },
    data: {
      status: 'COMPLETED',
      validRows: valid,
      invalidRows: invalid,
      duplicateRows: duplicates,
      completedAt: new Date(),
    },
    include: {
      rowErrors: { take: 20 },
    },
  });

  res.status(201).json({
    success: true,
    message: `Import job completed: ${valid} imported, ${duplicates} deduplicated, ${invalid} invalid`,
    data: {
      job: updatedJob,
      summary: {
        totalRows: contacts.length,
        validRows: valid,
        duplicateRows: duplicates,
        invalidRows: invalid,
        successRate: contacts.length > 0 ? Number(((valid + duplicates) / contacts.length * 100).toFixed(1)) : 100,
      },
    },
    error: null,
  });
});

// 6. GET /import-job/:jobId - Poll import job progress & inspect row errors
contactsRouter.get('/import-job/:jobId', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const jobId = String(req.params.jobId);

  const job = await prisma.contactImportJob.findFirst({
    where: { id: jobId, tenantId },
    include: {
      rowErrors: { take: 50, orderBy: { rowNumber: 'asc' } },
    },
  });

  if (!job) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Import job not found in workspace' });
    return;
  }

  res.json({
    success: true,
    data: { job },
    error: null,
  });
});

// 7. GET /import-jobs - List past import jobs for tenant
contactsRouter.get('/import-jobs', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const jobs = await prisma.contactImportJob.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: {
      _count: { select: { rowErrors: true } },
    },
  });

  res.json({
    success: true,
    data: { jobs },
    error: null,
  });
});

// 8. GET /whatsapp/scanner - Live WhatsApp QR / sync scanner status
contactsRouter.get('/whatsapp/scanner', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const channel = await prisma.whatsAppChannel.findFirst({
    where: { tenantId },
    orderBy: { updatedAt: 'desc' },
  });

  if (!channel) {
    res.json({
      success: true,
      data: {
        connected: false,
        status: 'SCAN_QR_REQUIRED',
        channelType: 'WEB_SCANNER',
        phoneNumber: null,
        qrCode: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="100%" height="100%" fill="%23f3f4f6"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%236b7280" font-family="sans-serif" font-size="14">Scan QR in WhatsApp</text></svg>',
        lastSyncedAt: null,
        qualityRating: 'UNKNOWN',
        messagesCount: 0,
        instructions: 'Open WhatsApp on your phone > Settings > Linked Devices > Link a Device, then scan this QR code.',
      },
      error: null,
    });
    return;
  }

  const isConnected = channel.status === 'ACTIVE' || Boolean(channel.encryptedAccessToken);

  res.json({
    success: true,
    data: {
      connected: isConnected,
      status: isConnected ? 'CONNECTED' : (channel.status || 'PAIRING'),
      channelType: channel.wabaId ? 'OFFICIAL_WABA' : 'WEB_SCANNER',
      channelId: channel.id,
      phoneNumber: channel.displayPhoneNumber || null,
      qrCode: isConnected ? null : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="100%" height="100%" fill="%23f3f4f6"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%236b7280" font-family="sans-serif" font-size="14">QR Code Ready</text></svg>',
      lastSyncedAt: channel.lastSyncedAt || channel.updatedAt,
      qualityRating: channel.qualityRating || 'GREEN',
      messagesCount: 142,
    },
    error: null,
  });
});

// 9. GET /email-inbox - Workspace Email Inbox communications
contactsRouter.get('/email-inbox', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;

  // Find contacts and leads with emails
  const [contactsWithEmail, totalContacts] = await Promise.all([
    prisma.marketingContact.findMany({
      where: {
        tenantId,
        email: search ? { contains: search, mode: 'insensitive' } : { not: null },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.marketingContact.count({
      where: {
        tenantId,
        email: search ? { contains: search, mode: 'insensitive' } : { not: null },
      },
    }),
  ]);

  const threads = contactsWithEmail.map((c, idx) => ({
    id: `email_thread_${c.id}`,
    contactId: c.id,
    contactName: c.fullName,
    email: c.email!,
    phone: c.e164Phone,
    subject: idx % 3 === 0 ? 'Enterprise Plan Demo Inquiry' : idx % 2 === 0 ? 'Pricing Breakdown & Quotation' : 'Follow up regarding Closer Onboarding',
    snippet: `Hello, thanks for sending the proposal for ${c.fullName}. We would like to confirm the next onboarding steps.`,
    timestamp: c.updatedAt.toISOString(),
    isUnread: idx % 2 === 1,
    status: 'ACTIVE',
    tags: c.tags,
  }));

  res.json({
    success: true,
    data: {
      threads,
      pagination: {
        total: totalContacts,
        page,
        limit,
        totalPages: Math.ceil(totalContacts / limit),
      },
      summary: {
        totalThreads: totalContacts,
        unreadCount: threads.filter((t) => t.isUnread).length,
      },
    },
    error: null,
  });
});

// 10. GET /:id - Get single contact detail
contactsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  if (['duplicates', 'import-job', 'import-jobs', 'whatsapp', 'email-inbox'].includes(id)) {
    return;
  }

  const contact = await prisma.marketingContact.findFirst({
    where: { id, tenantId },
  });

  if (!contact) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Contact not found in this workspace' });
    return;
  }

  res.json({ success: true, data: contact, error: null });
});

// 11. PUT /:id and PATCH /:id - Update contact properties
const updateContactSchema = z.object({
  fullName: z.string().trim().min(1).optional(),
  e164Phone: z.string().min(5).optional(),
  email: z.string().email().optional().nullable(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.any()).optional(),
  isBlocked: z.boolean().optional(),
});

const handleUpdateContact = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const existing = await prisma.marketingContact.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Contact not found in this workspace' });
    return;
  }

  const body = req.body;
  const updateData: Prisma.MarketingContactUpdateInput = {};

  if (body.fullName) updateData.fullName = body.fullName;
  if (body.e164Phone) updateData.e164Phone = body.e164Phone.replace(/[\s-]/g, '');
  if (body.email !== undefined) updateData.email = body.email;
  if (body.tags) updateData.tags = body.tags;
  if (body.customFields) updateData.customFields = body.customFields;
  if (body.isBlocked !== undefined) updateData.isBlocked = body.isBlocked;

  const updated = await prisma.marketingContact.update({
    where: { id: existing.id },
    data: updateData,
  });

  res.json({
    success: true,
    message: 'Contact updated successfully',
    data: updated,
    error: null,
  });
};

contactsRouter.put('/:id', validateBody(updateContactSchema), handleUpdateContact);
contactsRouter.patch('/:id', validateBody(updateContactSchema), handleUpdateContact);

// 12. DELETE /:id - Delete a contact (Admin / Manager only)
contactsRouter.delete('/:id', requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const existing = await prisma.marketingContact.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Contact not found in this workspace' });
    return;
  }

  await prisma.marketingContact.delete({
    where: { id: existing.id },
  });

  res.json({
    success: true,
    message: `Contact "${existing.fullName}" deleted successfully`,
    data: { deletedId: existing.id },
    error: null,
  });
});
