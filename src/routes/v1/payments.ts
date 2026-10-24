import { persistApiRealtimeEvent } from '../../lib/realtime.js';
import { maskPhoneNumber } from '../../lib/phone-mask.js';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { UpiPaymentDurationUnit, UpiPaymentLinkStatus } from '@prisma/client';
import { getWorkspaceScope, type WorkspaceScope } from '../../lib/workspace-scope.js';

export const paymentsRouter = Router();

const upload = multer({
  limits: { fileSize: 15 * 1024 * 1024 },
  storage: multer.memoryStorage(),
});

const PROOF_BASE_DIR = path.resolve(process.cwd(), 'data', 'uploads', 'upi-payment-proofs');

function resolveProofFilePath(relativePath: string): string | null {
  const candidates = [
    path.resolve(PROOF_BASE_DIR, relativePath),
    path.resolve(process.cwd(), 'data', 'uploads', relativePath),
    path.resolve(process.cwd(), relativePath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ==========================================
// 1. PUBLIC ENDPOINTS (No Authentication Required)
// ==========================================

// GET /public/:tokenOrId - Public endpoint for customer payment view (/pay/[token])
paymentsRouter.get('/public/:tokenOrId', async (req: Request, res: Response) => {
  const tokenOrId = String(req.params.tokenOrId).trim();

  const payment = await prisma.upiPaymentLink.findUnique({
    where: { publicToken: tokenOrId },
    include: {
      createdBy: {
        select: { displayName: true, email: true },
      },
    },
  });

  if (!payment) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Payment request not found or expired' });
    return;
  }

  const custom = (payment.customFields as any) || {};
  const createdAtDate = new Date(payment.createdAt);
  const expiryMinutes = Number(custom.expiryMinutes || 30);
  const expiresAtDate = custom.expiresAt
    ? new Date(custom.expiresAt)
    : new Date(createdAtDate.getTime() + expiryMinutes * 60 * 1000);
  const now = new Date();
  const isExpired = payment.status === 'EXPIRED' || (payment.status === 'PENDING' && now > expiresAtDate);
  const remainingSeconds = Math.max(0, Math.floor((expiresAtDate.getTime() - now.getTime()) / 1000));

  if (payment.status === 'PENDING' && isExpired) {
    await prisma.upiPaymentLink.update({
      where: { id: payment.id },
      data: { status: UpiPaymentLinkStatus.EXPIRED },
    }).catch(() => {});
    payment.status = UpiPaymentLinkStatus.EXPIRED;
  }

  const settings = await prisma.upiPaymentSetting.findUnique({
    where: { tenantId: payment.tenantId },
  });

  const upiId = payment.upiIdSnapshot || settings?.upiId || 'aicloser@upi';
  const payeeName = payment.payeeNameSnapshot || settings?.payeeName || 'AI Closer CRM';
  const amount = Number(payment.totalAmount);
  const note = payment.productName || 'Payment';
  const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`;

  const paymentMeta = {
    id: payment.id,
    publicToken: payment.publicToken,
    status: payment.status,
    amount,
    totalAmount: amount,
    currency: payment.currency || 'INR',
    customerName: payment.customerName,
    customerPhone: payment.customerPhone ? maskPhoneNumber(payment.customerPhone, true) : '',
    customerEmail: payment.customerEmail ? `${payment.customerEmail.slice(0, 3)}***@***` : '',
    productName: payment.productName,
    description: payment.productName,
    customerNote: payment.customerNote,
    upiId,
    payeeName,
    upiUri,
    payUrl: `https://app.aicloser.in/pay/${payment.publicToken}`,
    paymentUrl: `https://app.aicloser.in/pay/${payment.publicToken}`,
    hasProof: Boolean(payment.proofStoragePath),
    utrReference: payment.utrReference,
    paidAt: payment.paidAt,
    createdAt: payment.createdAt,
    creatorName: payment.createdBy?.displayName || 'Sales Specialist',
    expiresAt: expiresAtDate.toISOString(),
    isExpired,
    remainingSeconds,
    expiryMinutes,
    leadId: custom.leadId || null,
  };

  res.json({
    success: true,
    payment: paymentMeta,
    data: paymentMeta,
  });
});

// POST /public/:tokenOrId/confirm - Public endpoint for customer payment confirmation (no auth required)
paymentsRouter.post('/public/:tokenOrId/confirm', upload.any(), async (req: Request, res: Response) => {
  try {
    const tokenOrId = String(req.params.tokenOrId).trim();
    const payment = await prisma.upiPaymentLink.findUnique({
      where: { publicToken: tokenOrId },
    });

    if (!payment) {
      res.status(404).json({ success: false, error: 'NotFound', message: 'Payment request not found or expired' });
      return;
    }

    const custom = (payment.customFields as any) || {};
    const createdAtDate = new Date(payment.createdAt);
    const expiryMinutes = Number(custom.expiryMinutes || 30);
    const expiresAtDate = custom.expiresAt
      ? new Date(custom.expiresAt)
      : new Date(createdAtDate.getTime() + expiryMinutes * 60 * 1000);
    const now = new Date();
    const isExpired = payment.status === 'EXPIRED' || (payment.status === 'PENDING' && now > expiresAtDate);

    if (isExpired) {
      if (payment.status === 'PENDING') {
        await prisma.upiPaymentLink.update({
          where: { id: payment.id },
          data: { status: UpiPaymentLinkStatus.EXPIRED },
        }).catch(() => {});
      }
      res.status(410).json({
        success: false,
        error: 'PaymentLinkExpired',
        message: 'This dynamic UPI payment link has expired. Please contact your sales specialist to request a fresh payment link.',
      });
      return;
    }

    if (!['PENDING', 'CUSTOMER_CONFIRMED'].includes(payment.status)) {
      res.status(400).json({ success: false, error: 'InvalidStatus', message: 'This payment link has already been settled or cancelled' });
      return;
    }

    const file = (req.files && Array.isArray(req.files) ? req.files[0] : req.file);
    const { utrReference, utrNumber, note, confirmationNote, base64Data, mimeType: bodyMimeType } = req.body as {
      utrReference?: string;
      utrNumber?: string;
      note?: string;
      confirmationNote?: string;
      base64Data?: string;
      mimeType?: string;
    };

    let fileBuffer: Buffer | null = null;
    let mimeType = 'image/jpeg';
    let sizeBytes = 0;
    let ext = 'jpg';

    if (file) {
      fileBuffer = file.buffer;
      mimeType = file.mimetype || 'image/jpeg';
      sizeBytes = file.size;
      if (mimeType.includes('png')) ext = 'png';
      else if (mimeType.includes('webp')) ext = 'webp';
      else if (mimeType.includes('pdf')) ext = 'pdf';
      else ext = 'jpg';
    } else if (base64Data) {
      const cleanBase64 = base64Data.replace(/^data:.*?;base64,/, '');
      fileBuffer = Buffer.from(cleanBase64, 'base64');
      mimeType = bodyMimeType || 'image/jpeg';
      sizeBytes = fileBuffer.length;
      if (mimeType.includes('png')) ext = 'png';
      else if (mimeType.includes('webp')) ext = 'webp';
      else if (mimeType.includes('pdf')) ext = 'pdf';
      else ext = 'jpg';
    }

    let proofRelativePath: string | null = null;
    if (fileBuffer && fileBuffer.length > 0) {
      const filename = `${payment.id}-${randomUUID().slice(0, 8)}.${ext}`;
      proofRelativePath = path.join(payment.tenantId, filename);
      const storageFilePath = path.resolve(PROOF_BASE_DIR, proofRelativePath);
      fs.mkdirSync(path.dirname(storageFilePath), { recursive: true });
      fs.writeFileSync(storageFilePath, fileBuffer);
    }

    const cleanUtr = (utrReference || utrNumber || '').trim();
    const cleanNote = (note || confirmationNote || '').trim();

    const updated = await prisma.upiPaymentLink.update({
      where: { id: payment.id },
      data: {
        status: UpiPaymentLinkStatus.CUSTOMER_CONFIRMED,
        confirmedAt: new Date(),
        utrReference: cleanUtr ? cleanUtr : payment.utrReference,
        confirmationNote: cleanNote ? cleanNote : payment.confirmationNote,
        ...(proofRelativePath ? {
          proofStoragePath: proofRelativePath,
          proofMimeType: mimeType,
          proofSizeBytes: sizeBytes,
        } : {}),
      },
    });

    await persistApiRealtimeEvent({
      tenantId: payment.tenantId,
      eventType: 'payment.customer_confirmed',
      payload: {
        paymentId: updated.id,
        publicToken: updated.publicToken,
        status: updated.status,
        utrReference: updated.utrReference,
        confirmationNote: updated.confirmationNote,
        hasProof: Boolean(updated.proofStoragePath),
      },
    });

    res.json({
      success: true,
      message: 'Payment confirmation recorded successfully',
      payment: {
        id: updated.id,
        status: updated.status,
        utrReference: updated.utrReference,
        confirmedAt: updated.confirmedAt,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'ConfirmationFailed',
      message: error instanceof Error ? error.message : 'Could not submit payment confirmation',
    });
  }
});

// ==========================================
// AUTHENTICATED & TENANT-ISOLATED PIPELINE
// ==========================================
paymentsRouter.use(authenticate, enforceTenantIsolation);

async function getPaymentScope(req: Request): Promise<WorkspaceScope> {
  return getWorkspaceScope(req.tenantId!, req.user!);
}

function canAccessPayment(scope: WorkspaceScope, createdByUserId: string) {
  return scope.all || scope.userIds.includes(createdByUserId);
}

const listPaymentsQuerySchema = z.object({
  page: z.string().optional().transform((v) => (v ? Math.max(1, Number(v)) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, Math.max(1, Number(v))) : 25)),
  status: z.string().optional(),
  search: z.string().optional(),
  leadId: z.string().optional(),
  phone: z.string().optional(),
  customerPhone: z.string().optional(),
});

const createPaymentSchema = z.object({
  leadId: z.string().optional(),
  customFields: z.record(z.any()).optional(),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  customerEmail: z.string().email().optional(),
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().optional().default('INR'),
  description: z.string().optional(),
  productName: z.string().optional(),
  notes: z.string().optional(),
  customerNote: z.string().optional(),
  upiId: z.string().optional(),
  expiryMinutes: z.number().positive().optional().default(30),
  expiresAt: z.string().optional(),
});

const updatePaymentSchema = z.object({
  amount: z.number().positive('Amount must be positive').optional(),
  description: z.string().optional(),
  productName: z.string().optional(),
  notes: z.string().optional(),
  customerNote: z.string().optional(),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  customerEmail: z.string().email().optional(),
  expiryMinutes: z.number().positive().optional(),
  expiresAt: z.string().optional(),
});

const settlePaymentSchema = z.object({
  utrNumber: z.string().optional(),
  utrReference: z.string().optional(),
  method: z.string().optional().default('UPI'),
  notes: z.string().optional(),
  note: z.string().optional(),
});

const paymentSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  upiId: z.string().max(120).nullable().optional(),
  payeeName: z.string().max(120).nullable().optional(),
  instructions: z.string().max(1000).nullable().optional(),
  qrBrandName: z.string().max(100).nullable().optional(),
  qrAccentColor: z.string().regex(/^#[0-9a-f]{6}$/i, 'QR accent color must be a valid hex color.').optional(),
  qrLogoDataUrl: z.string().max(280_000).regex(/^data:image\/(png|jpeg|jpg|webp);base64,/i, 'QR logo must be a PNG, JPG, or WebP image.').nullable().optional(),
});

// GET /settings - Merchant UPI settings
paymentsRouter.get('/settings', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const settings = await prisma.upiPaymentSetting.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, createdByUserId: req.user?.userId },
  });

  res.json({ success: true, data: settings, error: null });
});

// PUT /settings - Update merchant UPI settings
paymentsRouter.put('/settings', requireRoles('ADMIN', 'SUPER_ADMIN'), validateBody(paymentSettingsSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body as z.infer<typeof paymentSettingsSchema>;
  const current = await prisma.upiPaymentSetting.findUnique({ where: { tenantId } });
  const enabled = body.enabled ?? current?.enabled ?? false;
  const upiId = body.upiId === undefined ? current?.upiId ?? null : body.upiId;
  const payeeName = body.payeeName === undefined ? current?.payeeName ?? null : body.payeeName;

  if (enabled && (!upiId || !payeeName)) {
    res.status(400).json({ success: false, error: 'UPI ID and payee name are required when payment collection is enabled.' });
    return;
  }

  const settings = await prisma.upiPaymentSetting.upsert({
    where: { tenantId },
    update: {
      enabled,
      upiId,
      payeeName,
      ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
      ...(body.qrBrandName !== undefined ? { qrBrandName: body.qrBrandName } : {}),
      ...(body.qrAccentColor !== undefined ? { qrAccentColor: body.qrAccentColor } : {}),
      ...(body.qrLogoDataUrl !== undefined ? { qrLogoDataUrl: body.qrLogoDataUrl } : {}),
      updatedByUserId: req.user?.userId,
    },
    create: {
      tenantId,
      enabled,
      upiId,
      payeeName,
      instructions: body.instructions ?? null,
      qrBrandName: body.qrBrandName ?? null,
      qrAccentColor: body.qrAccentColor ?? '#ff5a1f',
      qrLogoDataUrl: body.qrLogoDataUrl ?? null,
      createdByUserId: req.user?.userId,
      updatedByUserId: req.user?.userId,
    },
  });

  res.json({ success: true, data: settings, error: null });
});

// GET / - List tenant payments with pagination, filters, and search
paymentsRouter.get('/', validateQuery(listPaymentsQuerySchema), async (req: Request, res: Response) => {
  const { page, limit, status, search, leadId, phone, customerPhone } = req.query as unknown as {
    page: number;
    limit: number;
    status?: string;
    search?: string;
    leadId?: string;
    phone?: string;
    customerPhone?: string;
  };

  const tenantId = req.tenantId!;
  const scope = await getPaymentScope(req);
  const where: Record<string, unknown> = { tenantId };

  const targetPhone = (phone || customerPhone)?.trim();

  if (leadId) {
    // Lead-specific payments are scoped to the lead itself, visible across assigned and shared closers
    const lead = await prisma.salesLeadAssignment.findFirst({
      where: { id: leadId, tenantId },
      select: { id: true, customerPhone: true },
    });
    const last10 = lead?.customerPhone ? lead.customerPhone.replace(/\D/g, '').slice(-10) : null;
    where.OR = [
      { customFields: { path: ['leadId'], equals: leadId } },
      ...(last10 ? [{ customerPhone: { contains: last10 } }] : []),
    ];
  } else if (targetPhone) {
    const rawDigits = targetPhone.replace(/\D/g, '');
    const phoneFilter = rawDigits.length >= 10 ? rawDigits.slice(-10) : targetPhone;
    where.customerPhone = { contains: phoneFilter };
  } else if (!scope.all) {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user!.userId, tenantId },
      select: { id: true },
    });
    const assignedLeads = profile
      ? await prisma.salesLeadAssignment.findMany({
          where: { assignedAgentId: profile.id, tenantId },
          select: { id: true },
        })
      : [];
    const assignedLeadIds = assignedLeads.map((l) => l.id);

    const userOrLeadConditions: any[] = [
      { createdByUserId: { in: scope.userIds.length ? scope.userIds : ['__NO_ACCESS__'] } },
    ];
    for (const lid of assignedLeadIds) {
      userOrLeadConditions.push({ customFields: { path: ['leadId'], equals: lid } });
    }

    where.OR = userOrLeadConditions;
  }

  // Handle status mapping (COMPLETED -> PAID)
  if (status) {
    const normalizedStatus = status.toUpperCase();
    if (normalizedStatus === 'COMPLETED') {
      where.status = UpiPaymentLinkStatus.PAID;
    } else if (Object.values(UpiPaymentLinkStatus).includes(normalizedStatus as any)) {
      where.status = normalizedStatus as UpiPaymentLinkStatus;
    }
  }

  if (search) {
    const trimmed = search.trim();
    const searchConditions: any[] = [
      { customerName: { contains: trimmed, mode: 'insensitive' } },
      { customerPhone: { contains: trimmed } },
      { customerEmail: { contains: trimmed, mode: 'insensitive' } },
      { utrReference: { contains: trimmed } },
    ];
    if (where.OR) {
      where.AND = [{ OR: where.OR }, { OR: searchConditions }];
      delete where.OR;
    } else {
      where.OR = searchConditions;
    }
  }

  const [total, payments, amountSummary, statusSummary] = await Promise.all([
    prisma.upiPaymentLink.count({ where }),
    prisma.upiPaymentLink.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: {
          select: { displayName: true, email: true },
        },
      },
    }),
    prisma.upiPaymentLink.aggregate({
      where,
      _sum: { totalAmount: true },
    }),
    prisma.upiPaymentLink.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: { totalAmount: true },
    }),
  ]);

  const statusTotals = Object.fromEntries(
    statusSummary.map((item) => [
      item.status,
      { count: item._count._all, amount: Number(item._sum.totalAmount || 0) },
    ]),
  );

  const now = new Date();
  const formattedPayments = payments.map((p) => {
    const payUrl = `https://app.aicloser.in/pay/${p.publicToken}`;
    const custom = (p.customFields as any) || {};
    const createdAtDate = new Date(p.createdAt);
    const expiryMinutes = Number(custom.expiryMinutes || 30);
    const expiresAtDate = custom.expiresAt
      ? new Date(custom.expiresAt)
      : new Date(createdAtDate.getTime() + expiryMinutes * 60 * 1000);
    const isExpired = p.status === 'EXPIRED' || (p.status === 'PENDING' && now > expiresAtDate);
    const remainingSeconds = Math.max(0, Math.floor((expiresAtDate.getTime() - now.getTime()) / 1000));
    const effectiveStatus = isExpired && p.status === 'PENDING' ? 'EXPIRED' : p.status;

    return {
      ...p,
      status: effectiveStatus,
      rawStatus: p.status,
      expiresAt: expiresAtDate.toISOString(),
      isExpired,
      remainingSeconds,
      expiryMinutes,
      leadId: custom.leadId || null,
      payUrl,
      paymentUrl: payUrl,
      isPaid: p.status === 'PAID',
    };
  });

  res.json({
    success: true,
    data: formattedPayments,
    payments: formattedPayments,
    summary: {
      totalLinks: total,
      totalAmount: Number(amountSummary._sum.totalAmount || 0),
      paidAmount: statusTotals.PAID?.amount || 0,
      pendingAmount: (statusTotals.PENDING?.amount || 0) + (statusTotals.CUSTOMER_CONFIRMED?.amount || 0),
      statusTotals,
    },
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    error: null,
  });
});

// POST / - Generate real payment request linked to lead
paymentsRouter.post('/', validateBody(createPaymentSchema), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const body = req.body as z.infer<typeof createPaymentSchema>;
    const publicToken = randomUUID().replace(/-/g, '').slice(0, 16);
    const paymentSettings = await prisma.upiPaymentSetting.findUnique({ where: { tenantId } });
    const upiId = body.upiId || paymentSettings?.upiId || 'aicloser@upi';
    const payeeName = paymentSettings?.payeeName || 'AI Closer CRM';

    // If leadId is passed, find lead details to auto-populate if missing
    let lead = null;
    if (body.leadId) {
      lead = await prisma.salesLeadAssignment.findFirst({
        where: { id: body.leadId, tenantId },
      });
    }

    if (!lead && body.customerPhone) {
      const trimmedPhone = body.customerPhone.trim();
      const digitsOnly = trimmedPhone.replace(/\D/g, '');
      const orPhones = [trimmedPhone];
      if (digitsOnly.length >= 10) {
        orPhones.push(`+91${digitsOnly.slice(-10)}`, digitsOnly.slice(-10));
      }
      lead = await prisma.salesLeadAssignment.findFirst({
        where: {
          tenantId,
          customerPhone: { in: orPhones },
        },
      });
    }

    // Sync budgetAmount to SalesLeadAssignment so deal value reflects payment link amount
    if (lead) {
      await prisma.salesLeadAssignment.update({
        where: { id: lead.id },
        data: {
          budgetAmount: body.amount,
          updatedAt: new Date(),
        },
      }).catch(() => undefined);
    }

    const customerName = (body.customerName || lead?.customerName || 'Valued Customer').trim();
    const customerPhone = (body.customerPhone || lead?.customerPhone || '').trim();
    const customerEmail = body.customerEmail || lead?.customerEmail || null;
    const productName = (body.description || body.productName || lead?.serviceInterest || 'CRM License / Consultation').trim();
    const customerNote = body.notes || body.customerNote || lead?.notes || null;

    let userId = req.user?.userId;
    if (userId) {
      const userExists = await prisma.appAuthUser.findUnique({ where: { id: userId } });
      if (!userExists) {
        const adminUser = await prisma.appAuthUser.findFirst({ where: { tenantId } });
        userId = adminUser?.id || undefined;
      }
    }
    if (!userId) {
      const fallbackUser = await prisma.appAuthUser.findFirst({ where: { tenantId } });
      if (fallbackUser) userId = fallbackUser.id;
    }

    if (!userId) {
      res.status(400).json({ success: false, error: 'UserNotFound', message: 'No valid user found to attribute payment link creation' });
      return;
    }

    const effectiveLeadId = body.leadId || (body.customFields as any)?.leadId || lead?.id || null;
    const expiryMinutes = body.expiryMinutes || 30;
    const expiresAt = body.expiresAt
      ? new Date(body.expiresAt)
      : new Date(Date.now() + expiryMinutes * 60 * 1000);

    const paymentCustomFields: Record<string, any> = {
      ...(typeof body.customFields === 'object' && body.customFields ? body.customFields : {}),
      ...(effectiveLeadId ? { leadId: effectiveLeadId } : {}),
      expiresAt: expiresAt.toISOString(),
      expiryMinutes,
    };

    const payment = await prisma.upiPaymentLink.create({
      data: {
        tenantId,
        publicToken,
        createdByUserId: userId,
        baseAmount: body.amount,
        totalAmount: body.amount,
        duration: 1,
        durationUnit: UpiPaymentDurationUnit.DAY,
        durationMultiplier: 1,
        currency: body.currency || 'INR',
        upiIdSnapshot: upiId,
        payeeNameSnapshot: payeeName,
        customerName,
        customerPhone,
        customerEmail,
        productName,
        customerNote,
        customFields: paymentCustomFields,
        status: UpiPaymentLinkStatus.PENDING,
      },
    });

    // Directly bind payment link & countdown timer to the SalesLeadAssignment for follow-ups!
    if (lead) {
      const existingLeadCustom = (typeof lead.customFields === 'object' && lead.customFields) ? (lead.customFields as any) : {};
      await prisma.salesLeadAssignment.update({
        where: { id: lead.id },
        data: {
          budgetAmount: body.amount,
          customFields: {
            ...existingLeadCustom,
            lastPaymentLinkId: payment.id,
            lastPaymentLinkToken: payment.publicToken,
            paymentExpiresAt: expiresAt.toISOString(),
            paymentStatus: 'PENDING',
            paymentAmount: body.amount,
            paymentProductName: productName,
          },
          updatedAt: new Date(),
        },
      }).catch(() => undefined);
    }

    await persistApiRealtimeEvent({
      tenantId,
      eventType: 'payment.created',
      payload: {
        paymentId: payment.id,
        leadId: body.leadId,
        amount: payment.totalAmount,
        customerName: payment.customerName,
        customerPhone: payment.customerPhone,
      },
      actorUserId: req.user?.userId,
    }).catch(() => undefined);

    const payUrl = `https://app.aicloser.in/pay/${payment.publicToken}`;
    const paymentData = {
      ...payment,
      expiresAt: expiresAt.toISOString(),
      isExpired: false,
      remainingSeconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
      expiryMinutes,
      leadId: effectiveLeadId,
      payUrl,
      paymentUrl: payUrl,
    };

    res.status(201).json({
      success: true,
      payment: paymentData,
      data: paymentData,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'PaymentCreateFailed', message: error instanceof Error ? error.message : 'Could not create payment link' });
  }
});

// GET /:id - Get payment details
paymentsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const payment = await prisma.upiPaymentLink.findFirst({
    where: { id, tenantId },
    include: {
      createdBy: { select: { displayName: true, email: true } },
    },
  });

  if (!payment) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Payment link not found' });
    return;
  }

  const scope = await getPaymentScope(req);
  if (!canAccessPayment(scope, payment.createdByUserId)) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only view your own payment links' });
    return;
  }

  const custom = (payment.customFields as any) || {};
  const createdAtDate = new Date(payment.createdAt);
  const expiryMinutes = Number(custom.expiryMinutes || 30);
  const expiresAtDate = custom.expiresAt
    ? new Date(custom.expiresAt)
    : new Date(createdAtDate.getTime() + expiryMinutes * 60 * 1000);
  const now = new Date();
  const isExpired = payment.status === 'EXPIRED' || (payment.status === 'PENDING' && now > expiresAtDate);
  const remainingSeconds = Math.max(0, Math.floor((expiresAtDate.getTime() - now.getTime()) / 1000));
  const effectiveStatus = isExpired && payment.status === 'PENDING' ? 'EXPIRED' : payment.status;

  const payUrl = `https://app.aicloser.in/pay/${payment.publicToken}`;
  const responseData = {
    ...payment,
    status: effectiveStatus,
    rawStatus: payment.status,
    expiresAt: expiresAtDate.toISOString(),
    isExpired,
    remainingSeconds,
    expiryMinutes,
    leadId: custom.leadId || null,
    hasProof: Boolean(payment.proofStoragePath),
    payUrl,
    paymentUrl: payUrl,
  };

  res.json({
    success: true,
    payment: responseData,
    data: responseData,
    error: null,
  });
});

// PATCH /:id - Edit amount/notes on PENDING items only
paymentsRouter.patch('/:id', validateBody(updatePaymentSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof updatePaymentSchema>;

  const payment = await prisma.upiPaymentLink.findFirst({
    where: { id, tenantId },
  });

  if (!payment) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Payment link not found' });
    return;
  }

  const scope = await getPaymentScope(req);
  if (!canAccessPayment(scope, payment.createdByUserId)) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have permission to edit this payment link' });
    return;
  }

  if (payment.status === UpiPaymentLinkStatus.PAID || payment.status === UpiPaymentLinkStatus.CANCELLED || payment.status === UpiPaymentLinkStatus.REJECTED) {
    res.status(400).json({
      success: false,
      error: 'CannotEditNonPendingPayment',
      message: `Cannot edit payment in status ${payment.status}. Only PENDING payments can be modified.`,
    });
    return;
  }

  const custom = (payment.customFields as any) || {};
  let updatedCustom = { ...custom };
  if (body.expiryMinutes !== undefined) {
    const newExpiresAt = new Date(Date.now() + body.expiryMinutes * 60 * 1000).toISOString();
    updatedCustom = {
      ...updatedCustom,
      expiryMinutes: body.expiryMinutes,
      expiresAt: newExpiresAt,
    };
  } else if (body.expiresAt !== undefined) {
    updatedCustom = {
      ...updatedCustom,
      expiresAt: new Date(body.expiresAt).toISOString(),
    };
  }

  const updated = await prisma.upiPaymentLink.update({
    where: { id: payment.id },
    data: {
      ...(body.amount !== undefined ? { baseAmount: body.amount, totalAmount: body.amount } : {}),
      ...(body.productName || body.description ? { productName: body.productName || body.description } : {}),
      ...(body.customerNote || body.notes ? { customerNote: body.customerNote || body.notes } : {}),
      ...(body.customerName !== undefined ? { customerName: body.customerName } : {}),
      ...(body.customerPhone !== undefined ? { customerPhone: body.customerPhone } : {}),
      ...(body.customerEmail !== undefined ? { customerEmail: body.customerEmail } : {}),
      customFields: updatedCustom,
    },
  });

  if (custom.leadId) {
    const lead = await prisma.salesLeadAssignment.findFirst({
      where: { id: custom.leadId, tenantId },
    });
    if (lead) {
      const existingLeadCustom = (typeof lead.customFields === 'object' && lead.customFields) ? (lead.customFields as any) : {};
      await prisma.salesLeadAssignment.update({
        where: { id: lead.id },
        data: {
          ...(body.amount !== undefined ? { budgetAmount: body.amount } : {}),
          customFields: {
            ...existingLeadCustom,
            ...(updatedCustom.expiresAt ? { paymentExpiresAt: updatedCustom.expiresAt } : {}),
            ...(body.amount !== undefined ? { paymentAmount: body.amount } : {}),
          },
          updatedAt: new Date(),
        },
      }).catch(() => undefined);
    }
  }

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      actorUserId: req.user?.userId,
      action: 'PAYMENT_UPDATED',
      note: `Payment ${payment.id} updated by ${req.user?.displayName || req.user?.email}`,
      metadata: { paymentId: payment.id, changes: body },
    },
  }).catch(() => undefined);

  const payUrl = `https://app.aicloser.in/pay/${updated.publicToken}`;
  const responseData = {
    ...updated,
    expiresAt: updatedCustom.expiresAt,
    expiryMinutes: updatedCustom.expiryMinutes || 30,
    leadId: custom.leadId || null,
    payUrl,
    paymentUrl: payUrl,
  };

  res.json({
    success: true,
    payment: responseData,
    data: responseData,
    message: 'Payment updated successfully',
  });
});

// POST /:id/cancel and DELETE /:id - Cancel a payment
const handlePaymentCancel = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const payment = await prisma.upiPaymentLink.findFirst({
    where: { id, tenantId },
  });

  if (!payment) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Payment link not found' });
    return;
  }

  const scope = await getPaymentScope(req);
  if (!canAccessPayment(scope, payment.createdByUserId)) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have permission to cancel this payment' });
    return;
  }

  if (payment.status === UpiPaymentLinkStatus.PAID) {
    res.status(400).json({ success: false, error: 'CannotCancelCompletedPayment', message: 'Cannot cancel a completed/settled payment' });
    return;
  }

  const updated = await prisma.upiPaymentLink.update({
    where: { id: payment.id },
    data: {
      status: UpiPaymentLinkStatus.CANCELLED,
      rejectedAt: new Date(),
      rejectedByUserId: req.user?.userId,
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      actorUserId: req.user?.userId,
      action: 'PAYMENT_CANCELLED',
      note: `Payment ${payment.id} (₹${payment.totalAmount}) cancelled`,
      metadata: { paymentId: payment.id, previousStatus: payment.status },
    },
  }).catch(() => undefined);

  const payUrl = `https://app.aicloser.in/pay/${updated.publicToken}`;
  const responseData = { ...updated, payUrl, paymentUrl: payUrl };

  res.json({
    success: true,
    message: 'Payment cancelled successfully',
    payment: responseData,
    data: responseData,
  });
};

paymentsRouter.post('/:id/cancel', handlePaymentCancel);
paymentsRouter.delete('/:id', handlePaymentCancel);

// POST /:id/settle & POST /:id/confirm - Settle payment, record immutable ledger, and auto-advance lead to CLOSED_WON
const handlePaymentSettle = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof settlePaymentSchema>;

  const payment = await prisma.upiPaymentLink.findFirst({
    where: { id, tenantId },
  });

  if (!payment) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Payment link not found' });
    return;
  }

  // Anti-fraud self-settle restriction (ITEM-57): Sales agents cannot settle payments
  if (req.user?.role === 'SALES_AGENT' || (req.user?.role as string) === 'CLOSER') {
    res.status(403).json({
      success: false,
      error: 'SelfSettleForbidden',
      message: 'Sales agents are not permitted to settle payment links. Only an Admin or Manager can verify and settle payments.',
    });
    return;
  }

  const scope = await getPaymentScope(req);
  if (!canAccessPayment(scope, payment.createdByUserId)) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have permission to settle this payment' });
    return;
  }

  if (payment.status === UpiPaymentLinkStatus.PAID) {
    const payUrl = `https://app.aicloser.in/pay/${payment.publicToken}`;
    const paymentData = { ...payment, payUrl, paymentUrl: payUrl, isPaid: true };
    res.json({ success: true, message: 'Payment was already settled', payment: paymentData, data: paymentData });
    return;
  }

  const utr = (body.utrNumber || body.utrReference || payment.utrReference || `UTR-${randomUUID().slice(0, 8).toUpperCase()}`).trim();
  const note = (body.note || body.notes || payment.confirmationNote || 'Payment settled').trim();
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    // 1. Update UpiPaymentLink status to PAID
    const updatedPayment = await tx.upiPaymentLink.update({
      where: { id: payment.id },
      data: {
        status: UpiPaymentLinkStatus.PAID,
        paidAt: now,
        confirmedAt: payment.confirmedAt || now,
        confirmedByUserId: payment.confirmedByUserId || req.user?.userId,
        approvedAt: now,
        approvedByUserId: req.user?.userId,
        utrReference: utr,
        confirmationNote: note,
      },
    });

    // 2. Write immutable audit entry in SalesActivityLog
    await tx.salesActivityLog.create({
      data: {
        tenantId,
        actorUserId: req.user?.userId,
        action: 'PAYMENT_SETTLED',
        note: `Payment of ₹${updatedPayment.totalAmount} settled for ${updatedPayment.customerName || 'customer'} (UTR: ${utr})`,
        metadata: {
          paymentId: updatedPayment.id,
          amount: Number(updatedPayment.totalAmount),
          currency: updatedPayment.currency,
          utrNumber: utr,
          method: body.method || 'UPI',
          settledAt: now.toISOString(),
        },
      },
    });

    // 3. Auto-advance associated lead deal stage to CLOSED_WON and sync budgetAmount!
    const leadId = (payment.customFields as any)?.leadId;
    let updatedLead = null;
    let existingLead = null;
    if (leadId) {
      existingLead = await tx.salesLeadAssignment.findFirst({
        where: { id: leadId, tenantId },
      });
    }

    if (!existingLead && payment.customerPhone) {
      const trimmedPhone = payment.customerPhone.trim();
      const digitsOnly = trimmedPhone.replace(/\D/g, '');
      const orPhones = [trimmedPhone];
      if (digitsOnly.length >= 10) {
        orPhones.push(`+91${digitsOnly.slice(-10)}`, digitsOnly.slice(-10));
      }
      existingLead = await tx.salesLeadAssignment.findFirst({
        where: {
          tenantId,
          customerPhone: { in: orPhones },
        },
      });
    }

    if (existingLead) {
      updatedLead = await tx.salesLeadAssignment.update({
        where: { id: existingLead.id },
        data: {
          stage: 'CLOSED_WON',
          budgetAmount: updatedPayment.totalAmount,
          stageChangedAt: now,
          updatedAt: now,
        },
      });

        // Add lead audit log
        await tx.salesActivityLog.create({
          data: {
            tenantId,
            assignmentId: existingLead.id,
            actorUserId: req.user?.userId,
            action: 'LEAD_STAGE_CHANGED',
            note: `Lead stage auto-advanced to CLOSED_WON upon payment settlement of ₹${updatedPayment.totalAmount}`,
            metadata: {
              previousStage: existingLead.stage,
              newStage: 'CLOSED_WON',
              paymentId: updatedPayment.id,
              amount: Number(updatedPayment.totalAmount),
            },
          },
        });

        // Create or update SalesDeal record
        await tx.salesDeal.create({
          data: {
            tenantId,
            assignmentId: existingLead.id,
            agentId: existingLead.assignedAgentId,
            title: updatedPayment.productName || 'Payment Settlement Deal',
            agreedAmount: updatedPayment.totalAmount,
            paidAmount: updatedPayment.totalAmount,
            status: 'PAID',
            paymentReference: utr,
            closedAt: now,
            handoffNotes: `Auto-created upon UPI payment settlement ${updatedPayment.id}`,
          },
        }).catch(() => undefined);
      }

    return { payment: updatedPayment, lead: updatedLead };
  });

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'payment.settled',
    payload: {
      paymentId: result.payment.id,
      amount: result.payment.totalAmount,
      customerName: result.payment.customerName,
      leadId: (payment.customFields as any)?.leadId,
      status: 'PAID',
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  const payUrl = `https://app.aicloser.in/pay/${result.payment.publicToken}`;
  const paymentResponse = {
    ...result.payment,
    payUrl,
    paymentUrl: payUrl,
    isPaid: true,
  };

  res.json({
    success: true,
    payment: paymentResponse,
    data: paymentResponse,
    lead: result.lead,
    message: result.lead
      ? 'Payment settled and lead auto-advanced to CLOSED_WON'
      : 'Payment settled successfully',
  });
};

paymentsRouter.post('/:id/settle', validateBody(settlePaymentSchema), handlePaymentSettle);
paymentsRouter.post('/:id/confirm', validateBody(settlePaymentSchema), handlePaymentSettle);
paymentsRouter.post('/:id/approve', handlePaymentSettle);

// POST /:id/reject - Reject payment link
paymentsRouter.post('/:id/reject', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const payment = await prisma.upiPaymentLink.findFirst({
    where: { id, tenantId },
  });

  if (!payment) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Payment link not found' });
    return;
  }

  const scope = await getPaymentScope(req);
  if (!canAccessPayment(scope, payment.createdByUserId)) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to this payment link' });
    return;
  }

  const reason = String(req.body?.reason || req.body?.rejectionReason || req.body?.note || 'Payment rejected').trim();

  const updated = await prisma.upiPaymentLink.update({
    where: { id: payment.id },
    data: {
      status: UpiPaymentLinkStatus.REJECTED,
      rejectedAt: new Date(),
      rejectedByUserId: req.user?.userId,
      confirmationNote: reason,
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      actorUserId: req.user?.userId,
      action: 'PAYMENT_REJECTED',
      note: `Payment ${payment.id} (₹${payment.totalAmount}) rejected: ${reason}`,
      metadata: { paymentId: payment.id, previousStatus: payment.status, reason },
    },
  }).catch(() => undefined);

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'payment.rejected',
    payload: {
      paymentId: updated.id,
      amount: updated.totalAmount,
      customerName: updated.customerName,
      leadId: (payment.customFields as any)?.leadId,
      status: 'REJECTED',
      reason,
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.json({ success: true, data: updated, payment: updated, message: 'Payment link rejected successfully' });
});

// POST /:id/proof - Attach payment screenshot proof
paymentsRouter.post('/:id/proof', upload.any(), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const id = String(req.params.id);

    const payment = await prisma.upiPaymentLink.findFirst({
      where: { id, tenantId },
    });

    if (!payment) {
      res.status(404).json({ success: false, error: 'NotFound', message: 'Payment link not found' });
      return;
    }

    const scope = await getPaymentScope(req);
    if (!canAccessPayment(scope, payment.createdByUserId)) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only attach proof to your own payment links' });
      return;
    }

    if (!['PENDING', 'CUSTOMER_CONFIRMED'].includes(payment.status)) {
      res.status(400).json({ success: false, error: 'InvalidStatus', message: 'This payment link is no longer awaiting proof' });
      return;
    }

    const file = (req.files && Array.isArray(req.files) ? req.files[0] : req.file);
    const { utrReference, note, confirmationNote, base64Data, mimeType: bodyMimeType } = req.body as {
      utrReference?: string;
      note?: string;
      confirmationNote?: string;
      base64Data?: string;
      mimeType?: string;
    };

    let fileBuffer: Buffer | null = null;
    let mimeType = 'image/jpeg';
    let sizeBytes = 0;
    let ext = 'jpg';

    if (file) {
      fileBuffer = file.buffer;
      mimeType = file.mimetype || 'image/jpeg';
      sizeBytes = file.size;
      if (mimeType.includes('png')) ext = 'png';
      else if (mimeType.includes('webp')) ext = 'webp';
      else if (mimeType.includes('pdf')) ext = 'pdf';
      else ext = 'jpg';
    } else if (base64Data) {
      const cleanBase64 = base64Data.replace(/^data:.*?;base64,/, '');
      fileBuffer = Buffer.from(cleanBase64, 'base64');
      mimeType = bodyMimeType || 'image/jpeg';
      sizeBytes = fileBuffer.length;
      if (mimeType.includes('png')) ext = 'png';
      else if (mimeType.includes('webp')) ext = 'webp';
      else if (mimeType.includes('pdf')) ext = 'pdf';
      else ext = 'jpg';
    }

    let proofRelativePath: string | null = null;
    if (fileBuffer && fileBuffer.length > 0) {
      const filename = `${payment.id}-${randomUUID().slice(0, 8)}.${ext}`;
      proofRelativePath = path.join(tenantId, filename);
      const storageFilePath = path.resolve(PROOF_BASE_DIR, proofRelativePath);
      fs.mkdirSync(path.dirname(storageFilePath), { recursive: true });
      fs.writeFileSync(storageFilePath, fileBuffer);
    }

    const updated = await prisma.upiPaymentLink.update({
      where: { id: payment.id },
      data: {
        ...(proofRelativePath ? {
          proofStoragePath: proofRelativePath,
          proofMimeType: mimeType,
          proofSizeBytes: sizeBytes,
        } : {}),
        status: UpiPaymentLinkStatus.CUSTOMER_CONFIRMED,
        confirmedAt: new Date(),
        confirmedByUserId: req.user?.userId || null,
        utrReference: utrReference ? String(utrReference).trim() : payment.utrReference,
        confirmationNote: (note || confirmationNote) ? String(note || confirmationNote).trim() : payment.confirmationNote,
      },
    });

    await persistApiRealtimeEvent({
      tenantId,
      eventType: 'payment.proof_attached',
      payload: {
        paymentId: updated.id,
        amount: updated.totalAmount,
        customerName: updated.customerName,
        customerPhone: updated.customerPhone,
        hasProof: true,
        status: updated.status,
      },
      actorUserId: req.user?.userId,
    }).catch(() => undefined);

    res.status(200).json({
      success: true,
      data: {
        ...updated,
        hasProof: true,
        proofUrl: `/api/v1/payments/${updated.id}/proof`,
      },
      message: 'Payment screenshot attached successfully',
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'ProofUploadFailed', message: error instanceof Error ? error.message : 'Could not upload payment proof' });
  }
});

// GET /:id/proof - Download / view payment screenshot
paymentsRouter.get('/:id/proof', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const id = String(req.params.id);

    const payment = await prisma.upiPaymentLink.findFirst({
      where: { id, tenantId },
    });

    if (!payment) {
      res.status(404).json({ success: false, error: 'NotFound', message: 'Payment link not found' });
      return;
    }

    const scope = await getPaymentScope(req);
    if (!canAccessPayment(scope, payment.createdByUserId)) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only view payment proof for your own links' });
      return;
    }

    if (!payment.proofStoragePath) {
      res.status(404).json({ success: false, error: 'ProofNotFound', message: 'No proof screenshot attached to this payment link' });
      return;
    }

    const filePath = resolveProofFilePath(payment.proofStoragePath);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ success: false, error: 'FileNotFound', message: 'Proof file could not be found on storage' });
      return;
    }

    res.setHeader('Content-Type', payment.proofMimeType || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(filePath);
  } catch (error) {
    res.status(500).json({ success: false, error: 'ProofRetrieveFailed', message: error instanceof Error ? error.message : 'Could not retrieve payment proof' });
  }
});
