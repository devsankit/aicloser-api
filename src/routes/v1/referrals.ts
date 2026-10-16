import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';

export const referralsRouter = Router();

referralsRouter.use(authenticate, enforceTenantIsolation);

// GET /referrals (list referral codes)
referralsRouter.get('/', async (req: Request, res: Response) => {
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

  const referralCodes = await prisma.salesReferralCode.findMany({
    where: {
      tenantId,
      ...(agentProfileId ? { agentId: agentProfileId } : {}),
    },
    include: {
      agent: { select: { agentCode: true, user: { select: { displayName: true } } } },
      events: { take: 10, orderBy: { createdAt: 'desc' } },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    ok: true,
    success: true,
    data: referralCodes,
    referrals: referralCodes,
  });
});

// POST /referrals (create referral code)
referralsRouter.post('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const { code, label, agentId } = req.body;

  if (!code) {
    res.status(400).json({ ok: false, success: false, error: 'Code is required' });
    return;
  }

  const cleanCode = String(code).trim().toUpperCase();

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

  const created = await prisma.salesReferralCode.create({
    data: {
      tenantId,
      agentId: targetAgentId,
      code: cleanCode,
      label: label || `Closer Referral Code ${cleanCode}`,
      isActive: true,
    },
  });

  res.status(201).json({
    ok: true,
    success: true,
    data: created,
    referral: created,
  });
});

// GET /referrals/stats (summary statistics)
referralsRouter.get('/stats', async (req: Request, res: Response) => {
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

  const [totalCodes, activeCodes, totalEvents] = await Promise.all([
    prisma.salesReferralCode.count({
      where: { tenantId, ...(agentProfileId ? { agentId: agentProfileId } : {}) },
    }),
    prisma.salesReferralCode.count({
      where: { tenantId, isActive: true, ...(agentProfileId ? { agentId: agentProfileId } : {}) },
    }),
    prisma.salesReferralEvent.count({
      where: { tenantId, ...(agentProfileId ? { agentId: agentProfileId } : {}) },
    }),
  ]);

  res.json({
    ok: true,
    success: true,
    data: {
      totalCodes,
      activeCodes,
      totalEvents,
    },
  });
});
