import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';

export const reportsRouter = Router();

reportsRouter.use(authenticate, enforceTenantIsolation);

reportsRouter.get('/summary', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const [
    totalLeads,
    wonLeads,
    lostLeads,
    wonRevenue,
    pipelineRevenue,
    totalCalls,
    callDuration,
  ] = await Promise.all([
    prisma.salesLeadAssignment.count({ where: { tenantId } }),
    prisma.salesLeadAssignment.count({ where: { tenantId, stage: 'CLOSED_WON' } }),
    prisma.salesLeadAssignment.count({ where: { tenantId, stage: 'CLOSED_LOST' } }),
    prisma.salesLeadAssignment.aggregate({
      where: { tenantId, stage: 'CLOSED_WON' },
      _sum: { budgetAmount: true },
    }),
    prisma.salesLeadAssignment.aggregate({
      where: { tenantId, stage: { not: 'CLOSED_LOST' } },
      _sum: { budgetAmount: true },
    }),
    prisma.salesMobileCall.count({ where: { tenantId } }),
    prisma.salesMobileCall.aggregate({
      where: { tenantId },
      _sum: { durationSeconds: true },
    }),
  ]);

  const closedDealsCount = wonLeads + lostLeads;
  const winRatePercent = closedDealsCount > 0 ? Math.round((wonLeads / closedDealsCount) * 100) : 0;
  const totalCallSeconds = callDuration._sum?.durationSeconds || 0;
  const totalCallHours = Math.round((totalCallSeconds / 3600) * 10) / 10;

  res.json({
    success: true,
    data: {
      totalLeads,
      wonLeads,
      lostLeads,
      closedRevenue: Number(wonRevenue._sum?.budgetAmount || 0),
      pipelineRevenue: Number(pipelineRevenue._sum?.budgetAmount || 0),
      winRatePercent,
      totalCalls,
      totalCallHours,
    },
  });
});

reportsRouter.get('/closers', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const profiles = await prisma.salesAgentProfile.findMany({
    where: { tenantId },
    include: {
      user: {
        select: {
          id: true,
          displayName: true,
          email: true,
          phone: true,
        },
      },
      leadAssignments: {
        select: {
          id: true,
          stage: true,
          budgetAmount: true,
        },
      },
      mobileCalls: {
        select: {
          id: true,
          durationSeconds: true,
          status: true,
        },
      },
    },
  });

  const leaderboard = profiles.map((p) => {
    const totalLeads = p.leadAssignments.length;
    const wonLeads = p.leadAssignments.filter((a) => a.stage === 'CLOSED_WON').length;
    const lostLeads = p.leadAssignments.filter((a) => a.stage === 'CLOSED_LOST').length;
    const totalCalls = p.mobileCalls.length;
    const totalDurationSec = p.mobileCalls.reduce((acc, c) => acc + (c.durationSeconds || 0), 0);
    const closedRevenue = p.leadAssignments
      .filter((a) => a.stage === 'CLOSED_WON')
      .reduce((acc, a) => acc + Number(a.budgetAmount || 0), 0);
    const winRate = wonLeads + lostLeads > 0 ? Math.round((wonLeads / (wonLeads + lostLeads)) * 100) : 0;

    return {
      agentId: p.id,
      agentCode: p.agentCode,
      displayName: p.user?.displayName || 'Unknown Closer',
      email: p.user?.email,
      phone: p.user?.phone,
      totalLeads,
      wonLeads,
      totalCalls,
      totalDurationMinutes: Math.round(totalDurationSec / 60),
      closedRevenue,
      winRate,
    };
  });

  res.json({
    success: true,
    data: leaderboard,
  });
});
