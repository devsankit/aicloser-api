import { persistApiRealtimeEvent } from '../../lib/realtime.js';
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

paymentsRouter.use(authenticate, enforceTenantIsolation);

const listPaymentsQuerySchema = z.object({
  page: z.string().optional().transform((v) => (v ? Math.max(1, Number(v)) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, Math.max(1, Number(v))) : 25)),
  status: z.nativeEnum(UpiPaymentLinkStatus).optional(),
  search: z.string().optional(),
});

const createPaymentSchema = z.object({
  leadId: z.string().optional(),
  customerName: z.string().min(1, 'Customer name is required'),
  customerPhone: z.string().min(5, 'Customer phone is required'),
  customerEmail: z.string().email().optional(),
  amount: z.number().positive('Amount must be positive'),
  productName: z.string().optional().default('CRM License / Consultation'),
  customerNote: z.string().optional(),
  upiId: z.string().optional(),
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

paymentsRouter.get('/settings', requireRoles('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const settings = await prisma.upiPaymentSetting.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, createdByUserId: req.user?.userId },
  });

  res.json({ success: true, data: settings, error: null });
});

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

paymentsRouter.get('/', validateQuery(listPaymentsQuerySchema), async (req: Request, res: Response) => {
  const { page, limit, status, search } = req.query as unknown as {
    page: number;
    limit: number;
    status?: UpiPaymentLinkStatus;
    search?: string;
  };

  const tenantId = req.tenantId!;
  const where: Record<string, unknown> = { tenantId };

  // Sales agents can only see payment links they created. Tenant admins and
  // managers keep the workspace-wide view needed for the dashboard totals.
  if (req.user?.role === 'SALES_AGENT') {
    where.createdByUserId = req.user.userId;
  }

  if (status) where.status = status;
  if (search) {
    where.OR = [
      { customerName: { contains: search, mode: 'insensitive' } },
      { customerPhone: { contains: search } },
      { utrReference: { contains: search } },
    ];
  }

  const [total, payments, amountSummary, statusSummary] = await Promise.all([
    prisma.upiPaymentLink.count({ where }),
    prisma.upiPaymentLink.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { id: 'desc' },
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

  res.json({
    success: true,
    data: payments,
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

paymentsRouter.post('/', validateBody(createPaymentSchema), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const body = req.body as z.infer<typeof createPaymentSchema>;
    const publicToken = randomUUID().replace(/-/g, '').slice(0, 16);
    const paymentSettings = await prisma.upiPaymentSetting.findUnique({ where: { tenantId } });
    const upiId = body.upiId || paymentSettings?.upiId || 'aicloser@upi';
    const payeeName = paymentSettings?.payeeName || 'AI Closer CRM';

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
        currency: 'INR',
        upiIdSnapshot: upiId,
        payeeNameSnapshot: payeeName,
        customerName: body.customerName,
        customerPhone: body.customerPhone,
        customerEmail: body.customerEmail,
        productName: body.productName,
        customerNote: body.customerNote,
        customFields: body.leadId ? { leadId: body.leadId } : undefined,
        status: UpiPaymentLinkStatus.PENDING,
      },
    });

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

    const paymentUrl = 'https://app.aicloser.in/pay/' + payment.publicToken;

    res.status(201).json({
      success: true,
      data: {
        ...payment,
        paymentUrl,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'PaymentCreateFailed', message: error instanceof Error ? error.message : 'Could not create payment link' });
  }
});

paymentsRouter.post('/:id/approve', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const payment = await prisma.upiPaymentLink.findFirst({
    where: { id, tenantId },
  });

  if (!payment) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Payment link not found' });
    return;
  }

  const updated = await prisma.upiPaymentLink.update({
    where: { id: payment.id },
    data: {
      status: UpiPaymentLinkStatus.PAID,
      approvedAt: new Date(),
      approvedByUserId: req.user?.userId,
    },
  });

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'payment.confirmed',
    payload: {
      paymentId: updated.id,
      amount: updated.totalAmount,
      customerName: updated.customerName,
      customerPhone: updated.customerPhone,
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.json({ success: true, data: updated, message: 'Payment verified and approved successfully', error: null });
});

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

  const updated = await prisma.upiPaymentLink.update({
    where: { id: payment.id },
    data: {
      status: UpiPaymentLinkStatus.CANCELLED,
      rejectedAt: new Date(),
      rejectedByUserId: req.user?.userId,
    },
  });

  res.json({ success: true, data: updated, message: 'Payment link rejected/cancelled' });
});

paymentsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const payment = await prisma.upiPaymentLink.findFirst({
    where: { id, tenantId },
  });

  if (!payment) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Payment link not found' });
    return;
  }

  if (req.user?.role === 'SALES_AGENT' && payment.createdByUserId !== req.user.userId) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only view your own payment links' });
    return;
  }

  res.json({
    success: true,
    data: {
      ...payment,
      hasProof: Boolean(payment.proofStoragePath),
      paymentUrl: 'https://app.aicloser.in/pay/' + payment.publicToken,
    },
    error: null,
  });
});

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

    // Sales agent can only attach proof to their own payment links
    if (req.user?.role === 'SALES_AGENT' && payment.createdByUserId !== req.user.userId) {
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

    if (!fileBuffer || fileBuffer.length === 0) {
      res.status(400).json({ success: false, error: 'FileRequired', message: 'Please provide a payment proof screenshot file or base64Data' });
      return;
    }

    const filename = `${payment.id}-${randomUUID().slice(0, 8)}.${ext}`;
    const proofRelativePath = path.join(tenantId, filename);
    const storageFilePath = path.resolve(PROOF_BASE_DIR, proofRelativePath);

    fs.mkdirSync(path.dirname(storageFilePath), { recursive: true });
    fs.writeFileSync(storageFilePath, fileBuffer);

    const updated = await prisma.upiPaymentLink.update({
      where: { id: payment.id },
      data: {
        proofStoragePath: proofRelativePath,
        proofMimeType: mimeType,
        proofSizeBytes: sizeBytes,
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

    // Sales agent can only view proof of their own links
    if (req.user?.role === 'SALES_AGENT' && payment.createdByUserId !== req.user.userId) {
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
