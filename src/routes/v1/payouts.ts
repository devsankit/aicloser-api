import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';

export const payoutsRouter = Router();

payoutsRouter.use(authenticate, enforceTenantIsolation);

// GET /payouts (list payouts)
payoutsRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const isAgent = user.role === 'SALES_AGENT';

  let agentProfileId: string | null = null;
  if (isAgent) {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { tenantId, userId: user.userId },
      select: { id: true },
    });
    agentProfileId = profile?.id || '__none__';
  }

  const payouts = await prisma.salesPayout.findMany({
    where: {
      tenantId,
      ...(agentProfileId ? { agentId: agentProfileId } : {}),
    },
    include: {
      agent: { select: { agentCode: true, user: { select: { displayName: true, email: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  res.json({
    ok: true,
    success: true,
    data: payouts,
    payouts,
  });
});

// GET /payouts/balance (summary of earnings and available balance)
payoutsRouter.get('/balance', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const isAgent = user.role === 'SALES_AGENT';

  let agentProfileId: string | null = null;
  if (isAgent) {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { tenantId, userId: user.userId },
      select: { id: true },
    });
    agentProfileId = profile?.id || null;
  }

  const [approvedPayouts, pendingPayouts, wonDeals] = await Promise.all([
    prisma.salesPayout.aggregate({
      where: {
        tenantId,
        status: 'PAID',
        ...(agentProfileId ? { agentId: agentProfileId } : {}),
      },
      _sum: { amount: true },
    }),
    prisma.salesPayout.aggregate({
      where: {
        tenantId,
        status: { in: ['REQUESTED', 'APPROVED'] },
        ...(agentProfileId ? { agentId: agentProfileId } : {}),
      },
      _sum: { amount: true },
    }),
    prisma.salesLeadAssignment.aggregate({
      where: {
        tenantId,
        stage: 'CLOSED_WON',
        ...(agentProfileId ? { assignedAgentId: agentProfileId } : {}),
      },
      _sum: { budgetAmount: true },
    }),
  ]);

  const totalWonRevenue = Number(wonDeals._sum?.budgetAmount || 0);
  const totalPaid = Number(approvedPayouts._sum?.amount || 0);
  const totalPending = Number(pendingPayouts._sum?.amount || 0);
  // Default closer commission is 20%
  const totalEarnedCommission = Math.round(totalWonRevenue * 0.20 * 100) / 100;
  const availableBalance = Math.max(0, Math.round((totalEarnedCommission - totalPaid - totalPending) * 100) / 100);

  res.json({
    ok: true,
    success: true,
    data: {
      totalEarnedCommission,
      totalPaid,
      totalPending,
      availableBalance,
    },
  });
});

// POST /payouts (request withdrawal)
payoutsRouter.post('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const { amount, note, agentId } = req.body;

  if (!amount || Number(amount) <= 0) {
    res.status(400).json({ ok: false, success: false, error: 'Valid amount is required' });
    return;
  }

  let targetAgentId = agentId;
  if (user.role === 'SALES_AGENT' || !targetAgentId) {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { tenantId, userId: user.userId },
      select: { id: true },
    });
    if (!profile) {
      res.status(403).json({ ok: false, success: false, error: 'Agent profile not found for user' });
      return;
    }
    targetAgentId = profile.id;
  }

  const payout = await prisma.salesPayout.create({
    data: {
      tenantId,
      agentId: targetAgentId,
      amount: Number(amount),
      status: 'REQUESTED',
      note: note || 'Requested from Closer Dashboard',
      requestedAt: new Date(),
    },
  });

  res.status(201).json({
    ok: true,
    success: true,
    data: payout,
    payout,
  });
});

// PATCH /payouts/:id/approve
payoutsRouter.patch('/:id/approve', requireRoles('ADMIN', 'SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const payoutId = String(req.params.id);
  const payout = await prisma.salesPayout.findFirst({
    where: { id: payoutId, tenantId },
  });

  if (!payout) {
    res.status(404).json({ ok: false, success: false, error: 'PayoutNotFound', message: 'Payout not found' });
    return;
  }

  // 1. State transition validation
  if (payout.status !== 'REQUESTED') {
    res.status(400).json({
      ok: false,
      success: false,
      error: 'InvalidStateTransition',
      message: `Only REQUESTED payouts can be approved. Current status: ${payout.status}`,
    });
    return;
  }

  // 2. Self-approval prevention
  const callerProfile = await prisma.salesAgentProfile.findFirst({
    where: { tenantId, userId: req.user!.userId },
  });
  if (callerProfile && payout.agentId === callerProfile.id) {
    res.status(403).json({
      ok: false,
      success: false,
      error: 'SelfApprovalForbidden',
      message: 'You cannot approve your own payout request. An independent administrator must review and approve.',
    });
    return;
  }

  const updated = await prisma.salesPayout.update({
    where: { id: payout.id },
    data: {
      status: 'PAID',
      approvedAt: new Date(),
      paidAt: new Date(),
    },
  });

  // 3. Audit actor logging
  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      actorUserId: req.user?.userId,
      action: 'PAYOUT_APPROVED',
      note: `Payout of ₹${payout.amount} approved by ${req.user?.displayName}`,
      metadata: { payoutId: payout.id, agentId: payout.agentId, amount: Number(payout.amount) },
    },
  }).catch(() => undefined);

  res.json({ ok: true, success: true, data: updated, payout: updated });
});

// PATCH /payouts/:id/reject
payoutsRouter.patch('/:id/reject', requireRoles('ADMIN', 'SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const payoutId = String(req.params.id);
  const { reason } = req.body;
  const payout = await prisma.salesPayout.findFirst({
    where: { id: payoutId, tenantId },
  });

  if (!payout) {
    res.status(404).json({ ok: false, success: false, error: 'PayoutNotFound', message: 'Payout not found' });
    return;
  }

  if (payout.status !== 'REQUESTED') {
    res.status(400).json({
      ok: false,
      success: false,
      error: 'InvalidStateTransition',
      message: `Only REQUESTED payouts can be rejected. Current status: ${payout.status}`,
    });
    return;
  }

  const updated = await prisma.salesPayout.update({
    where: { id: payout.id },
    data: {
      status: 'REJECTED',
      note: reason ? `${payout.note || ''} (Rejected: ${reason})` : payout.note,
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      actorUserId: req.user?.userId,
      action: 'PAYOUT_REJECTED',
      note: `Payout of ₹${payout.amount} rejected by ${req.user?.displayName}: ${reason || 'No reason provided'}`,
      metadata: { payoutId: payout.id, agentId: payout.agentId, reason },
    },
  }).catch(() => undefined);

  res.json({ ok: true, success: true, data: updated, payout: updated });
});
