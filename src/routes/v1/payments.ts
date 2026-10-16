import { persistApiRealtimeEvent } from '../../lib/realtime.js';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { UpiPaymentDurationUnit, UpiPaymentLinkStatus } from '@prisma/client';

export const paymentsRouter = Router();

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
  upiId: z.string().optional().default('aicloser@upi'),
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
  const tenantId = req.tenantId!;
  const body = req.body as z.infer<typeof createPaymentSchema>;
  const publicToken = randomUUID().replace(/-/g, '').slice(0, 16);

  const payment = await prisma.upiPaymentLink.create({
    data: {
      tenantId,
      publicToken,
      createdByUserId: req.user?.userId || 'system',
      baseAmount: body.amount,
      totalAmount: body.amount,
      duration: 1,
      durationUnit: UpiPaymentDurationUnit.DAY,
      durationMultiplier: 1,
      currency: 'INR',
      upiIdSnapshot: body.upiId,
      payeeNameSnapshot: 'AI Closer CRM',
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

  const paymentUrl = "https://app.aicloser.in/pay/" + payment.publicToken;

  res.status(201).json({
    success: true,
    data: {
      ...payment,
      paymentUrl,
    },
  });
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
