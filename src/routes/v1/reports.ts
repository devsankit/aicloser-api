import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';

export const reportsRouter = Router();

reportsRouter.use(authenticate, enforceTenantIsolation);

const ACTIVE_STAGES = new Set([
  'NEW',
  'ASSIGNED',
  'CONTACTED',
  'INTERESTED',
  'FOLLOW_UP',
  'NEGOTIATION',
  'QUALIFIED',
  'QUOTE_SENT',
  'PAYMENT_PENDING',
]);

function dayKey(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(value);
}

function dateAtIndiaMidnight(value: string): Date {
  return new Date(value + 'T00:00:00+05:30');
}

function escapeCsvField(val: any): string {
  if (val === null || val === undefined) return '""';
  const str = String(val);
  return '"' + str.replace(/"/g, '""') + '"';
}

// 1. GET /summary & /overview
const getSummaryHandler = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;

  const dateFilter = from || to ? {
    createdAt: {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    }
  } : {};

  const [
    totalLeads,
    wonLeads,
    lostLeads,
    wonRevenue,
    pipelineRevenue,
    totalCalls,
    callDuration,
    leadsByStage,
    profiles,
    paymentLinks,
  ] = await Promise.all([
    prisma.salesLeadAssignment.count({ where: { tenantId, ...dateFilter } }),
    prisma.salesLeadAssignment.count({ where: { tenantId, stage: 'CLOSED_WON', ...dateFilter } }),
    prisma.salesLeadAssignment.count({ where: { tenantId, stage: 'CLOSED_LOST', ...dateFilter } }),
    prisma.salesLeadAssignment.aggregate({
      where: { tenantId, stage: 'CLOSED_WON', ...dateFilter },
      _sum: { budgetAmount: true },
    }),
    prisma.salesLeadAssignment.aggregate({
      where: { tenantId, stage: { not: 'CLOSED_LOST' }, ...dateFilter },
      _sum: { budgetAmount: true },
    }),
    prisma.salesMobileCall.count({ where: { tenantId, ...dateFilter } }),
    prisma.salesMobileCall.aggregate({
      where: { tenantId, ...dateFilter },
      _sum: { durationSeconds: true },
    }),
    prisma.salesLeadAssignment.groupBy({
      by: ['stage'],
      where: { tenantId, ...dateFilter },
      _count: { id: true },
    }),
    prisma.salesAgentProfile.findMany({
      where: { tenantId },
      include: {
        user: { select: { id: true, displayName: true, email: true, phone: true } },
        leadAssignments: { where: dateFilter, select: { id: true, stage: true, budgetAmount: true } },
        mobileCalls: { where: dateFilter, select: { id: true, durationSeconds: true } },
      },
      take: 20,
    }),
    prisma.upiPaymentLink.findMany({
      where: { tenantId },
      select: { createdByUserId: true, status: true, totalAmount: true },
    }),
  ]);

  const closedDealsCount = wonLeads + lostLeads;
  const winRatePercent = closedDealsCount > 0 ? Math.round((wonLeads / closedDealsCount) * 100) : 0;
  const totalCallSeconds = callDuration._sum?.durationSeconds || 0;
  const totalCallHours = Math.round((totalCallSeconds / 3600) * 10) / 10;

  // Real Pipeline Value = shared payment URLs pending client completion
  const pendingPaymentLinks = paymentLinks.filter(
    (pl) => pl.status === 'PENDING' || pl.status === 'CUSTOMER_CONFIRMED'
  );
  const paidPaymentLinks = paymentLinks.filter((pl) => pl.status === 'PAID');
  const paymentPendingRevenue = pendingPaymentLinks.reduce((sum, pl) => sum + Number(pl.totalAmount || 0), 0);
  const paymentClosedRevenue = paidPaymentLinks.reduce((sum, pl) => sum + Number(pl.totalAmount || 0), 0);

  const finalClosedRevenue = paymentClosedRevenue > 0 ? paymentClosedRevenue : Number(wonRevenue._sum?.budgetAmount || 0);
  const finalPipelineRevenue = paymentPendingRevenue > 0 ? paymentPendingRevenue : Number(pipelineRevenue._sum?.budgetAmount || 0);

  const funnelStages = ['NEW', 'CONTACTED', 'QUALIFIED', 'INTERESTED', 'FOLLOW_UP', 'NEGOTIATION', 'PAYMENT_PENDING', 'CLOSED_WON', 'CLOSED_LOST'];
  const stageCountMap = new Map(leadsByStage.map((s) => [s.stage, s._count.id]));
  const funnel = funnelStages.map((stage) => ({ stage, count: stageCountMap.get(stage as any) || 0 }));

  const leaderboard = profiles.map((p) => {
    const pTotalLeads = p.leadAssignments.length;
    const pWonLeads = p.leadAssignments.filter((a) => a.stage === 'CLOSED_WON').length;
    const pLostLeads = p.leadAssignments.filter((a) => a.stage === 'CLOSED_LOST').length;
    const pCalls = p.mobileCalls.length;
    const pDurationSec = p.mobileCalls.reduce((acc, c) => acc + (c.durationSeconds || 0), 0);
    const pRevenue = p.leadAssignments
      .filter((a) => a.stage === 'CLOSED_WON')
      .reduce((acc, a) => acc + Number(a.budgetAmount || 0), 0);
    const userPaidLinks = paidPaymentLinks.filter((pl) => pl.createdByUserId === p.user.id || pl.createdByUserId === p.id);
    const userWonRevenue = userPaidLinks.reduce((sum, pl) => sum + Number(pl.totalAmount || 0), 0);
    const finalUserRevenue = userWonRevenue > 0 ? userWonRevenue : pRevenue;
    const pWinRate = pWonLeads + pLostLeads > 0 ? Math.round((pWonLeads / (pWonLeads + pLostLeads)) * 100) : 0;

    return {
      agentId: p.id,
      agentCode: p.agentCode,
      displayName: p.user?.displayName || 'Closer',
      email: p.user?.email,
      totalLeads: pTotalLeads,
      wonLeads: pWonLeads,
      totalCalls: pCalls,
      totalDurationMinutes: Math.round(pDurationSec / 60),
      closedRevenue: finalUserRevenue,
      winRate: pWinRate,
    };
  });

  const payloadData = {
    totalLeads,
    wonLeads,
    lostLeads,
    closedRevenue: finalClosedRevenue,
    pipelineRevenue: finalPipelineRevenue,
    pendingPaymentLinksCount: pendingPaymentLinks.length,
    winRatePercent,
    totalCalls,
    totalCallHours,
    funnel,
    leaderboard,
  };

  res.json({
    success: true,
    ok: true,
    data: payloadData,
    funnel,
    leaderboard,
    error: null,
  });
};

reportsRouter.get('/summary', getSummaryHandler);
reportsRouter.get('/overview', getSummaryHandler);

// 2. GET /closers
reportsRouter.get('/closers', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { agentId } = req.query;

  const profiles = await prisma.salesAgentProfile.findMany({
    where: { tenantId, ...(agentId ? { id: String(agentId) } : {}) },
    include: {
      user: { select: { id: true, displayName: true, email: true, phone: true } },
      leadAssignments: { select: { id: true, stage: true, budgetAmount: true } },
      mobileCalls: { select: { id: true, durationSeconds: true, status: true } },
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
    error: null,
  });
});

// 3. POST & GET /custom (Custom reports with hourly call buckets, leaderboard, and source performance)
const customReportHandler = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const query = req.method === 'POST' ? req.body : req.query;
  const agentId = query.agentId ? String(query.agentId) : null;
  const from = query.from || query.dateFrom ? new Date(String(query.from || query.dateFrom)) : null;
  const to = query.to || query.dateTo ? new Date(String(query.to || query.dateTo)) : null;

  const dateFilter = from || to ? {
    startedAt: {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    }
  } : {};

  const leadDateFilter = from || to ? {
    createdAt: {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    }
  } : {};

  const [calls, leads, profiles] = await Promise.all([
    prisma.salesMobileCall.findMany({
      where: {
        tenantId,
        ...(agentId ? { agentId } : {}),
        ...dateFilter,
      },
      select: {
        id: true,
        agentId: true,
        durationSeconds: true,
        startedAt: true,
        status: true,
      },
    }),
    prisma.salesLeadAssignment.findMany({
      where: {
        tenantId,
        ...(agentId ? { assignedAgentId: agentId } : {}),
        ...leadDateFilter,
      },
      select: {
        id: true,
        assignedAgentId: true,
        source: true,
        stage: true,
        budgetAmount: true,
        createdAt: true,
      },
    }),
    prisma.salesAgentProfile.findMany({
      where: { tenantId, ...(agentId ? { id: agentId } : {}) },
      include: {
        user: { select: { displayName: true } },
      },
    }),
  ]);

  // Hourly buckets 0..23
  const hourlyBuckets = Array.from({ length: 24 }, (_, hour) => ({
    hour: hour + ':00',
    totalCalls: 0,
    connectedCalls: 0,
    totalDurationSeconds: 0,
    avgDurationSeconds: 0,
  }));

  for (const c of calls) {
    const callHour = new Date(c.startedAt).getHours();
    const bucket = hourlyBuckets[callHour];
    if (bucket) {
      bucket.totalCalls++;
      if (c.durationSeconds && c.durationSeconds > 0) {
        bucket.connectedCalls++;
        bucket.totalDurationSeconds += c.durationSeconds;
      }
    }
  }

  for (const b of hourlyBuckets) {
    b.avgDurationSeconds = b.connectedCalls > 0 ? Math.round(b.totalDurationSeconds / b.connectedCalls) : 0;
  }

  // Sources breakdown
  const sourceStatsMap = new Map<string, { source: string; totalLeads: number; wonLeads: number; revenue: number }>();
  for (const l of leads) {
    const src = l.source || 'Direct';
    if (!sourceStatsMap.has(src)) {
      sourceStatsMap.set(src, { source: src, totalLeads: 0, wonLeads: 0, revenue: 0 });
    }
    const stat = sourceStatsMap.get(src)!;
    stat.totalLeads++;
    if (l.stage === 'CLOSED_WON') {
      stat.wonLeads++;
      stat.revenue += Number(l.budgetAmount || 0);
    }
  }

  const sources = Array.from(sourceStatsMap.values()).map((s) => ({
    ...s,
    conversionRate: s.totalLeads > 0 ? Math.round((s.wonLeads / s.totalLeads) * 100) : 0,
  }));

  // Leaderboard
  const leaderboard = profiles.map((p) => {
    const agentLeads = leads.filter((l) => l.assignedAgentId === p.id);
    const agentCalls = calls.filter((c) => c.agentId === p.id);
    const won = agentLeads.filter((l) => l.stage === 'CLOSED_WON').length;
    const durSec = agentCalls.reduce((sum, c) => sum + (c.durationSeconds || 0), 0);

    return {
      agentId: p.id,
      name: p.user?.displayName || p.agentCode,
      totalLeads: agentLeads.length,
      wonLeads: won,
      totalCalls: agentCalls.length,
      totalDurationMinutes: Math.round(durSec / 60),
      avgCallSeconds: agentCalls.length > 0 ? Math.round(durSec / agentCalls.length) : 0,
      conversionRate: agentLeads.length > 0 ? Math.round((won / agentLeads.length) * 100) : 0,
    };
  });

  const responsePayload = {
    hourly: hourlyBuckets,
    leaderboard,
    sources,
    summary: {
      totalCalls: calls.length,
      totalLeads: leads.length,
      connectedCalls: calls.filter((c) => (c.durationSeconds || 0) > 0).length,
      totalRevenue: leads.filter((l) => l.stage === 'CLOSED_WON').reduce((sum, l) => sum + Number(l.budgetAmount || 0), 0),
    },
  };

  res.json({
    success: true,
    ok: true,
    data: responsePayload,
    ...responsePayload,
    error: null,
  });
};

reportsRouter.get('/custom', customReportHandler);
reportsRouter.post('/custom', customReportHandler);

// 4. GET /export (CSV export for leads, calls, contacts)
reportsRouter.get('/export', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const entity = String(req.query.type || req.query.entity || 'leads').toLowerCase();
  const format = String(req.query.format || 'csv').toLowerCase();
  const agentId = req.query.agentId ? String(req.query.agentId) : null;
  const isAgent = req.user?.role === 'SALES_AGENT';

  if (format !== 'csv') {
    res.status(400).json({ success: false, error: 'Only csv format is supported' });
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  if (entity === 'calls') {
    const calls = await prisma.salesMobileCall.findMany({
      where: {
        tenantId,
        ...(isAgent ? { agentId: req.user?.userId } : agentId ? { agentId } : {}),
      },
      include: {
        agent: { select: { agentCode: true, user: { select: { displayName: true } } } },
      },
      orderBy: { startedAt: 'desc' },
      take: 5000,
    });

    const headers = ['ID', 'Phone Number', 'Direction', 'Status', 'Duration (Seconds)', 'Started At', 'Closer Name', 'Agent Code', 'Outcome', 'Recording ID'];
    const rows = calls.map((c) => [
      c.id,
      c.phoneNumber,
      c.direction,
      c.status,
      c.durationSeconds ?? 0,
      c.startedAt.toISOString(),
      c.agent?.user?.displayName || 'Unknown',
      c.agent?.agentCode || '',
      c.outcome || '',
      c.recordingPath || (c.recordingStatus === 'UPLOADED' ? c.id : ''),
    ]);

    const csvContent = [
      headers.map(escapeCsvField).join(','),
      ...rows.map((r) => r.map(escapeCsvField).join(',')),
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="aicloser-calls-export-' + timestamp + '.csv"');
    res.send(csvContent);
    return;
  }

  if (entity === 'contacts') {
    const contacts = await prisma.marketingContact.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });

    const headers = ['ID', 'Full Name', 'Phone', 'Email', 'Source', 'Opt-In Status', 'Tags', 'Created At'];
    const rows = contacts.map((c) => [
      c.id,
      c.fullName,
      c.e164Phone,
      c.email || '',
      c.source || '',
      c.optInStatus || '',
      Array.isArray(c.tags) ? c.tags.join('; ') : '',
      c.createdAt.toISOString(),
    ]);

    const csvContent = [
      headers.map(escapeCsvField).join(','),
      ...rows.map((r) => r.map(escapeCsvField).join(',')),
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="aicloser-contacts-export-' + timestamp + '.csv"');
    res.send(csvContent);
    return;
  }

  // Default: leads
  let scopedAgentId = agentId;
  if (isAgent) {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { tenantId, userId: req.user!.userId },
      select: { id: true },
    });
    scopedAgentId = profile?.id || '__none__';
  }

  const leads = await prisma.salesLeadAssignment.findMany({
    where: {
      tenantId,
      ...(scopedAgentId ? { assignedAgentId: scopedAgentId } : {}),
    },
    include: {
      assignedAgent: { select: { agentCode: true, user: { select: { displayName: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });

  const headers = ['ID', 'Customer Name', 'Phone Number', 'Email', 'Source', 'Stage', 'Budget Amount', 'Priority', 'Assigned Closer', 'Created At', 'Last Contacted At'];
  const rows = leads.map((l) => [
    l.id,
    l.customerName,
    l.customerPhone || '',
    l.customerEmail || '',
    l.source,
    l.stage,
    l.budgetAmount ? Number(l.budgetAmount) : 0,
    l.priority,
    l.assignedAgent?.user?.displayName || l.assignedAgent?.agentCode || 'Unassigned',
    l.createdAt.toISOString(),
    l.lastContactedAt ? l.lastContactedAt.toISOString() : '',
  ]);

  const csvContent = [
    headers.map(escapeCsvField).join(','),
    ...rows.map((r) => r.map(escapeCsvField).join(',')),
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="aicloser-leads-export-' + timestamp + '.csv"');
  res.send(csvContent);
});

// 5. GET /responsibility (Complete Sales Responsibility Report for dashboard & responsibility UI)
reportsRouter.get('/responsibility', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const userRole = req.user?.role || 'SALES_AGENT';
  const userId = req.user?.userId;

  const range = (req.query.range as string) || 'today';
  const attention = (req.query.attention as string) || 'all';
  const source = req.query.source ? String(req.query.source) : null;
  const stage = req.query.stage ? String(req.query.stage) : null;
  const view = req.query.view === 'team' && ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(userRole) ? 'team' : 'mine';
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.max(10, Math.min(100, Number(req.query.pageSize) || 50));

  const allAgents = await prisma.salesAgentProfile.findMany({
    where: { tenantId, status: { not: 'SUSPENDED' } },
    include: { user: { select: { displayName: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const currentAgent = userId ? allAgents.find((a) => a.userId === userId) ?? null : null;
  const visibleAgents = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(userRole)
    ? allAgents
    : currentAgent ? [currentAgent] : [];

  const visibleAgentIds = visibleAgents.map((a) => a.id);
  const targetAgentId = req.query.agentId ? String(req.query.agentId) : null;
  const scopedAgentIds = view === 'mine' && currentAgent
    ? [currentAgent.id]
    : targetAgentId && visibleAgentIds.includes(targetAgentId)
      ? [targetAgentId]
      : visibleAgentIds;

  // Date range determination
  const todayStr = dayKey(new Date());
  const todayStart = dateAtIndiaMidnight(todayStr).getTime();
  const todayEnd = todayStart + 86400000;
  let fromDate: Date | null = null;
  let toDate: Date | null = null;

  if (range === 'today') {
    fromDate = new Date(todayStart);
    toDate = new Date(todayEnd);
  } else if (range === '7d') {
    fromDate = new Date(todayStart - 6 * 86400000);
    toDate = new Date(todayEnd);
  } else if (range === '30d') {
    fromDate = new Date(todayStart - 29 * 86400000);
    toDate = new Date(todayEnd);
  } else if (range === 'custom') {
    if (req.query.from) fromDate = new Date(String(req.query.from));
    if (req.query.to) toDate = new Date(String(req.query.to));
  }

  const assignments = await prisma.salesLeadAssignment.findMany({
    where: {
      tenantId,
      assignedAgentId: { in: scopedAgentIds.length ? scopedAgentIds : ['__none__'] },
      ...(source && source !== 'all' ? { source: { equals: source, mode: 'insensitive' } } : {}),
      ...(stage && stage !== 'all' ? { stage: stage as any } : {}),
    },
    include: {
      assignedAgent: { select: { id: true, agentCode: true, user: { select: { displayName: true } } } },
      deals: { select: { status: true, paidAmount: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const leadIds = assignments.map((l) => l.id);
  const tasks = leadIds.length > 0
    ? await prisma.gxLeadTask.findMany({
        where: { salesLeadId: { in: leadIds }, status: 'OPEN' },
        orderBy: { dueAt: 'asc' },
        select: { salesLeadId: true, title: true, dueAt: true, priority: true, status: true },
      })
    : [];

  const taskByLead = new Map<string, (typeof tasks)[number]>();
  for (const t of tasks) {
    if (!taskByLead.has(t.salesLeadId)) taskByLead.set(t.salesLeadId, t);
  }

  const now = Date.now();
  const rows = assignments.map((lead) => {
    const task = taskByLead.get(lead.id);
    const dueAt = task?.dueAt ?? lead.followUpAt;
    const dueTime = dueAt ? new Date(dueAt).getTime() : null;
    const stale = (!lead.lastContactedAt && now - lead.createdAt.getTime() > 86400000) || now - lead.updatedAt.getTime() > 3 * 86400000;
    const inPeriod = (!fromDate || lead.createdAt >= fromDate) && (!toDate || lead.createdAt < toDate);
    const dueToday = dueTime !== null && dueTime >= todayStart && dueTime < todayEnd;
    const overdue = dueTime !== null && dueTime < now;
    const missingFollowUp = ACTIVE_STAGES.has(lead.stage) && !dueAt;

    return {
      id: lead.id,
      customerName: lead.customerName,
      customerPhone: lead.customerPhone || '',
      customerEmail: lead.customerEmail || '',
      source: lead.source,
      segment: lead.segment || null,
      stage: lead.stage,
      conversationId: lead.conversationId,
      owner: lead.assignedAgent?.user?.displayName || 'Unassigned',
      ownerAgentId: lead.assignedAgentId,
      priority: lead.priority,
      lastContactedAt: lead.lastContactedAt ? lead.lastContactedAt.toISOString() : null,
      lastActivityAt: lead.updatedAt.toISOString(),
      followUpAt: dueAt ? dueAt.toISOString() : null,
      nextAction: task?.title || (dueAt ? 'Follow up' : 'Add next action'),
      untouched: !lead.lastContactedAt,
      stale,
      paused: false,
      dueToday,
      overdue,
      missingFollowUp,
      period: inPeriod,
      app: {
        audience: null,
        workspaceRegistered: true,
        appInstalled: false,
        onboardingStage: null,
        billingState: 'UNKNOWN',
        paid: false,
        trialExpiresAt: null,
      },
      capi: { state: 'NOT_SENT', eventName: null, lastError: null },
    };
  });

  const periodRows = range === 'all' ? rows : rows.filter((r) => r.period);
  const attentionFiltered = attention === 'all'
    ? periodRows
    : rows.filter((r) => {
        if (attention === 'due_today') return r.dueToday;
        if (attention === 'overdue') return r.overdue;
        if (attention === 'untouched') return r.untouched;
        if (attention === 'missing_follow_up') return r.missingFollowUp;
        return r.paused;
      });

  const total = attentionFiltered.length;
  const pages = Math.ceil(total / pageSize) || 1;
  const pageStart = (page - 1) * pageSize;
  const paginatedLeads = attentionFiltered.slice(pageStart, pageStart + pageSize);

  // Exceptions list (top 100 urgent leads)
  const exceptions = rows
    .filter((r) => r.overdue || r.dueToday || r.untouched || r.missingFollowUp)
    .map((r) => ({
      ...r,
      reason: r.overdue ? 'OVERDUE' : r.dueToday ? 'DUE_TODAY' : r.untouched ? 'NEVER_CONTACTED' : 'MISSING_FOLLOW_UP',
    }))
    .slice(0, 100);

  // Team summary breakdown
  const teamStats = visibleAgents.map((agent) => {
    const aRows = rows.filter((r) => r.ownerAgentId === agent.id);
    const assigned = aRows.length;
    const dueTodayCount = aRows.filter((r) => r.dueToday).length;
    const overdueCount = aRows.filter((r) => r.overdue).length;
    const untouchedCount = aRows.filter((r) => r.untouched).length;
    const missingFupCount = aRows.filter((r) => r.missingFollowUp).length;
    const contactedCount = aRows.filter((r) => !r.untouched).length;
    const closedCount = aRows.filter((r) => r.stage === 'CLOSED_WON').length;
    const responseRate = assigned > 0 ? Math.round((contactedCount / assigned) * 100) : 0;
    const convRate = assigned > 0 ? Math.round((closedCount / assigned) * 100) : 0;

    return {
      agentId: agent.id,
      name: agent.user?.displayName || 'Closer',
      group: null,
      assigned,
      dueToday: dueTodayCount,
      overdue: overdueCount,
      untouched: untouchedCount,
      missingFollowUp: missingFupCount,
      responseRate,
      closed: closedCount,
      conversionRate: convRate,
    };
  });

  const funnelStages = ['NEW', 'CONTACTED', 'QUALIFIED', 'INTERESTED', 'FOLLOW_UP', 'NEGOTIATION', 'PAYMENT_PENDING', 'CLOSED_WON', 'LOST'];
  const funnel = funnelStages.map((st) => ({
    stage: st,
    count: periodRows.filter((r) => r.stage === st).length,
  }));

  const sourceCountMap = new Map<string, number>();
  for (const r of periodRows) {
    const s = r.source || 'Direct';
    sourceCountMap.set(s, (sourceCountMap.get(s) || 0) + 1);
  }
  const sourceCounts = Array.from(sourceCountMap.entries()).map(([src, cnt]) => ({ source: src, count: cnt }));

  const summary = {
    assigned: rows.length,
    unassigned: 0,
    dueToday: rows.filter((r) => r.dueToday).length,
    overdue: rows.filter((r) => r.overdue).length,
    untouched: rows.filter((r) => r.untouched).length,
    stale: rows.filter((r) => r.stale).length,
    missingFollowUp: rows.filter((r) => r.missingFollowUp).length,
    paused: 0,
    conversionRate: rows.length > 0 ? Math.round((rows.filter((r) => r.stage === 'CLOSED_WON').length / rows.length) * 100) : 0,
  };

  const reportPayload = {
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Kolkata',
    summary,
    team: teamStats,
    exceptions,
    leads: paginatedLeads,
    pagination: { page, pageSize, total, pages },
    funnel,
    sourceCounts,
    trend: [],
    billing: { paid: 0, trial: 0, trialExpired: 0, paymentPending: 0, free: 0, unknown: rows.length },
    capi: { sent: 0, pending: 0, failed: 0, notSent: rows.length },
  };

  res.json({
    success: true,
    ok: true,
    report: reportPayload,
    reports: reportPayload,
    data: reportPayload,
    funnel,
    leaderboard: teamStats,
    error: null,
  });
});
