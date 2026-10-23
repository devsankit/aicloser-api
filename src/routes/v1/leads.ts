import { upsertCompanyLead, normalizePhoneNumber } from '../../lib/lead-upsert-pipeline.js';
import * as XLSX from 'xlsx';
import { logger } from '../../lib/logger.js';
import { maskPhoneNumber, isPhoneMaskingRequired } from '../../lib/phone-mask.js';
import { assignLeadToNextCloser } from '../../lib/lead-assignment-engine.js';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { Prisma } from '@prisma/client';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { SalesLeadStage, salesLeadStageSchema, SALES_LEAD_STAGES } from '../../types/leads.js';
import { hasPermission, requirePermissions, PERM_LEADS_CLAIM, PERM_LEADS_REASSIGN } from '../../middlewares/rbac.js';
import { persistApiRealtimeEvent } from '../../lib/realtime.js';
import { syncMarketingContactForLead, normalizeLeadPhone, deleteContactsAndLinkedLeadsTransactional, syncLeadConversationAssignment } from '../../lib/lead-contact-sync.js';
import { getWorkspaceScope, checkSameReportingTeam } from '../../lib/workspace-scope.js';
import { getWorkspaceStages } from './stages.js';
import { syncAndRotatePoolSlots, recordPoolLeadClaimedByPeer, type MissedLeadRecord } from '../../lib/grab-pool-rotation.js';

export const leadsRouter = Router();

// Apply auth and tenant isolation to all lead routes
leadsRouter.use(authenticate, enforceTenantIsolation);

const listLeadsQuerySchema = z.object({
  page: z.string().optional().transform((v) => (v ? Math.max(1, Number(v)) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(1000, Math.max(1, Number(v))) : 50)),
  stage: salesLeadStageSchema.optional(),
  status: salesLeadStageSchema.optional(),
  search: z.string().optional(),
  assignedAgentId: z.string().optional(),
  sortBy: z.enum(['kanbanPosition', 'createdAt', 'updatedAt', 'followUpAt', 'budgetAmount']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

leadsRouter.get('/', validateQuery(listLeadsQuerySchema), async (req: Request, res: Response) => {
  const { page, limit, stage, search, assignedAgentId } = req.query as unknown as {
    page: number;
    limit: number;
    stage?: SalesLeadStage;
    search?: string;
    assignedAgentId?: string;
  };

  const tenantId = req.tenantId!;

  // Strict tenant-scoped WHERE clause
  const where: Record<string, unknown> = {
    tenantId,
  };

  if (stage) {
    where.stage = stage;
  } else {
    where.stage = { not: 'RECYCLED' };
  }

  // Admins see the tenant; managers see their reporting team; closers see
  // strictly only their own assigned leads.
  const authUser = req.user;
  if (authUser && (authUser.role === 'SALES_AGENT' || (authUser.role as any) === 'CLOSER')) {
    const scope = await getWorkspaceScope(tenantId, authUser);
    where.assignedAgentId = scope.profileIds.length === 1 ? scope.profileIds[0] : { in: scope.profileIds.length ? scope.profileIds : ['__NO_ACCESS__'] };
  } else if (authUser && authUser.role === 'MANAGER') {
    const scope = await getWorkspaceScope(tenantId, authUser);
    where.assignedAgentId = { in: scope.profileIds.length ? scope.profileIds : ['__NO_ACCESS__'] };
  } else if (assignedAgentId) {
    where.assignedAgentId = assignedAgentId;
  }

  if (search) {
    const trimmed = search.trim();
    const digitsOnly = trimmed.replace(/\D/g, '');
    const phoneVariation = trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
    const orConditions: any[] = [
      { customerName: { contains: trimmed, mode: 'insensitive' } },
      { customerPhone: { contains: trimmed } },
      { customerPhone: { contains: phoneVariation } },
      { customerEmail: { contains: trimmed, mode: 'insensitive' } },
    ];
    if (digitsOnly.length >= 7) {
      orConditions.push({ customerPhone: { contains: digitsOnly } });
      orConditions.push({ customerPhone: { contains: `+91${digitsOnly.slice(-10)}` } });
      orConditions.push({ customerPhone: { contains: digitsOnly.slice(-10) } });
    }
    where.OR = orConditions;
  }

  const [total, leads] = await Promise.all([
    prisma.salesLeadAssignment.count({ where }),
    prisma.salesLeadAssignment.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: (req.query as any).sortBy === 'createdAt' ? [{ createdAt: ((req.query as any).sortOrder || 'desc') as 'asc' | 'desc' }] : [{ kanbanPosition: 'asc' as const }, { createdAt: 'desc' as const }],
      include: {
        assignedAgent: {
          select: {
            id: true,
            agentCode: true,
            user: { select: { displayName: true, email: true, phone: true } },
          },
        },
      },
    }),
  ]);

  // Fetch active UpiPaymentLink records for returned leads to sync payment amounts and status
  const leadIds = leads.map((l) => l.id);
  const phoneList = Array.from(new Set(leads.map((l) => l.customerPhone).filter(Boolean))) as string[];

  const paymentLinks = (leadIds.length > 0 || phoneList.length > 0)
    ? await prisma.upiPaymentLink.findMany({
        where: {
          tenantId,
          OR: [
            ...(phoneList.length > 0 ? [{ customerPhone: { in: phoneList } }] : []),
            ...(leadIds.map((lid) => ({ customFields: { path: ['leadId'], equals: lid } }))),
          ],
        },
        orderBy: { createdAt: 'desc' },
      })
    : [];

  const paymentByLeadId = new Map<string, (typeof paymentLinks)[0]>();
  const paymentByPhone = new Map<string, (typeof paymentLinks)[0]>();

  for (const pl of paymentLinks) {
    const linkedLeadId = (pl.customFields as any)?.leadId;
    if (linkedLeadId && !paymentByLeadId.has(linkedLeadId)) {
      paymentByLeadId.set(linkedLeadId, pl);
    }
    if (pl.customerPhone && !paymentByPhone.has(pl.customerPhone)) {
      paymentByPhone.set(pl.customerPhone, pl);
    }
  }

  // Check workspace security setting for phone masking
  const wsForMask = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const shouldMask = isPhoneMaskingRequired(req.user, wsForMask?.settings as Record<string, any>);

  const sanitizedLeads = leads.map((l) => {
    const pl = paymentByLeadId.get(l.id) || (l.customerPhone ? paymentByPhone.get(l.customerPhone) : null);
    const rawBudget = Number(l.budgetAmount || 0);
    const effectiveBudget = (rawBudget === 0 && pl) ? Number(pl.totalAmount) : rawBudget;

    return {
      ...l,
      budgetAmount: effectiveBudget,
      paymentStatus: pl?.status || null,
      paymentAmount: pl ? Number(pl.totalAmount) : null,
      paymentLink: pl?.publicToken ? `/pay/${pl.publicToken}` : null,
      customerPhone: shouldMask ? maskPhoneNumber(l.customerPhone, true) : l.customerPhone,
    };
  });

  res.json({
    success: true,
    data: sanitizedLeads,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    error: null,
  });
});

const leadStageInputSchema = z
  .string()
  .optional()
  .transform((v): SalesLeadStage => {
    if (!v) return 'NEW';
    const s = v.toUpperCase().replace(/[\s-]+/g, '_');
    if (s === 'WON') return 'CLOSED_WON';
    if (s === 'IN_PROGRESS' || s === 'PROGRESS') return 'CONTACTED';
    if (s === 'DEMO') return 'QUALIFIED';
    if (s === 'CALL_SCHEDULED') return 'FOLLOW_UP';
    if ((SALES_LEAD_STAGES as readonly string[]).includes(s)) return s as SalesLeadStage;
    return 'NEW';
  });

const leadFollowUpInputSchema = z
  .string()
  .nullable()
  .optional()
  .transform((v) => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  });

const createLeadSchema = z.object({
  customerName: z.string().min(1, 'Customer name is required'),
  customerPhone: z.string().min(5, 'Phone number is required'),
  customerEmail: z.string().email().optional().or(z.literal('')).transform((v) => v || undefined),
  assignedAgentId: z.string().optional(),
  serviceInterest: z.string().optional(),
  segment: z.string().optional(),
  priority: z.string().default('normal'),
  notes: z.string().optional(),
  stage: leadStageInputSchema.default('NEW'),
  budgetAmount: z.number().optional(),
  source: z.string().optional(),
  followUpAt: leadFollowUpInputSchema,
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.unknown()).optional(),
});

leadsRouter.post('/', validateBody(createLeadSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body;

  // Resolve assigned agent: explicit ID -> caller profile -> first active agent -> auto-created agent profile
  let agent = body.assignedAgentId ? await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      OR: [
        { id: body.assignedAgentId },
        { userId: body.assignedAgentId },
      ],
    },
  }) : null;

  if (!agent && req.user?.userId) {
    agent = await prisma.salesAgentProfile.findFirst({
      where: {
        tenantId,
        userId: req.user.userId,
      },
    });
  }

  if (!agent) {
    agent = await prisma.salesAgentProfile.findFirst({
      where: {
        tenantId,
        status: 'ACTIVE',
      },
    });
  }

  if (!agent && req.user?.userId) {
    // Auto-create agent profile for workspace user if none exists
    const agentCode = `AG-${Math.floor(1000 + Math.random() * 9000)}`;
    agent = await prisma.salesAgentProfile.create({
      data: {
        tenantId,
        userId: req.user.userId,
        agentCode,
        status: 'ACTIVE',
        canClaimLeads: true,
      },
    });
  }

  if (!agent) {
    res.status(400).json({
      success: false,
      error: 'InvalidAgent',
      message: 'No active sales agent profile found in workspace',
    });
    return;
  }

  // Tenant-scoped deduplication check: prevent duplicate leads for the same phone number
  const rawPhone = body.customerPhone?.trim() || "";
  const cleanDigits = rawPhone.replace(/\D/g, "");
  const last10 = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;

  if (last10 && last10.length >= 7) {
    const existing = await prisma.salesLeadAssignment.findFirst({
      where: {
        tenantId,
        OR: [
          { customerPhone: body.customerPhone },
          { customerPhone: { contains: last10 } },
          ...(body.customerEmail ? [{ customerEmail: body.customerEmail }] : []),
        ],
      },
      orderBy: [{ stage: 'desc' }, { createdAt: 'asc' }],
    });

    if (existing) {
      // Enrich existing lead with any new notes / metadata without creating a duplicate row
      const updated = await prisma.salesLeadAssignment.update({
        where: { id: existing.id },
        data: {
          lastContactedAt: new Date(),
          ...(body.notes ? { notes: existing.notes ? (existing.notes + "\n---\n" + body.notes) : body.notes } : {}),
          ...(body.budgetAmount ? { budgetAmount: body.budgetAmount } : {}),
        },
      });

      await syncMarketingContactForLead(updated).catch(() => undefined);

      await prisma.salesActivityLog.create({
        data: {
          tenantId,
          assignmentId: existing.id,
          actorUserId: req.user?.userId,
          action: "LEAD_DEDUPLICATED",
          note: "Incoming lead for " + body.customerName + " (" + body.customerPhone + ") deduplicated against existing lead ID " + existing.id,
        },
      });

      res.status(200).json({
        success: true,
        deduplicated: true,
        message: "Lead already exists for this phone number in your workspace and was updated.",
        data: updated,
        error: null,
      });
      return;
    }
  }

  let lead;
  try {
    lead = await prisma.salesLeadAssignment.create({
      data: {
        tenantId, // Root ownership strictly enforced
        customerName: body.customerName,
        customerPhone: body.customerPhone,
        customerEmail: body.customerEmail,
        assignedAgentId: agent.id, // canonicalized profile ID
        createdById: req.user?.userId,
        serviceInterest: body.serviceInterest,
        segment: body.segment,
        priority: body.priority,
        notes: body.notes,
        stage: body.stage,
        budgetAmount: body.budgetAmount,
        source: body.source || 'manual',
        followUpAt: body.followUpAt ? new Date(body.followUpAt) : null,
        tags: body.tags || [],
        customFields: body.customFields || {},
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002' || err?.message?.includes('idx_salesleadassignment_tenant_phone')) {
      // Race-condition resilience: return existing record if concurrently inserted
      const existing = await prisma.salesLeadAssignment.findFirst({
        where: { tenantId, customerPhone: body.customerPhone },
      });
      if (existing) {
        res.status(200).json({
          success: true,
          data: existing,
          deduplicated: true,
          message: 'Lead already exists in workspace; enriched existing record',
          error: null,
        });
        return;
      }
    }
    throw err;
  }

  // Also log activity log under this tenant
  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: lead.id,
      actorUserId: req.user?.userId,
      action: 'LEAD_CREATED',
      note: `Lead created manually for ${body.customerName}`,
    },
  });

  await syncMarketingContactForLead(lead).catch(() => undefined);

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.created',
    payload: lead,
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.status(201).json({ success: true, data: lead, error: null });
});

// GET /pipeline-bootstrap - Consolidated Single-Shot Board & Pipeline Aggregate
leadsRouter.get('/pipeline-bootstrap', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const tenantId = req.tenantId!;
  const user = req.user!;

  // 1. Compute access scope
  const where: any = { tenantId };
  let scopeProfileIds: string[] | null = null;
  if (user.role === 'SALES_AGENT' || (user.role as any) === 'CLOSER') {
    const scope = await getWorkspaceScope(tenantId, user);
    scopeProfileIds = scope.profileIds.length ? scope.profileIds : ['__NO_ACCESS__'];
    where.assignedAgentId = scope.profileIds.length === 1 ? scope.profileIds[0] : { in: scopeProfileIds };
  } else if (user.role === 'MANAGER') {
    const scope = await getWorkspaceScope(tenantId, user);
    scopeProfileIds = scope.profileIds;
    where.assignedAgentId = { in: scope.profileIds.length ? scope.profileIds : ['__NO_ACCESS__'] };
  } else if (req.query.assignedAgentId) {
    where.assignedAgentId = String(req.query.assignedAgentId);
  }

  if (req.query.stage) {
    where.stage = String(req.query.stage);
  } else {
    where.stage = { not: 'RECYCLED' };
  }

  const limitParam = req.query.limit ? Number(req.query.limit) : 250;
  const leadLimit = Math.min(500, Math.max(1, isNaN(limitParam) ? 250 : limitParam));
  const maxVisibleToCloser = req.query.maxVisibleToCloser
    ? Math.min(50, Math.max(1, isNaN(Number(req.query.maxVisibleToCloser)) ? 5 : Number(req.query.maxVisibleToCloser)))
    : 5;

  // 2. Run all sub-queries concurrently in parallel
  const [
    rawLeads,
    stageAggregates,
    workspaceStages,
    workspaceAgents,
    activeLeadCounts,
    totalAvailablePool,
    topPoolItems,
    workspaceInfo,
  ] = await Promise.all([
    // A. Leads
    prisma.salesLeadAssignment.findMany({
      where,
      take: leadLimit,
      orderBy: [{ kanbanPosition: 'asc' }, { createdAt: 'desc' }],
      include: {
        assignedAgent: {
          select: {
            id: true,
            agentCode: true,
            user: { select: { displayName: true, email: true, phone: true } },
          },
        },
      },
    }),

    // B. Stages aggregation (Count & Total Value)
    prisma.salesLeadAssignment.groupBy({
      by: ['stage'],
      where: {
        tenantId,
        stage: { not: 'RECYCLED' },
        ...(scopeProfileIds ? { assignedAgentId: { in: scopeProfileIds.length ? scopeProfileIds : ['__NO_ACCESS__'] } } : {}),
      },
      _count: { id: true },
      _sum: { budgetAmount: true },
    }),

    // C. Workspace Stages configuration
    getWorkspaceStages(tenantId),

    // D. Workspace Closers / Sales Agents
    prisma.salesAgentProfile.findMany({
      where: { tenantId, status: 'ACTIVE' },
      include: {
        user: { select: { displayName: true, email: true, phone: true, role: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),

    // E. Active leads count per closer (excluding closed deals)
    prisma.salesLeadAssignment.groupBy({
      by: ['assignedAgentId'],
      where: {
        tenantId,
        stage: { notIn: ['CLOSED_WON', 'CLOSED_LOST', 'RECYCLED'] },
      },
      _count: { id: true },
    }),

    // F. Total available pool count
    prisma.salesLeadPoolItem.count({
      where: { tenantId, status: 'OPEN' },
    }),

    // G. Top unassigned pool items clamped to maxVisibleToCloser
    prisma.salesLeadPoolItem.findMany({
      where: { tenantId, status: 'OPEN' },
      take: maxVisibleToCloser,
      orderBy: { createdAt: 'desc' },
    }),

    // H. Workspace phone masking setting
    prisma.aicloserWorkspace.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    }),
  ]);

  // Fetch active UpiPaymentLink records for returned leads
  const leadIds = rawLeads.map((l) => l.id);
  const phoneList = Array.from(new Set(rawLeads.map((l) => l.customerPhone).filter(Boolean))) as string[];

  const paymentLinks = (leadIds.length > 0 || phoneList.length > 0)
    ? await prisma.upiPaymentLink.findMany({
        where: {
          tenantId,
          OR: [
            ...(phoneList.length > 0 ? [{ customerPhone: { in: phoneList } }] : []),
            ...(leadIds.map((lid) => ({ customFields: { path: ['leadId'], equals: lid } }))),
          ],
        },
        orderBy: { createdAt: 'desc' },
      })
    : [];

  const paymentByLeadId = new Map<string, (typeof paymentLinks)[0]>();
  const paymentByPhone = new Map<string, (typeof paymentLinks)[0]>();

  for (const pl of paymentLinks) {
    const linkedLeadId = (pl.customFields as any)?.leadId;
    if (linkedLeadId && !paymentByLeadId.has(linkedLeadId)) {
      paymentByLeadId.set(linkedLeadId, pl);
    }
    if (pl.customerPhone && !paymentByPhone.has(pl.customerPhone)) {
      paymentByPhone.set(pl.customerPhone, pl);
    }
  }

  // 3. Format Leads (with optional phone masking and synchronized payment/deal values)
  const shouldMask = isPhoneMaskingRequired(user, workspaceInfo?.settings as Record<string, any>);
  const leads = rawLeads.map((l) => {
    const customFields = (l.customFields && typeof l.customFields === 'object' && !Array.isArray(l.customFields))
      ? (l.customFields as Record<string, any>)
      : {};
    const company = customFields.company || customFields.organization || customFields.businessName || '';
    const code = customFields.code || l.leadId || `LD-${l.id.slice(-6).toUpperCase()}`;

    const pl = paymentByLeadId.get(l.id) || (l.customerPhone ? paymentByPhone.get(l.customerPhone) : null);
    const rawBudget = Number(l.budgetAmount || 0);
    const effectiveBudget = (rawBudget === 0 && pl) ? Number(pl.totalAmount) : rawBudget;

    return {
      id: l.id,
      code,
      customerName: l.customerName,
      customerPhone: shouldMask ? maskPhoneNumber(l.customerPhone, true) : (l.customerPhone || ''),
      customerEmail: l.customerEmail || '',
      company,
      stage: l.stage,
      priority: l.priority || 'MEDIUM',
      budgetAmount: effectiveBudget,
      paymentStatus: pl?.status || null,
      paymentAmount: pl ? Number(pl.totalAmount) : null,
      paymentLink: pl?.publicToken ? `/pay/${pl.publicToken}` : null,
      source: l.source || 'MANUAL',
      tags: l.tags || [],
      followUpAt: l.followUpAt ? l.followUpAt.toISOString() : null,
      aiScore: l.aiScore ?? 50,
      aiSentiment: l.aiSentiment || null,
      aiSummary: l.aiSummary || null,
      owner: l.assignedAgent?.user?.displayName || l.assignedAgent?.agentCode || 'Unassigned',
      ownerId: l.assignedAgentId || null,
      kanbanPosition: l.kanbanPosition ?? 0,
      conversationId: l.conversationId || null,
      totalCallsCount: l.totalCallsCount ?? 0,
      lastContactedAt: l.lastContactedAt ? l.lastContactedAt.toISOString() : null,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    };
  });

  // 4. Format Stages with Aggregated Counts and Values
  const stageStatsMap = new Map<string, { count: number; totalValue: number }>();
  for (const agg of stageAggregates) {
    stageStatsMap.set(agg.stage, {
      count: agg._count?.id ?? 0,
      totalValue: Number(agg._sum?.budgetAmount ?? 0),
    });
  }

  // Adjust stage totals if leads had 0 DB budget but have active payment links
  for (const l of leads) {
    const dbBudget = Number(rawLeads.find((rl) => rl.id === l.id)?.budgetAmount || 0);
    if (dbBudget === 0 && l.budgetAmount > 0) {
      const stats = stageStatsMap.get(l.stage);
      if (stats) {
        stats.totalValue += l.budgetAmount;
      }
    }
  }

  const stages = workspaceStages.map((s) => {
    const stats = stageStatsMap.get(s.key) || stageStatsMap.get(s.id) || { count: 0, totalValue: 0 };
    return {
      id: s.id,
      key: s.key,
      label: s.label,
      color: s.color,
      probability: s.probability,
      position: s.position,
      count: stats.count,
      totalValue: stats.totalValue,
      weightedValue: Math.round(stats.totalValue * s.probability),
    };
  });

  // 5. Format Closers with active workload
  const countByCloser = new Map(
    activeLeadCounts.map((c) => [c.assignedAgentId, typeof c._count === 'object' && c._count ? (c._count.id ?? 0) : 0])
  );
  const closers = workspaceAgents.map((agent) => ({
    id: agent.id,
    name: agent.user?.displayName || agent.agentCode || 'Closer',
    email: agent.user?.email || null,
    phone: agent.user?.phone || null,
    role: agent.user?.role || 'SALES_AGENT',
    activeLeads: countByCloser.get(agent.id) ?? 0,
    maxCapacity: agent.maxActiveLeads ?? 15,
    canClaimLeads: agent.canClaimLeads ?? true,
    status: agent.status,
  }));

  // 6. Format Pool
  const pool = {
    totalCount: totalAvailablePool,
    maxVisibleToCloser,
    items: topPoolItems.map((p) => ({
      id: p.id,
      customerName: p.customerName,
      customerPhone: shouldMask ? maskPhoneNumber(p.customerPhone, true) : (p.customerPhone || ''),
      customerEmail: p.customerEmail || '',
      source: p.source || 'MANUAL',
      budgetAmount: Number(p.budgetAmount || 0),
      priority: p.priority || 'MEDIUM',
      notes: p.notes || '',
      status: p.status,
      createdAt: p.createdAt.toISOString(),
    })),
  };

  const elapsedMs = Date.now() - startTime;
  res.json({
    success: true,
    data: {
      leads,
      stages,
      closers,
      pool,
      meta: {
        totalLeads: leads.length,
        leadLimit,
        elapsedMs,
      },
    },
    error: null,
  });
});

leadsRouter.get('/pipeline-aggregates', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const where: any = { tenantId };

  // Pipeline totals must use the same visibility scope as the lead list.
  // Otherwise a newly-created sales user sees workspace totals on Dashboard
  // while Kanban correctly shows only their assigned leads.
  if (req.user?.role === 'SALES_AGENT' || req.user?.role === 'MANAGER') {
    const scope = await getWorkspaceScope(tenantId, req.user);
    where.assignedAgentId = { in: scope.profileIds.length ? scope.profileIds : ['__NO_ACCESS__'] };
  }

  const aggregates = await prisma.salesLeadAssignment.groupBy({
    by: ['stage'],
    where,
    _count: { id: true },
    _sum: { budgetAmount: true },
  });

  const stageProbabilities: Record<string, number> = {
    NEW: 0.1,
    CONTACTED: 0.2,
    IN_PROGRESS: 0.35,
    DEMO_SCHEDULED: 0.5,
    FOLLOW_UP: 0.6,
    NEGOTIATION: 0.8,
    CLOSED_WON: 1.0,
    CLOSED_LOST: 0.0,
  };

  const results = aggregates.map((item) => {
    const count = item._count?.id ?? 0;
    const totalValue = Number(item._sum?.budgetAmount ?? 0);
    const winProb = stageProbabilities[item.stage] ?? 0.2;
    const weightedValue = Math.round(totalValue * winProb);
    return {
      stage: item.stage,
      count,
      totalValue,
      weightedValue,
    };
  });

  res.json({ success: true, data: results });
});

// GET /dashboard-summary - Permission-scoped aggregated totals for dashboard KPIs
leadsRouter.get('/dashboard-summary', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const where: any = { tenantId };

  if (req.user?.role === 'SALES_AGENT' || req.user?.role === 'MANAGER') {
    const scope = await getWorkspaceScope(tenantId, req.user);
    where.assignedAgentId = { in: scope.profileIds.length ? scope.profileIds : ['__NO_ACCESS__'] };
  } else if (req.query.assignedAgentId) {
    where.assignedAgentId = String(req.query.assignedAgentId);
  }

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const paymentLinkWhere: any = { tenantId };
  if (req.user?.role === 'SALES_AGENT') {
    paymentLinkWhere.createdByUserId = req.user.userId;
  }

  const [
    totalLeads,
    hotLeads,
    followUpsToday,
    followUpsPending,
    stageAggregates,
    paymentLinks,
  ] = await Promise.all([
    prisma.salesLeadAssignment.count({ where }),
    prisma.salesLeadAssignment.count({
      where: {
        ...where,
        priority: { in: ['HIGH', 'URGENT'] },
      },
    }),
    prisma.salesLeadAssignment.count({
      where: {
        ...where,
        followUpAt: { gte: startOfDay, lte: endOfDay },
      },
    }),
    prisma.salesLeadAssignment.count({
      where: {
        ...where,
        followUpAt: { lt: now },
        stage: { notIn: ['CLOSED_WON', 'CLOSED_LOST'] },
      },
    }),
    prisma.salesLeadAssignment.groupBy({
      by: ['stage'],
      where,
      _count: { id: true },
      _sum: { budgetAmount: true },
    }),
    prisma.upiPaymentLink.findMany({
      where: paymentLinkWhere,
      select: { status: true, totalAmount: true },
    }),
  ]);

  let wonCount = 0;
  let wonAmount = 0;
  let lostCount = 0;
  let openDealsValue = 0;
  let closedWonBudget = 0;
  const stageCounts: Record<string, number> = {
    NEW: 0,
    CONTACTED: 0,
    IN_PROGRESS: 0,
    DEMO: 0,
    FOLLOW_UP: 0,
    NEGOTIATION: 0,
    CLOSED_WON: 0,
    CLOSED_LOST: 0,
  };

  for (const item of stageAggregates) {
    const count = item._count?.id ?? 0;
    const val = Number(item._sum?.budgetAmount ?? 0);
    const s = (item.stage || '').toUpperCase();

    // Standardize stage bucket counting matching normalizeStageId
    if (s === 'NEW' || s === 'ASSIGNED') {
      stageCounts.NEW += count;
      openDealsValue += val;
    } else if (s === 'CONTACTED' || s === 'QUALIFIED' || s === 'INTERESTED') {
      stageCounts.CONTACTED += count;
      openDealsValue += val;
    } else if (s === 'IN_PROGRESS') {
      stageCounts.IN_PROGRESS += count;
      openDealsValue += val;
    } else if (s === 'DEMO') {
      stageCounts.DEMO += count;
      openDealsValue += val;
    } else if (s === 'FOLLOW_UP') {
      stageCounts.FOLLOW_UP += count;
      openDealsValue += val;
    } else if (s === 'NEGOTIATION') {
      stageCounts.NEGOTIATION += count;
      openDealsValue += val;
    } else if (s === 'CLOSED_WON' || s === 'PAID' || s === 'WON') {
      stageCounts.CLOSED_WON += count;
      wonCount += count;
      closedWonBudget += val;
    } else if (s === 'CLOSED_LOST' || s === 'LOST' || s === 'RECYCLED') {
      stageCounts.CLOSED_LOST += count;
      lostCount += count;
    } else {
      stageCounts.NEW += count;
      openDealsValue += val;
    }
  }

  const pendingLinks = paymentLinks.filter(
    (pl) => pl.status === 'PENDING' || pl.status === 'CUSTOMER_CONFIRMED'
  );
  const paidLinks = paymentLinks.filter((pl) => pl.status === 'PAID');
  const paidAmount = paidLinks.reduce((sum, pl) => sum + Number(pl.totalAmount || 0), 0);
  const pendingAmount = pendingLinks.reduce((sum, pl) => sum + Number(pl.totalAmount || 0), 0);

  // If realized payments exist, report realized amount, otherwise closed won deal budgets
  if (paidLinks.length > 0) {
    wonCount = paidLinks.length;
    wonAmount = paidAmount;
  } else {
    wonAmount = closedWonBudget;
  }

  // Consistent Pipeline Value: Sum of active open deals in pipeline
  const pipelineValue = openDealsValue;

  const conversionRate = totalLeads > 0 ? Number(((wonCount / totalLeads) * 100).toFixed(1)) : 0;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const wsSettings = (workspace?.settings as Record<string, any>) || {};
  const allMissedLeads: MissedLeadRecord[] = Array.isArray(wsSettings.missedLeads) ? wsSettings.missedLeads : [];

  // Strictly filter to missed leads TODAY (startOfDay to endOfDay)
  const todayMissedLeads = allMissedLeads.filter((m) => {
    if (!m.missedAt) return false;
    const t = new Date(m.missedAt).getTime();
    return t >= startOfDay.getTime() && t <= endOfDay.getTime();
  });

  let missedCount = todayMissedLeads.length;
  if (req.user && (req.user.role === 'SALES_AGENT' || (req.user.role as any) === 'CLOSER')) {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    missedCount = profile ? todayMissedLeads.filter((m) => m.agentId === profile.id).length : 0;
  }

  res.json({
    success: true,
    data: {
      totalLeads,
      hotLeads,
      followUpsToday,
      followUpsPending,
      wonCount,
      wonAmount,
      lostCount,
      pipelineValue,
      pendingPaymentLinksCount: pendingLinks.length,
      pendingPaymentLinksAmount: pendingAmount,
      conversionRate,
      stageCounts,
      missedCount,
    },
    error: null,
  });
});


// GET /pool - Unassigned leads in the Grab Pool with 10-minute rotation & dynamic capacity
leadsRouter.get('/pool', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user;

  const profile = user && (user.role === 'SALES_AGENT' || (user.role as any) === 'CLOSER')
    ? await prisma.salesAgentProfile.findFirst({
        where: { userId: user.userId, tenantId, status: 'ACTIVE' },
        select: { id: true },
      })
    : null;

  if ((user?.role === 'SALES_AGENT' || (user?.role as any) === 'CLOSER') && !profile) {
    res.json({ success: true, data: [], error: null });
    return;
  }

  // 1. Run slot rotation engine and detect expired / missed pool leads
  const { slottedPoolLeads, wsSettings } = await syncAndRotatePoolSlots(tenantId, profile?.id);

  // 2. Read dynamic capacity: workspace.settings.roundRobinSettings.maxVisibleToCloser || 25
  const rrSettings = (wsSettings.roundRobinSettings as Record<string, any>) || {};
  const grabCapacity = Number(rrSettings.maxVisibleToCloser) || Number(wsSettings.poolCapacity) || 25;

  const isSalesAgent = user?.role === 'SALES_AGENT' || (user?.role as any) === 'CLOSER';
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN' || user?.role === 'MANAGER';
  const maxVisibleParam = req.query.maxVisibleToCloser || req.query.limit;
  const maxVisibleToCloser = isSalesAgent
    ? grabCapacity
    : (maxVisibleParam
        ? Math.min(50, Math.max(1, isNaN(Number(maxVisibleParam)) ? 50 : Number(maxVisibleParam)))
        : 50);

  // Dynamically resolve entry stage of the Kanban board
  const stages = await getWorkspaceStages(tenantId);
  const initialStageKey = stages[0]?.key || 'NEW';
  const initialStageLabel = stages[0]?.label || 'New Lead';

  // Calculate closer's leads in initialStageKey
  const initialStageCount = profile
    ? await prisma.salesLeadAssignment.count({
        where: {
          tenantId,
          assignedAgentId: profile.id,
          stage: initialStageKey as any,
          NOT: {
            customFields: {
              path: ['inGrabPool'],
              equals: true,
            },
          },
        },
      })
    : 0;

  const availableSlots = Math.max(0, grabCapacity - initialStageCount);
  const isAtQuota = !isAdmin && initialStageCount >= grabCapacity;

  // 3. Query open pool items
  const poolLeads = await prisma.salesLeadPoolItem.findMany({
    where: {
      tenantId,
      status: 'OPEN',
      ...(profile ? {
        OR: [
          { assignedAgentId: null },
          { assignedAgentId: profile.id },
        ],
      } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

  const now = Date.now();

  // 4. Filter for sales agents to only show items slotted to them or unslotted
  const filteredLeads = profile
    ? poolLeads.filter((item) => {
        const slot = slottedPoolLeads[item.id];
        if (!slot) return true;
        return slot.slottedAgentId === profile.id;
      })
    : poolLeads;

  // 5. Clamp to maxVisibleToCloser and attach expiresInSeconds
  const formattedLeads = filteredLeads.slice(0, maxVisibleToCloser).map((item) => {
    const slot = slottedPoolLeads[item.id];
    const slotExpiresAt = slot?.slotExpiresAt || new Date(now + 10 * 60 * 1000).toISOString();
    const expiresInSeconds = Math.max(0, Math.round((new Date(slotExpiresAt).getTime() - now) / 1000));

    return {
      ...item,
      slottedAgentId: slot?.slottedAgentId || null,
      slotExpiresAt,
      expiresInSeconds,
    };
  });

  res.json({
    success: true,
    data: formattedLeads,
    totalPoolCount: poolLeads.length,
    mySlottedCount: formattedLeads.length,
    maxVisibleToCloser,
    initialStageKey,
    initialStageLabel,
    initialStageCount,
    grabCapacity,
    availableSlots,
    isAtQuota,
    error: null,
  });
});

// GET /missed - Query missed pool leads with role-based scoping (closer vs admin)
leadsRouter.get('/missed', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const userRole = user.role;
  const isSalesAgent = userRole === 'SALES_AGENT' || (userRole as string) === 'CLOSER';

  const profile = isSalesAgent
    ? await prisma.salesAgentProfile.findFirst({
        where: { userId: user.userId, tenantId },
        select: { id: true, agentCode: true, user: { select: { displayName: true } } },
      })
    : null;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const wsSettings = (workspace?.settings as Record<string, any>) || {};
  const allMissedLeads: MissedLeadRecord[] = Array.isArray(wsSettings.missedLeads) ? wsSettings.missedLeads : [];

  // Query agent profiles to enrich agent display names
  const agentIds = Array.from(new Set(allMissedLeads.map((m) => m.agentId).filter(Boolean)));
  const profiles = agentIds.length > 0
    ? await prisma.salesAgentProfile.findMany({
        where: { tenantId, id: { in: agentIds } },
        include: { user: { select: { displayName: true, email: true } } },
      })
    : [];
  const profileMap = new Map(profiles.map((p) => [p.id, p.user?.displayName || p.agentCode]));

  const enrichedMissedLeads = allMissedLeads.map((m) => ({
    ...m,
    agentName: m.agentName || profileMap.get(m.agentId) || 'Sales Closer',
  }));

  if (isSalesAgent) {
    const myMissed = profile
      ? enrichedMissedLeads.filter((m) => m.agentId === profile.id)
      : [];

    res.json({
      success: true,
      data: {
        totalMissed: myMissed.length,
        myMissed: myMissed.length,
        items: myMissed,
      },
      totalMissed: myMissed.length,
      myMissed: myMissed.length,
      items: myMissed,
      error: null,
    });
    return;
  }

  // Admin / Manager: team-wide breakdown
  const agentBreakdown: Record<string, number> = {};
  for (const m of allMissedLeads) {
    const name = profileMap.get(m.agentId) || m.agentId;
    agentBreakdown[name] = (agentBreakdown[name] || 0) + 1;
  }

  res.json({
    success: true,
    data: {
      totalMissed: enrichedMissedLeads.length,
      myMissed: 0,
      items: enrichedMissedLeads,
      agentBreakdown,
    },
    totalMissed: enrichedMissedLeads.length,
    myMissed: 0,
    items: enrichedMissedLeads,
    agentBreakdown,
    error: null,
  });
});

// POST /pool/auto-distribute - Distribute open pool leads sequentially to active closers with remaining capacity
const autoDistributeSchema = z.object({
  count: z.number().int().positive().optional(),
  poolItemIds: z.array(z.string()).optional(),
});

leadsRouter.post('/pool/auto-distribute', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN' && user.role !== 'MANAGER') {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Only workspace admins and managers can auto-distribute pool leads' });
    return;
  }

  const parsed = autoDistributeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'ValidationError', message: parsed.error.issues[0]?.message || 'Invalid request body' });
    return;
  }
  const body = parsed.data;

  // 1. Find eligible active sales agents
  const activeProfiles = await prisma.salesAgentProfile.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      user: { role: 'SALES_AGENT' },
    },
    include: {
      user: { select: { id: true, displayName: true, email: true } },
      _count: {
        select: {
          leadAssignments: {
            where: { stage: { notIn: inactiveLeadStages } },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const eligibleClosers = activeProfiles
    .map((p) => {
      const maxActiveLeads = p.maxActiveLeads && p.maxActiveLeads > 0 ? p.maxActiveLeads : 15;
      const currentActive = p._count.leadAssignments;
      const remainingCapacity = Math.max(0, maxActiveLeads - currentActive);
      return {
        profile: p,
        currentActive,
        maxActiveLeads,
        remainingCapacity,
      };
    })
    .filter((c) => c.remainingCapacity > 0);

  if (eligibleClosers.length === 0) {
    res.status(409).json({
      success: false,
      error: 'NoEligibleClosers',
      message: 'No active closers have available capacity for lead assignment',
      count: 0,
      assignments: [],
    });
    return;
  }

  // 2. Find OPEN SalesLeadPoolItem records
  let itemsToDistribute: any[] = [];
  if (body.poolItemIds && body.poolItemIds.length > 0) {
    itemsToDistribute = await prisma.salesLeadPoolItem.findMany({
      where: {
        id: { in: body.poolItemIds },
        tenantId,
        status: 'OPEN',
      },
      orderBy: { createdAt: 'asc' },
    });
  } else {
    const takeCount = body.count ? Math.min(body.count, 200) : 200;
    itemsToDistribute = await prisma.salesLeadPoolItem.findMany({
      where: {
        tenantId,
        status: 'OPEN',
      },
      take: takeCount,
      orderBy: { createdAt: 'asc' },
    });
  }

  if (itemsToDistribute.length === 0) {
    res.json({
      success: true,
      count: 0,
      assignments: [],
      message: 'No open pool leads available for distribution',
    });
    return;
  }

  // 3. Plan round-robin assignments
  let closerIndex = 0;
  const assignmentsToCreate: Array<{ poolItem: any; closer: typeof eligibleClosers[0] }> = [];

  for (const item of itemsToDistribute) {
    let candidate = null;
    for (let attempts = 0; attempts < eligibleClosers.length; attempts++) {
      const currentCandidate = eligibleClosers[closerIndex % eligibleClosers.length];
      closerIndex++;
      if (currentCandidate.remainingCapacity > 0) {
        candidate = currentCandidate;
        candidate.remainingCapacity--;
        break;
      }
    }
    if (!candidate) break;
    assignmentsToCreate.push({ poolItem: item, closer: candidate });
  }

  // 4. Atomic transaction
  const distributedResults = await prisma.$transaction(async (tx) => {
    const results = [];
    for (const { poolItem, closer } of assignmentsToCreate) {
      await tx.salesLeadPoolItem.update({
        where: { id: poolItem.id },
        data: {
          status: 'CLAIMED',
          claimedByAgentId: closer.profile.id,
          claimedAt: new Date(),
        },
      });

      const lead = await tx.salesLeadAssignment.create({
        data: {
          tenantId,
          assignedAgentId: closer.profile.id,
          createdById: user.userId,
          customerName: poolItem.customerName,
          customerPhone: poolItem.customerPhone,
          customerEmail: poolItem.customerEmail,
          source: poolItem.source || 'auto_distribute',
          serviceInterest: poolItem.serviceInterest,
          segment: poolItem.segment,
          priority: poolItem.priority || 'normal',
          budgetAmount: poolItem.budgetAmount,
          stage: 'NEW',
          notes: poolItem.notes
            ? `${poolItem.notes} (Auto-distributed to ${closer.profile.agentCode})`
            : `Auto-distributed to ${closer.profile.agentCode}`,
          conversationId: poolItem.conversationId,
        },
      });

      await tx.salesLeadPoolItem.update({
        where: { id: poolItem.id },
        data: { convertedAssignmentId: lead.id },
      });

      await tx.salesActivityLog.create({
        data: {
          tenantId,
          assignmentId: lead.id,
          actorUserId: user.userId,
          action: 'LEAD_AUTO_DISTRIBUTED',
          note: `Lead ${lead.customerName} auto-distributed from grab pool to closer ${closer.profile.user?.displayName || closer.profile.agentCode}`,
          metadata: {
            poolItemId: poolItem.id,
            assignedAgentId: closer.profile.id,
            agentCode: closer.profile.agentCode,
          },
        },
      });

      results.push({
        leadId: lead.id,
        poolItemId: poolItem.id,
        customerName: lead.customerName,
        customerPhone: lead.customerPhone,
        assignedAgentId: closer.profile.id,
        agentCode: closer.profile.agentCode,
        closerName: closer.profile.user?.displayName,
      });
    }
    return results;
  });

  res.json({
    success: true,
    count: distributedResults.length,
    assignments: distributedResults,
    message: `Successfully auto-distributed ${distributedResults.length} leads across active closers`,
  });
});

// GET /duplicates - Detect duplicate leads by phone or email
leadsRouter.get('/duplicates', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  // Find phones that occur more than once
  const duplicates = await prisma.$queryRaw<Array<{ customerPhone: string; count: number }>>`
    SELECT "customerPhone", COUNT(*)::int as count
    FROM "SalesLeadAssignment"
    WHERE "tenantId" = ${tenantId}
    GROUP BY "customerPhone"
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 20;
  `;

  const results = await Promise.all(
    duplicates.map(async (d) => {
      const leads = await prisma.salesLeadAssignment.findMany({
        where: { tenantId, customerPhone: d.customerPhone },
        orderBy: { createdAt: 'desc' },
      });
      return {
        phone: d.customerPhone,
        duplicateCount: d.count,
        leads,
      };
    })
  );

  res.json({ success: true, data: results });
});

// POST /merge - Merge secondary duplicate lead into primary
leadsRouter.post('/merge', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { primaryLeadId, secondaryLeadId } = req.body as { primaryLeadId: string; secondaryLeadId: string };

  if (!primaryLeadId || !secondaryLeadId || primaryLeadId === secondaryLeadId) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'Specify two distinct lead IDs' });
    return;
  }

  const [primary, secondary] = await Promise.all([
    prisma.salesLeadAssignment.findFirst({ where: { id: primaryLeadId, tenantId } }),
    prisma.salesLeadAssignment.findFirst({ where: { id: secondaryLeadId, tenantId } }),
  ]);

  if (!primary || !secondary) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'One or both leads not found' });
    return;
  }

  // Transfer calls to primary
  await prisma.salesMobileCall.updateMany({
    where: { assignmentId: secondary.id, tenantId },
    data: { assignmentId: primary.id },
  });

  // Transfer timeline entries to primary
  await prisma.salesLeadTimelineEntry.updateMany({
    where: { leadId: secondary.id, tenantId },
    data: { leadId: primary.id },
  });

  // Archive secondary lead
  await prisma.salesLeadAssignment.delete({
    where: { id: secondary.id },
  });

  // Log audit event
  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: primary.id,
      actorUserId: req.user?.userId,
      action: 'LEAD_MERGED',
      note: `Merged duplicate lead ${secondary.id} (${secondary.customerName}) into this lead`,
    },
  });

  res.json({ success: true, message: 'Leads merged successfully', primaryLeadId });
});

const reorderLeadsSchema = z.object({
  stage: z.string().optional(),
  items: z.array(z.object({
    id: z.string().min(1),
    kanbanPosition: z.number().int().min(0),
    stage: z.string().optional(),
  })).min(1),
});

// POST /reorder - Batch update kanban positions and stages
leadsRouter.post('/reorder', validateBody(reorderLeadsSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { stage: defaultStage, items } = req.body as z.infer<typeof reorderLeadsSchema>;

  const now = new Date();

  await prisma.$transaction(
    items.map((item) => {
      const targetStage = item.stage || defaultStage;
      const data: Prisma.SalesLeadAssignmentUpdateManyMutationInput = {
        kanbanPosition: item.kanbanPosition,
        updatedAt: now,
      };
      if (targetStage && (SALES_LEAD_STAGES as readonly string[]).includes(targetStage)) {
        data.stage = targetStage as SalesLeadStage;
        data.stageChangedAt = now;
      }
      return prisma.salesLeadAssignment.updateMany({
        where: {
          id: item.id,
          tenantId,
        },
        data,
      });
    })
  );

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.reordered',
    payload: {
      count: items.length,
      stage: defaultStage,
      items: items.map((i) => ({ id: i.id, kanbanPosition: i.kanbanPosition, stage: i.stage || defaultStage })),
      updatedAt: now.toISOString(),
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  res.json({ success: true, count: items.length });
});


async function verifyLeadAccess(leadId: string, req: Request) {
  const tenantId = req.tenantId!;
  const user = req.user!;

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id: leadId, tenantId },
    include: {
      assignedAgent: {
        select: {
          id: true,
          agentCode: true,
          userId: true,
          user: { select: { id: true, displayName: true, email: true, phone: true } },
        },
      },
    },
  });

  if (!lead) return { ok: false as const, status: 404, error: 'NotFound', message: 'Lead not found in this workspace' };

  if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
    const scope = await getWorkspaceScope(tenantId, user);
    let allowed = Boolean(lead.assignedAgentId && scope.profileIds.includes(lead.assignedAgentId));
    if (!allowed && lead.conversationId) {
      const conversation = await prisma.appConversation.findFirst({ where: { id: lead.conversationId, tenantId }, select: { payload: true } });
      const payload = conversation?.payload as { shares?: Array<{ userId: string; agentProfileId?: string; permission?: string; revokedAt?: string }> } | null;
      allowed = Boolean(payload?.shares?.some((share) => !share.revokedAt &&
        (share.userId === user.userId || Boolean(share.agentProfileId && scope.profileIds.includes(share.agentProfileId))) &&
        (req.method === 'GET' || req.method === 'HEAD' || share.permission === 'REPLY')));
    }
    if (!allowed) return { ok: false as const, status: 403, error: 'Forbidden', message: 'You are not authorized to access this lead' };
  }

  return { ok: true as const, lead };
}

// GET /:id/360 - Unified Lead 360 view
export async function getLead360(req: Request, res: Response) {
  const startTime = Date.now();
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, data: null, error: check.error, message: check.message });
    return;
  }
  const lead = check.lead;

  const rawPhone = lead.customerPhone || '';
  const phoneDigits = rawPhone.replace(/\D/g, '');
  const last10 = phoneDigits.slice(-10);

  // 1. Fetch all child resources strictly isolated to this verified lead
  const [timeline, tasks, calls, customFieldsDef, activityLogs, deals, campaignRecipients] = await Promise.all([
    prisma.salesLeadTimelineEntry.findMany({
      where: { leadId: lead.id, tenantId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.gxLeadTask.findMany({
      where: { salesLeadId: lead.id },
      orderBy: { dueAt: 'asc' },
    }),
    prisma.salesMobileCall.findMany({
      where: { assignmentId: lead.id, tenantId },
      orderBy: { startedAt: 'desc' },
      take: 50,
    }),
    prisma.customFieldDefinition.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.salesActivityLog.findMany({
      where: { assignmentId: lead.id, tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        actor: { select: { displayName: true, email: true } },
      },
    }),
    prisma.salesDeal.findMany({
      where: { assignmentId: lead.id, tenantId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    last10
      ? prisma.whatsAppCampaignRecipient.findMany({
          where: {
            campaign: { tenantId },
            OR: [
              { e164Phone: rawPhone },
              ...(phoneDigits ? [{ e164Phone: `+${phoneDigits}` }, { e164Phone: phoneDigits }] : []),
              { e164Phone: { contains: last10 } },
            ],
          },
          include: {
            campaign: { select: { id: true, name: true, status: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        })
      : Promise.resolve([]),
  ]);

  // 2. Fetch recording uploads for call audio URLs
  const recordingUploads = calls.length
    ? await prisma.callRecordingUpload.findMany({
        where: { tenantId, callId: { in: calls.map((call) => call.id) }, status: 'UPLOADED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, callId: true },
      })
    : [];
  const recordingByCallId = new Map<string, string>();
  for (const upload of recordingUploads) {
    if (!recordingByCallId.has(upload.callId)) recordingByCallId.set(upload.callId, upload.id);
  }

  const enrichedCalls = calls.map((call) => {
    const uploadId = recordingByCallId.get(call.id) ?? null;
    const audioUrl = uploadId
      ? `/api/v1/recordings/${uploadId}/playback`
      : (call.recordingPath ? `/api/v1/recordings/${call.id}/playback` : null);

    return {
      ...call,
      recordingUploadId: uploadId,
      hasRecording: Boolean(uploadId || call.recordingStatus === 'UPLOADED' || call.recordingPath),
      audioUrl,
      recordingAudioUrl: audioUrl,
    };
  });

  // 3. Dual WhatsApp Conversation & message history (Official API vs Personal QR Companion)
  const customFieldsObj = (lead.customFields && typeof lead.customFields === 'object' && !Array.isArray(lead.customFields))
    ? { ...(lead.customFields as Record<string, any>) }
    : {};
  let metaCloudConversationId: string | null = customFieldsObj.metaCloudConversationId || null;
  let personalQrConversationId: string | null = customFieldsObj.personalQrConversationId || null;

  let conversation = null;
  if (lead.conversationId) {
    conversation = await prisma.appConversation.findFirst({
      where: { id: lead.conversationId, tenantId },
      select: { id: true, status: true, updatedAt: true, payload: true, serviceSlug: true },
    });
    if (conversation) {
      if (conversation.serviceSlug === 'manual-chat') {
        personalQrConversationId = conversation.id;
      } else {
        metaCloudConversationId = conversation.id;
      }
    }
  }

  // Look up official WhatsApp API conversation if not resolved
  if (!metaCloudConversationId && last10) {
    const official = await prisma.appConversation.findFirst({
      where: {
        tenantId,
        serviceSlug: { not: 'manual-chat' },
        customerPhone: { contains: last10 },
      },
      select: { id: true, status: true, updatedAt: true, payload: true, serviceSlug: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (official) {
      metaCloudConversationId = official.id;
      if (!conversation) conversation = official;
    }
  }

  // Look up personal QR companion conversation if not resolved
  if (!personalQrConversationId && last10) {
    const personal = await prisma.appConversation.findFirst({
      where: {
        tenantId,
        serviceSlug: 'manual-chat',
        customerPhone: { contains: last10 },
      },
      select: { id: true, status: true, updatedAt: true, payload: true, serviceSlug: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (personal) {
      personalQrConversationId = personal.id;
      if (!conversation) conversation = personal;
    }
  }

  if (conversation && !lead.conversationId) {
    await prisma.salesLeadAssignment.update({
      where: { id: lead.id },
      data: { conversationId: conversation.id },
    }).catch(() => undefined);
  }

  // 4. Payments directly linked or by phone
  const payments = await prisma.upiPaymentLink.findMany({
    where: {
      tenantId,
      OR: [
        { customFields: { path: ['leadId'], equals: id } },
        ...(lead.customerPhone ? [{ customerPhone: lead.customerPhone }] : []),
      ],
    },
    orderBy: { id: 'desc' },
    take: 10,
  });

  const rawMessages = Array.isArray((conversation?.payload as any)?.messages)
    ? (conversation!.payload as any).messages
    : [];
  const lastMessage = rawMessages.length > 0 ? rawMessages[rawMessages.length - 1] : null;

  // 5. WhatsApp Campaign Delivery Receipts & Inbound Replies
  const mappedCampaignDeliveries = campaignRecipients.map((r: any) => {
    const sentTime = r.sentAt ? new Date(r.sentAt).getTime() : 0;
    const inboundReplies = rawMessages.filter((m: any) => {
      const isCustomer = m.fromCustomer || m.direction === 'inbound' || m.sender === 'customer' || m.isIncoming;
      const msgTime = new Date(m.timestamp || m.createdAt || 0).getTime();
      return isCustomer && sentTime > 0 && msgTime >= sentTime;
    }).map((m: any) => ({
      id: m.id || m.messageId,
      body: m.body || m.text || m.content || '',
      receivedAt: m.timestamp || m.createdAt,
    }));

    return {
      id: r.id,
      campaignId: r.campaignId,
      campaignName: r.campaign?.name || 'WhatsApp Broadcast',
      campaignStatus: r.campaign?.status || 'COMPLETED',
      phone: r.e164Phone,
      status: r.status,
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
      deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
      readAt: r.readAt ? r.readAt.toISOString() : null, // Blue ticks!
      failedAt: r.failedAt ? r.failedAt.toISOString() : null,
      errorMessage: r.errorMessage || null,
      inboundReplies,
      hasInboundReply: inboundReplies.length > 0,
      lastReplyAt: inboundReplies.length > 0 ? inboundReplies[inboundReplies.length - 1].receivedAt : null,
    };
  });

  // 6. Notes with author attribution
  const authorUserIds = timeline.map((e) => e.userId).filter(Boolean) as string[];
  const authorUsers = authorUserIds.length
    ? await prisma.appAuthUser.findMany({
        where: { id: { in: authorUserIds } },
        select: { id: true, displayName: true, email: true },
      })
    : [];
  const authorMap = new Map(authorUsers.map((u) => [u.id, u.displayName || u.email]));

  const formattedNotes = timeline
    .filter((entry) => entry.type === 'NOTE')
    .map((entry) => ({
      id: entry.id,
      body: entry.body,
      createdAt: entry.createdAt.toISOString(),
      author: authorMap.get(entry.userId || '') || (entry.metadata as any)?.author || lead.assignedAgent?.user?.displayName || 'Team Member',
      authorId: entry.userId || entry.agentId || null,
      metadata: entry.metadata,
    }));

  const humanizeHistoryAction = (value: string) => value
    .replace(/^LEAD_/, '')
    .replace(/^CALL_/, 'Call ')
    .replace(/^MOBILE_/, 'Mobile ')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());

  // Deduplicate and filter activityLogs against calls and timeline
  const filteredActivityLogs = activityLogs.filter((act) => {
    const action = String(act.action || '').toUpperCase();
    const actTime = act.createdAt ? new Date(act.createdAt).getTime() : 0;

    // Filter redundant call activity logs when enrichedCalls has a corresponding record
    if (['MOBILE_CALL_LOGGED', 'CALL_COMPLETED', 'CALL_LOGGED', 'CALL'].includes(action)) {
      const actCallId = (act.metadata as any)?.callId || (act.metadata as any)?.mobileCallId;
      const matchingCall = enrichedCalls.find((call) => {
        if (actCallId && (call.id === actCallId || (call as any).mobileCallId === actCallId)) return true;
        const callTime = call.startedAt ? new Date(call.startedAt).getTime() : 0;
        return Math.abs(actTime - callTime) <= 60000;
      });
      if (matchingCall) return false;
    }

    // Filter redundant stage changed activity logs when timeline has corresponding record
    if (['STAGE_CHANGED', 'LEAD_STAGE_CHANGED', 'STAGE_UPDATE'].includes(action)) {
      const matchingTimeline = timeline.find((t) => {
        const tTime = t.createdAt ? new Date(t.createdAt).getTime() : 0;
        const tType = String(t.type || '').toUpperCase();
        return (tType.includes('STAGE') || tType === 'STAGE_CHANGE') && Math.abs(actTime - tTime) <= 60000;
      });
      if (matchingTimeline) return false;
    }

    return true;
  });

  const rawHistory: Array<Record<string, unknown>> = [
    ...timeline.map((entry) => ({
      id: `timeline:${entry.id}`,
      kind: entry.type || 'NOTE',
      title: entry.type === 'NOTE' ? 'Note added' : humanizeHistoryAction(entry.type),
      body: entry.body,
      createdAt: entry.createdAt.toISOString(),
      author: authorMap.get(entry.userId || '') || null,
    })),
    ...filteredActivityLogs.map((entry) => ({
      id: `activity:${entry.id}`,
      kind: 'ACTIVITY',
      title: humanizeHistoryAction(entry.action),
      body: entry.note || humanizeHistoryAction(entry.action),
      createdAt: entry.createdAt.toISOString(),
      actorName: entry.actor?.displayName || entry.actor?.email || null,
      metadata: entry.metadata,
    })),
    ...tasks.map((task) => ({
      id: `task:${task.id}`,
      kind: 'CALLBACK',
      title: task.title || 'Follow-up scheduled',
      body: task.description || 'Follow-up task created for this lead.',
      createdAt: task.createdAt.toISOString(),
      dueAt: task.dueAt ? task.dueAt.toISOString() : null,
      status: task.status,
    })),
    ...enrichedCalls.map((call) => ({
      id: `call:${call.id}`,
      kind: 'CALL',
      title: `${call.direction === 'INBOUND' ? 'Incoming' : 'Outgoing'} call`,
      body: [
        call.outcome,
        call.note,
        call.durationSeconds != null ? `${call.durationSeconds}s` : null,
      ].filter(Boolean).join(' · ') || 'Call activity recorded.',
      createdAt: call.startedAt.toISOString(),
      audioUrl: call.audioUrl,
    })),
    ...payments.map((payment) => ({
      id: `payment:${payment.id}`,
      kind: 'PAYMENT',
      title: 'Payment request updated',
      body: `${payment.status}${payment.totalAmount != null ? ` · ${payment.currency} ${payment.totalAmount}` : ''}`,
      createdAt: payment.createdAt.toISOString(),
    })),
    ...mappedCampaignDeliveries.map((delivery) => ({
      id: `campaign:${delivery.id}`,
      kind: 'WHATSAPP_CAMPAIGN',
      title: `WhatsApp Campaign: ${delivery.campaignName}`,
      body: `Status: ${delivery.status}${delivery.readAt ? ' (Read ✓✓)' : delivery.deliveredAt ? ' (Delivered)' : ''}`,
      createdAt: delivery.sentAt || delivery.deliveredAt || new Date().toISOString(),
      metadata: delivery,
    })),
  ];

  // Guarantee unique deterministic IDs and sort chronologically
  const seenHistoryIds = new Set<string>();
  const history = rawHistory
    .filter((item) => {
      const itemId = String(item.id || '');
      if (!itemId || seenHistoryIds.has(itemId)) return false;
      seenHistoryIds.add(itemId);
      return true;
    })
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

  const raw360Data = {
    lead: {
      ...lead,
      metaCloudConversationId,
      personalQrConversationId,
      aiScore: lead.aiScore ?? 50,
      aiSentiment: lead.aiSentiment || 'NEUTRAL',
      aiSummary: lead.aiSummary || null,
      customFields: {
        ...customFieldsObj,
        metaCloudConversationId,
        personalQrConversationId,
      },
    },
    metaCloudConversationId,
    personalQrConversationId,
    assignedAgent: lead.assignedAgent ? {
      id: lead.assignedAgent.id,
      agentCode: lead.assignedAgent.agentCode,
      displayName: lead.assignedAgent.user?.displayName,
      email: lead.assignedAgent.user?.email,
      phone: lead.assignedAgent.user?.phone,
    } : null,
    notes: formattedNotes,
    timelineNotes: formattedNotes,
    timeline,
    activityLogs,
    history,
    tasks,
    callbacks: tasks,
    callLogs: enrichedCalls,
    calls: enrichedCalls,
    deals,
    whatsappReceipts: mappedCampaignDeliveries,
    campaignDeliveries: mappedCampaignDeliveries,
    activeConversation: conversation ? {
      id: conversation.id,
      status: conversation.status,
      updatedAt: conversation.updatedAt,
      unreadCount: 0,
      lastMessage,
    } : null,
    conversation: conversation ? {
      id: conversation.id,
      status: conversation.status,
      updatedAt: conversation.updatedAt,
    } : null,
    payments,
    customFieldDefinitions: customFieldsDef,
    customFieldsDefinition: customFieldsDef,
    meta: {
      elapsedMs: Date.now() - startTime,
    },
  };

  const wsFor360 = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  if (isPhoneMaskingRequired(req.user, wsFor360?.settings as Record<string, any>)) {
    if (raw360Data.lead) {
      raw360Data.lead = {
        ...raw360Data.lead,
        customerPhone: maskPhoneNumber(raw360Data.lead.customerPhone, true),
      };
    }
    if (raw360Data.callLogs) {
      raw360Data.callLogs = raw360Data.callLogs.map((c: any) => ({
        ...c,
        phoneNumber: maskPhoneNumber(c.phoneNumber, true),
      }));
    }
    if (raw360Data.calls) {
      raw360Data.calls = raw360Data.calls.map((c: any) => ({
        ...c,
        phoneNumber: maskPhoneNumber(c.phoneNumber, true),
      }));
    }
  }

  res.json({
    success: true,
    data: raw360Data,
    error: null,
  });
}

// GET /api/v1/leads/recycle-bin - View soft-deleted leads (Admin / Authorized Manager)
leadsRouter.get('/recycle-bin', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
    if (user.role === 'MANAGER') {
      const ws = await prisma.aicloserWorkspace.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      const wsSettings = (ws?.settings as Record<string, any>) || {};
      if (!wsSettings.allowManagerLeadDeletion) {
        res.status(403).json({
          success: false,
          error: 'Manager recycle bin access is not enabled for this workspace.',
          message: 'Manager recycle bin access is not enabled for this workspace.',
        });
        return;
      }
    } else {
      res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Only workspace administrators and authorized managers can view the recycle bin.',
      });
      return;
    }
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const search = req.query.search ? String(req.query.search).trim() : '';

  const where: any = {
    tenantId,
    OR: [
      { stage: 'RECYCLED' },
      { customFields: { path: ['recycled'], equals: true } },
    ],
  };

  if (search) {
    const trimmed = search.trim();
    where.AND = [
      {
        OR: [
          { customerName: { contains: trimmed, mode: 'insensitive' } },
          { customerPhone: { contains: trimmed } },
          { customerEmail: { contains: trimmed, mode: 'insensitive' } },
        ],
      },
    ];
  }

  const [total, leads] = await Promise.all([
    prisma.salesLeadAssignment.count({ where }),
    prisma.salesLeadAssignment.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { updatedAt: 'desc' },
      include: {
        assignedAgent: {
          select: {
            id: true,
            agentCode: true,
            user: { select: { displayName: true, email: true, phone: true } },
          },
        },
      },
    }),
  ]);

  res.json({
    success: true,
    data: leads,
    leads,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    error: null,
  });
});

// GET /api/v1/leads/export - Role-restricted Excel workbook export (.xlsx)
leadsRouter.get('/export', async (req: Request, res: Response) => {
  const user = req.user!;
  const tenantId = req.tenantId!;

  if (user.role === 'SALES_AGENT' || (user.role as any) === 'CLOSER') {
    res.status(403).json({ success: false, error: 'Export is restricted to Admin only.' });
    return;
  }

  if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
    res.status(403).json({ success: false, error: 'Export is restricted to Admin only.' });
    return;
  }

  const where: any = {
    tenantId,
    stage: { not: 'RECYCLED' },
  };

  if (req.query.stage) {
    where.stage = String(req.query.stage);
  }
  if (req.query.assignedAgentId) {
    where.assignedAgentId = String(req.query.assignedAgentId);
  }

  const leads = await prisma.salesLeadAssignment.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      assignedAgent: {
        select: {
          id: true,
          agentCode: true,
          user: { select: { displayName: true, email: true, phone: true } },
        },
      },
    },
  });

  const rows = leads.map((l) => {
    const custom = (l.customFields && typeof l.customFields === 'object' && !Array.isArray(l.customFields))
      ? (l.customFields as Record<string, any>)
      : {};
    const code = custom.code || l.leadId || `LD-${l.id.slice(-6).toUpperCase()}`;
    const company = custom.company || custom.organization || custom.businessName || '';
    const owner = l.assignedAgent?.user?.displayName || l.assignedAgent?.agentCode || 'Unassigned';
    const val = Number(l.budgetAmount || 0);

    return {
      'Lead Code': code,
      'Name': l.customerName || '',
      'Phone': l.customerPhone || '',
      'Email': l.customerEmail || '',
      'Company': company,
      'Stage': l.stage || '',
      'Priority': l.priority || 'NORMAL',
      'Owner': owner,
      'Value': val,
      'Source': l.source || 'MANUAL',
      'Created Date': l.createdAt ? new Date(l.createdAt).toLocaleDateString() : '',
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="leads-export-${dateStr}.xlsx"`);
  res.send(buffer);
});

leadsRouter.get('/:id/360', getLead360);

leadsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, data: null, error: check.error, message: check.message });
    return;
  }

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id: check.lead.id, tenantId },
    include: {
      assignedAgent: {
        select: {
          id: true,
          agentCode: true,
          user: { select: { displayName: true, email: true, phone: true } },
        },
      },
      mobileCalls: {
        where: { tenantId },
        orderBy: { startedAt: 'desc' },
        take: 10,
      },
      activityLogs: {
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found in this workspace' });
    return;
  }

  res.json({ success: true, data: lead });
});

const updateLeadSchema = z.object({
  customerName: z.string().trim().min(1).max(200).optional(),
  customerPhone: z.string().trim().min(5).max(40).nullable().optional(),
  customerEmail: z.string().trim().email().max(320).nullable().optional(),
  serviceInterest: z.string().trim().max(200).nullable().optional(),
  segment: z.string().trim().max(120).nullable().optional(),
  stage: leadStageInputSchema.optional(),
  kanbanPosition: z.number().optional(),
  priority: z.string().optional(),
  notes: z.string().optional(),
  followUpAt: leadFollowUpInputSchema,
  budgetAmount: z.number().optional(),
  assignedAgentId: z.string().optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  customFields: z.record(z.unknown()).optional(),
  lostReason: z.string().optional().nullable(),
  lostReasonNotes: z.string().optional().nullable(),
  isDndActive: z.boolean().optional(),
});

leadsRouter.patch('/:id', validateBody(updateLeadSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body;

  // The CRM settings toggle is enforced here as well as in the UI. This keeps
  // direct API calls and the Kanban/list controls on the same permission rule.
  if (req.user?.role !== 'ADMIN' && req.user?.role !== 'SUPER_ADMIN') {
    const workspace = await prisma.aicloserWorkspace.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const workspaceSettings = (workspace?.settings as Record<string, any>) || {};
    const roundRobinSettings = (workspaceSettings.roundRobinSettings as Record<string, any>) || {};
    if (roundRobinSettings.allowNonAdminModifyLeads === false) {
      res.status(403).json({
        success: false,
        code: 'PERMISSION_DENIED',
        error: 'Forbidden',
        message: 'Only workspace administrators can modify leads. Ask an administrator to enable lead modification access.',
      });
      return;
    }
  }

  // First verify lead exists in this tenant
  const access = await verifyLeadAccess(id, req);
  if (!access.ok) {
    res.status(access.status).json({ success: false, error: access.error, message: access.message });
    return;
  }
  const existing = access.lead;

  // The phone is the tenant-scoped lead identity key. It can be set when the
  // lead is created, but changing it would silently detach conversations,
  // notes, calls, and payment history from the original customer.
  if (body.customerPhone !== undefined && body.customerPhone !== existing.customerPhone) {
    res.status(400).json({
      success: false,
      error: 'LeadPhoneImmutable',
      message: 'A lead phone number is its identity key and cannot be changed after creation.',
    });
    return;
  }

  // Strict closer scoping: Closers can only update leads assigned to them
  const userRole = req.user?.role;
  const isSalesAgent = userRole === 'SALES_AGENT' || (userRole as string) === 'CLOSER';
  if (isSalesAgent) {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user!.userId, tenantId },
      select: { id: true },
    });
    if (existing.assignedAgentId !== profile?.id) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only update leads assigned to you' });
      return;
    }
  }

  // If reassigning agent, verify workspace governance policies
  let targetAgentId: string | undefined = undefined;
  if (body.assignedAgentId && body.assignedAgentId !== existing.assignedAgentId) {
    const workspace = await prisma.aicloserWorkspace.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const wsSettings = (workspace?.settings as Record<string, any>) || {};

    // 1. allowAgentLeadReassign policy check
    if (isSalesAgent) {
      if (wsSettings.allowAgentLeadReassign === false) {
        res.status(403).json({
          success: false,
          error: 'Lead reassignment is disabled for sales agents in workspace control settings.',
          message: 'Lead reassignment is disabled for sales agents in workspace control settings.',
        });
        return;
      }
      if (wsSettings.allowAgentLeadReassign !== true) {
        const canReassign = await hasPermission(req.user!.userId, tenantId, req.user!.role, PERM_LEADS_REASSIGN);
        if (!canReassign) {
          res.status(403).json({ success: false, error: 'Forbidden', message: 'Only workspace administrators or authorized users can reassign leads' });
          return;
        }
      }
    }

    // Resolve target agent in this tenant (can be profile ID or user ID)
    const targetAgent = await prisma.salesAgentProfile.findFirst({
      where: {
        tenantId,
        OR: [
          { id: body.assignedAgentId },
          { userId: body.assignedAgentId },
        ],
      },
      include: {
        user: { select: { id: true, role: true } },
      },
    });
    if (!targetAgent) {
      res.status(400).json({ success: false, error: 'InvalidAgent', message: 'Target agent not in workspace' });
      return;
    }

    const targetUserRole = String(targetAgent.user?.role || '').toUpperCase();
    if (targetUserRole === 'SUPER_ADMIN' || targetUserRole.includes('SUPER') || targetUserRole === 'ADMIN') {
      res.status(403).json({
        success: false,
        error: 'AdminAssignmentForbidden',
        message: 'Super Admin and Company Admin are executive/platform roles and cannot be assigned leads.',
      });
      return;
    }
    targetAgentId = targetAgent.id;

    // 2. leadAssignmentScope hierarchical team scoping policy check
    const roleUpper = String(userRole || '').toUpperCase();
    if (wsSettings.leadAssignmentScope === 'REPORTING_TEAM_ONLY' && roleUpper !== 'ADMIN' && roleUpper !== 'SUPER_ADMIN') {
      const isSameTeam = await checkSameReportingTeam(tenantId, req.user!.userId, targetAgent.id);
      if (!isSameTeam) {
        res.status(403).json({
          success: false,
          error: 'Lead reassignment is restricted to your direct reporting team under workspace governance policy.',
          message: 'Lead reassignment is restricted to your direct reporting team under workspace governance policy.',
        });
        return;
      }
    }
  }

  const targetStage = body.stage ?? body.status;
  const updated = await prisma.salesLeadAssignment.update({
    where: { id },
    data: {
      ...(body.customerName !== undefined ? { customerName: body.customerName } : {}),
      ...(body.customerEmail !== undefined ? { customerEmail: body.customerEmail || null } : {}),
      ...(body.serviceInterest !== undefined ? { serviceInterest: body.serviceInterest || null } : {}),
      ...(body.segment !== undefined ? { segment: body.segment || null } : {}),
      ...(targetStage !== undefined ? { stage: targetStage } : {}),
      ...(body.kanbanPosition !== undefined ? { kanbanPosition: body.kanbanPosition } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.budgetAmount !== undefined ? { budgetAmount: body.budgetAmount } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.customFields !== undefined ? { customFields: body.customFields } : {}),
      ...(body.lostReason !== undefined ? { lostReason: body.lostReason } : {}),
      ...(body.lostReasonNotes !== undefined ? { lostReasonNotes: body.lostReasonNotes } : {}),
      ...(body.isDndActive !== undefined ? { isDndActive: body.isDndActive } : {}),
      ...(targetAgentId ? { assignedAgentId: targetAgentId } : {}),
      ...(body.followUpAt !== undefined ? { followUpAt: body.followUpAt ? new Date(body.followUpAt) : null } : {}),
    },
  });

  const leadHistoryWrites: Promise<unknown>[] = [];
  if (targetStage !== undefined && targetStage !== existing.stage) {
    const newStageVal = targetStage;
    leadHistoryWrites.push(prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: existing.id,
        actorUserId: req.user?.userId,
        action: 'LEAD_STAGE_CHANGED',
        note: `Lead stage changed from ${existing.stage} to ${newStageVal}`,
        metadata: { previousStage: existing.stage, newStage: newStageVal },
      },
    }));
  }
  if (targetAgentId) {
    leadHistoryWrites.push(prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: existing.id,
        actorUserId: req.user?.userId,
        action: 'LEAD_REASSIGNED',
        note: `Lead reassigned to ${targetAgentId}`,
        metadata: { previousAgentId: existing.assignedAgentId, newAgentId: targetAgentId },
      },
    }));

    if (targetAgentId !== existing.assignedAgentId) {
      const targetAgentProfile = await prisma.salesAgentProfile.findFirst({
        where: {
          tenantId,
          OR: [{ id: targetAgentId }, { userId: targetAgentId }],
        },
        include: { user: { select: { id: true, displayName: true, email: true } } },
      });
      if (targetAgentProfile) {
        await syncLeadConversationAssignment(tenantId, updated, targetAgentProfile);
        await syncMarketingContactForLead(updated).catch(() => undefined);
      }
    }
  }
  if (body.followUpAt !== undefined) {
    leadHistoryWrites.push(prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: existing.id,
        actorUserId: req.user?.userId,
        action: body.followUpAt ? 'CALLBACK_SCHEDULED' : 'CALLBACK_CLEARED',
        note: body.followUpAt ? `Callback scheduled for ${body.followUpAt}` : 'Callback cleared',
        metadata: { followUpAt: body.followUpAt },
      },
    }));
  }

  const historyHandledFields = new Set(['stage', 'assignedAgentId', 'followUpAt']);
  const changedDetailFields = Object.keys(body)
    .filter((field) => !historyHandledFields.has(field))
    .filter((field) => JSON.stringify((existing as any)[field] ?? null) !== JSON.stringify((body as any)[field] ?? null));
  if (changedDetailFields.length > 0) {
    leadHistoryWrites.push(prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: existing.id,
        actorUserId: req.user?.userId,
        action: 'LEAD_DETAILS_UPDATED',
        note: `Lead details updated: ${changedDetailFields.join(', ')}`,
        metadata: { changedFields: changedDetailFields },
      },
    }));
  }
  await Promise.all(leadHistoryWrites).catch(() => undefined);

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.stage_changed',
    payload: {
      id: updated.id,
      stage: updated.stage,
      kanbanPosition: updated.kanbanPosition,
      priority: updated.priority,
      budgetAmount: updated.budgetAmount,
      updatedAt: updated.updatedAt,
    },
    actorUserId: req.user?.userId,
  }).catch(() => undefined);

  // Sync mirrored marketing contact with updated lead fields (name, email, assignee)
  await syncMarketingContactForLead(updated).catch(() => undefined);

  res.json({ success: true, data: { ...updated, status: updated.stage }, error: null });
});

// DELETE /:id/permanent - Permanent hard delete (Admin strictly only)
leadsRouter.delete('/:id/permanent', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const user = req.user!;

  if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
    res.status(403).json({
      success: false,
      error: 'Permanent lead deletion is restricted to Admin strictly.',
      message: 'Permanent lead deletion is restricted to Admin strictly.',
    });
    return;
  }

  const existing = await prisma.salesLeadAssignment.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found in this workspace' });
    return;
  }

  const result = await deleteContactsAndLinkedLeadsTransactional(tenantId, {
    leadIds: [existing.id],
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: existing.id,
      actorUserId: user.userId,
      action: 'LEAD_PERMANENTLY_DELETED',
      note: `Lead permanently deleted by Admin ${user.displayName || user.role}`,
    },
  }).catch(() => undefined);

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.permanently_deleted',
    payload: { leadId: existing.id },
    actorUserId: user.userId,
  }).catch(() => undefined);

  res.json({
    success: true,
    message: 'Lead permanently deleted from database',
    data: {
      deletedLeadId: existing.id,
      deletedContactId: result.deletedContactId,
    },
    error: null,
  });
});

// DELETE /:id - Soft delete lead to Recycle Bin with strict role ownership & permissions
leadsRouter.delete('/:id', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const user = req.user!;
  const userRole = user.role as string;

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id, tenantId },
    include: {
      assignedAgent: {
        include: {
          user: { select: { id: true, displayName: true, email: true, phone: true } },
        },
      },
    },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found in this workspace' });
    return;
  }

  const customFields = (lead.customFields && typeof lead.customFields === 'object' && !Array.isArray(lead.customFields))
    ? (lead.customFields as Record<string, any>)
    : {};

  if (userRole === 'SALES_AGENT' || userRole === 'CLOSER') {
    const isCreatedByAgent = lead.createdById === user.userId;
    const isPersonalScanner =
      lead.source === 'WHATSAPP_PERSONAL_QR' ||
      customFields.scannedByUserId === user.userId ||
      customFields.scannerUserId === user.userId ||
      (user.displayName && customFields.scannedByName === user.displayName);

    if (!isCreatedByAgent && !isPersonalScanner) {
      res.status(403).json({
        success: false,
        error: 'Sales agents can only delete leads they created or scanned via their personal WhatsApp.',
        message: 'Sales agents can only delete leads they created or scanned via their personal WhatsApp.',
      });
      return;
    }
  } else if (userRole === 'MANAGER') {
    const ws = await prisma.aicloserWorkspace.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const wsSettings = (ws?.settings as Record<string, any>) || {};
    if (!wsSettings.allowManagerLeadDeletion) {
      res.status(403).json({
        success: false,
        error: 'Manager lead deletion is not enabled for this workspace.',
        message: 'Manager lead deletion is not enabled for this workspace.',
      });
      return;
    }
  } else if (userRole !== 'ADMIN' && userRole !== 'SUPER_ADMIN') {
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'You are not authorized to delete leads in this workspace.',
    });
    return;
  }

  const updated = await prisma.salesLeadAssignment.update({
    where: { id: lead.id },
    data: {
      stage: 'RECYCLED',
      customFields: {
        ...customFields,
        recycled: true,
        deletedAt: new Date().toISOString(),
        deletedByUserId: user.userId,
        deletedByName: user.displayName,
      },
      stageChangedAt: new Date(),
      updatedAt: new Date(),
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: lead.id,
      actorUserId: user.userId,
      action: 'LEAD_RECYCLED',
      note: `Lead moved to Recycle Bin by ${user.displayName || userRole}`,
      metadata: { deletedByUserId: user.userId, deletedByName: user.displayName },
    },
  }).catch(() => undefined);

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.recycled',
    payload: { leadId: lead.id, deletedByUserId: user.userId },
    actorUserId: user.userId,
  }).catch(() => undefined);

  res.json({
    success: true,
    message: 'Lead moved to recycle bin successfully',
    data: {
      deletedLeadId: lead.id,
      id: lead.id,
      stage: 'RECYCLED',
      recycled: true,
      deletedAt: new Date().toISOString(),
    },
    error: null,
  });
});

// POST /:id/restore - Restore soft-deleted lead from Recycle Bin back to NEW stage
leadsRouter.post('/:id/restore', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const user = req.user!;
  const userRole = user.role as string;

  if (userRole !== 'ADMIN' && userRole !== 'SUPER_ADMIN') {
    if (userRole === 'MANAGER') {
      const ws = await prisma.aicloserWorkspace.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      const wsSettings = (ws?.settings as Record<string, any>) || {};
      if (!wsSettings.allowManagerLeadDeletion) {
        res.status(403).json({
          success: false,
          error: 'Manager lead restore is not enabled for this workspace.',
          message: 'Manager lead restore is not enabled for this workspace.',
        });
        return;
      }
    } else {
      res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Only workspace administrators and authorized managers can restore leads from the recycle bin.',
      });
      return;
    }
  }

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id, tenantId },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found in this workspace' });
    return;
  }

  const customFields = (lead.customFields && typeof lead.customFields === 'object' && !Array.isArray(lead.customFields))
    ? { ...(lead.customFields as Record<string, any>) }
    : {};

  delete customFields.recycled;
  delete customFields.deletedAt;
  delete customFields.deletedByUserId;
  delete customFields.deletedByName;

  const restored = await prisma.salesLeadAssignment.update({
    where: { id: lead.id },
    data: {
      stage: 'NEW',
      customFields,
      stageChangedAt: new Date(),
      updatedAt: new Date(),
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: lead.id,
      actorUserId: user.userId,
      action: 'LEAD_RESTORED',
      note: `Lead restored from Recycle Bin by ${user.displayName || userRole}`,
    },
  }).catch(() => undefined);

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.restored',
    payload: { leadId: lead.id },
    actorUserId: user.userId,
  }).catch(() => undefined);

  res.json({
    success: true,
    message: 'Lead restored from recycle bin successfully',
    data: restored,
    error: null,
  });
});
const claimPoolSchema = z.object({
  assignedAgentId: z.string().min(1).optional(),
});

const inactiveLeadStages: SalesLeadStage[] = [
  'CLOSED_WON',
  'CLOSED_LOST',
  'CLOSED',
  'LOST',
  'PAID',
  'CONVERTED_FREE',
  'RECYCLED',
];

class PoolClaimError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function handlePoolClaim(req: Request, res: Response) {
  const tenantId = req.tenantId!;
  const poolItemId = String(req.params.poolItemId || req.params.id || '').trim();
  const parsed = claimPoolSchema.safeParse(req.body ?? {});

  if (!poolItemId) {
    res.status(400).json({ success: false, error: 'ValidationError', message: 'Pool item id is required' });
    return;
  }

  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'ValidationError', message: parsed.error.issues[0]?.message || 'Invalid claim request' });
    return;
  }

  const user = req.user!;
  const canClaim = await hasPermission(user.userId, tenantId, user.role, PERM_LEADS_CLAIM);
  if (!canClaim) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Lead claiming is not enabled for this user' });
    return;
  }

  const requestedAgentId = parsed.data.assignedAgentId;
  if (user.role === 'SALES_AGENT' && requestedAgentId) {
    const ownProfile = await prisma.salesAgentProfile.findFirst({
      where: { userId: user.userId, tenantId },
      select: { id: true },
    });
    if (!ownProfile || (requestedAgentId !== ownProfile.id && requestedAgentId !== user.userId)) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'Sales agents can only claim leads for themselves' });
      return;
    }
  }

  const profile = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      ...(user.role === 'SALES_AGENT'
        ? { userId: user.userId }
        : requestedAgentId
          ? { OR: [{ id: requestedAgentId }, { userId: requestedAgentId }] }
          : { userId: user.userId }),
    },
  });

  // `leads:claim` is the single permission source of truth. Older profiles
  // may have canClaimLeads=false while the admin has granted the granular
  // permission, so do not reject those users a second time here.
  if (!profile || profile.status !== 'ACTIVE') {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Only active sales closers with lead-claim access can claim leads' });
    return;
  }

  // Dynamically resolve entry stage of the Kanban board
  const stages = await getWorkspaceStages(tenantId);
  const initialStageKey = stages[0]?.key || 'NEW';
  const initialStageLabel = stages[0]?.label || 'New Lead';

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const wsSettings = (workspace?.settings as Record<string, any>) || {};
  const rrSettings = (wsSettings.roundRobinSettings as Record<string, any>) || {};
  const grabCapacity = Number(rrSettings.maxVisibleToCloser) || Number(wsSettings.poolCapacity) || (profile.maxActiveLeads && profile.maxActiveLeads > 0 ? profile.maxActiveLeads : 25);

  const initialStageCount = await prisma.salesLeadAssignment.count({
    where: {
      tenantId,
      assignedAgentId: profile.id,
      stage: initialStageKey as any,
      NOT: {
        customFields: {
          path: ['inGrabPool'],
          equals: true,
        },
      },
    },
  });

  const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN' || user.role === 'MANAGER';
  if (!isAdmin && initialStageCount >= grabCapacity) {
    res.status(400).json({
      success: false,
      error: 'CapacityReached',
      message: `You have reached your limit of ${grabCapacity} leads in ${initialStageLabel}. Advance existing leads to claim more.`,
      data: { initialStageCount, grabCapacity, initialStageKey, initialStageLabel },
    });
    return;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const poolItem = await tx.salesLeadPoolItem.findFirst({
        where: { id: poolItemId, tenantId },
        include: { convertedAssignment: true },
      });

      if (!poolItem) throw new PoolClaimError(404, 'NotFound', 'Lead pool item was not found in this workspace');

      if (poolItem.status !== 'OPEN') {
        if (poolItem.claimedByAgentId === profile.id && poolItem.convertedAssignment) {
          return { poolItem, lead: poolItem.convertedAssignment, deduplicated: false, idempotent: true };
        }
        throw new PoolClaimError(409, 'AlreadyClaimed', 'This lead has already been claimed');
      }

      if (poolItem.assignedAgentId && poolItem.assignedAgentId !== profile.id && user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN' && user.role !== 'MANAGER') {
        throw new PoolClaimError(409, 'ReservedForAnotherCloser', 'This lead is reserved for another closer');
      }

      const rawPhone = poolItem.customerPhone?.trim() || '';
      const phoneDigits = rawPhone.replace(/\D/g, '');
      const last10 = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : phoneDigits;
      const duplicateFilters: Array<Record<string, unknown>> = [];
      if (rawPhone) duplicateFilters.push({ customerPhone: rawPhone });
      if (last10.length >= 7) duplicateFilters.push({ customerPhone: { contains: last10 } });
      if (poolItem.customerEmail) duplicateFilters.push({ customerEmail: poolItem.customerEmail });

      const existingLead = duplicateFilters.length
        ? await tx.salesLeadAssignment.findFirst({
            where: { tenantId, OR: duplicateFilters },
            orderBy: { createdAt: 'asc' },
          })
        : null;

      const isThisPoolLead = Boolean(
        (poolItem.convertedAssignmentId && poolItem.convertedAssignmentId === existingLead?.id) ||
        (existingLead && ((existingLead.customFields as any)?.inGrabPool === true))
      );

      if (existingLead && existingLead.assignedAgentId !== profile.id) {
        if (isThisPoolLead || user.role === 'ADMIN' || user.role === 'SUPER_ADMIN' || user.role === 'MANAGER') {
          const customFields = (existingLead.customFields as Record<string, any>) || {};
          await tx.salesLeadAssignment.update({
            where: { id: existingLead.id },
            data: {
              assignedAgentId: profile.id,
              stage: initialStageKey as any,
              customFields: { ...customFields, inGrabPool: false, claimedFromPoolAt: new Date().toISOString() },
            },
          });
          existingLead.assignedAgentId = profile.id;
        } else {
          throw new PoolClaimError(409, 'LeadAlreadyAssigned', 'This customer already belongs to another closer in this workspace');
        }
      } else if (existingLead && (existingLead.customFields as any)?.inGrabPool === true) {
        const customFields = (existingLead.customFields as Record<string, any>) || {};
        await tx.salesLeadAssignment.update({
          where: { id: existingLead.id },
          data: {
            stage: initialStageKey as any,
            customFields: { ...customFields, inGrabPool: false, claimedFromPoolAt: new Date().toISOString() },
          },
        });
      }

      const reserved = await tx.salesLeadPoolItem.updateMany({
        where: { id: poolItem.id, tenantId, status: 'OPEN' },
        data: { status: 'CLAIMED', claimedByAgentId: profile.id, claimedAt: new Date() },
      });
      if (reserved.count !== 1) throw new PoolClaimError(409, 'AlreadyClaimed', 'This lead has already been claimed');

      const lead = existingLead ?? await tx.salesLeadAssignment.create({
        data: {
          tenantId,
          assignedAgentId: profile.id,
          createdById: user.userId,
          customerName: poolItem.customerName,
          customerPhone: poolItem.customerPhone,
          customerEmail: poolItem.customerEmail,
          source: poolItem.source,
          serviceInterest: poolItem.serviceInterest,
          segment: poolItem.segment,
          priority: poolItem.priority,
          budgetAmount: poolItem.budgetAmount,
          stage: initialStageKey as any,
          notes: poolItem.notes,
          conversationId: poolItem.conversationId,
        },
      });

      await tx.salesLeadPoolItem.update({
        where: { id: poolItem.id },
        data: {
          status: 'CLAIMED',
          claimedByAgentId: profile.id,
          convertedAssignmentId: lead.id,
          claimedAt: new Date(),
        },
      });

      await tx.salesActivityLog.create({
        data: {
          tenantId,
          assignmentId: lead.id,
          actorUserId: user.userId,
          action: existingLead ? 'LEAD_POOL_DEDUPLICATED' : 'LEAD_CLAIMED',
          note: existingLead
            ? 'Queue item linked to the existing tenant lead instead of creating a duplicate.'
            : 'Lead claimed from the shared pool.',
        },
      });

      const updatedPoolItem = await tx.salesLeadPoolItem.findUniqueOrThrow({ where: { id: poolItem.id } });
      return { poolItem: updatedPoolItem, lead, deduplicated: Boolean(existingLead), idempotent: false };
    });

    // Call recordPoolLeadClaimedByPeer to record competitive miss for any peer who had this lead slotted
    // and remove lead from slottedPoolLeads
    await recordPoolLeadClaimedByPeer(
      tenantId,
      poolItemId,
      profile.id,
      result.poolItem.customerName,
      result.poolItem.customerPhone || undefined,
      result.lead.id
    ).catch(() => undefined);

    await persistApiRealtimeEvent({
      tenantId,
      eventType: 'lead.claimed',
      payload: {
        id: result.lead.id,
        poolItemId,
        assignedAgentId: profile.id,
        agentCode: profile.agentCode,
        deduplicated: result.deduplicated,
      },
      actorUserId: user.userId,
    }).catch(() => undefined);

    // Sync mirrored marketing contact and conversation with newly assigned lead
    await syncMarketingContactForLead(result.lead).catch(() => undefined);
    await syncLeadConversationAssignment(tenantId, result.lead, profile).catch(() => undefined);

    res.json({ success: true, data: result, message: result.idempotent ? 'Lead was already claimed by this closer' : 'Lead claimed successfully', error: null });
  } catch (error: unknown) {
    if (error instanceof PoolClaimError) {
      res.status(error.status).json({ success: false, error: error.code, message: error.message });
      return;
    }
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      res.status(409).json({ success: false, error: 'DuplicateLead', message: 'This customer already exists in the workspace' });
      return;
    }
    throw error;
  }
}

// Canonical pool-item claim route. The shorter path remains a compatibility alias,
// and both routes deliberately reuse the same handler/business transaction.
leadsRouter.post('/pool/:poolItemId/claim', handlePoolClaim);
leadsRouter.post('/:poolItemId/claim', handlePoolClaim);

const transferLeadSchema = z.object({
  targetAgentId: z.string().min(1, 'Target agent ID is required'),
  note: z.string().optional(),
});

// POST /:id/transfer - Transfer & reassign lead with timeline tracking, activity logging, and conversation update
leadsRouter.post('/:id/transfer', validateBody(transferLeadSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { targetAgentId, note } = req.body as z.infer<typeof transferLeadSchema>;
  const user = req.user!;
  const userRole = user.role;
  const isSalesAgent = userRole === 'SALES_AGENT' || (userRole as string) === 'CLOSER';

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }
  const lead = check.lead;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const wsSettings = (workspace?.settings as Record<string, any>) || {};

  if (isSalesAgent && wsSettings.allowAgentLeadReassign === false) {
    res.status(403).json({
      success: false,
      error: 'Lead reassignment is disabled for sales agents in workspace control settings.',
      message: 'Lead reassignment is disabled for sales agents in workspace control settings.',
    });
    return;
  }

  const targetProfile = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      status: 'ACTIVE',
      OR: [
        { id: targetAgentId },
        { userId: targetAgentId },
        { agentCode: targetAgentId },
      ],
    },
    include: {
      user: { select: { id: true, displayName: true, email: true, phone: true, role: true } },
    },
  });

  if (!targetProfile) {
    res.status(400).json({
      success: false,
      error: 'InvalidAgent',
      message: 'Target agent not found or inactive in this workspace',
    });
    return;
  }

  const targetRole = String(targetProfile.user?.role || '').toUpperCase();
  if (targetRole === 'SUPER_ADMIN' || targetRole.includes('SUPER') || targetRole === 'ADMIN') {
    res.status(403).json({
      success: false,
      error: 'AdminAssignmentForbidden',
      message: 'Super Admin and Company Admin are executive/platform roles and cannot be assigned leads.',
    });
    return;
  }

  const roleUpper = String(userRole || '').toUpperCase();
  if (wsSettings.leadAssignmentScope === 'REPORTING_TEAM_ONLY' && roleUpper !== 'ADMIN' && roleUpper !== 'SUPER_ADMIN') {
    const isSameTeam = await checkSameReportingTeam(tenantId, user.userId, targetProfile.id);
    if (!isSameTeam) {
      res.status(403).json({
        success: false,
        error: 'Lead reassignment is restricted to your direct reporting team under workspace governance policy.',
        message: 'Lead reassignment is restricted to your direct reporting team under workspace governance policy.',
      });
      return;
    }
  }

  const updatedLead = await prisma.salesLeadAssignment.update({
    where: { id: lead.id },
    data: {
      assignedAgentId: targetProfile.id,
      updatedAt: new Date(),
    },
    include: {
      assignedAgent: {
        select: {
          id: true,
          agentCode: true,
          userId: true,
          user: { select: { id: true, displayName: true, email: true, phone: true } },
        },
      },
    },
  });

  const conv = lead.conversationId
    ? await prisma.appConversation.findFirst({
        where: { id: lead.conversationId, tenantId },
      })
    : await prisma.appConversation.findFirst({
        where: {
          tenantId,
          OR: [
            ...(lead.customerPhone ? [{ customerPhone: lead.customerPhone }] : []),
            ...(normalizeLeadPhone(lead.customerPhone) ? [{ customerPhone: normalizeLeadPhone(lead.customerPhone)! }] : []),
            { payload: { path: ['leadId'], equals: lead.id } },
          ],
        },
      });

  if (conv) {
    const payload = (conv.payload && typeof conv.payload === 'object' && !Array.isArray(conv.payload))
      ? { ...(conv.payload as Record<string, any>) }
      : {};
    payload.assignedTo = targetProfile.user?.displayName || targetProfile.agentCode;
    await prisma.appConversation.update({
      where: { id: conv.id },
      data: {
        assignedFreelancerId: targetProfile.id,
        assignedFreelancerName: targetProfile.user?.displayName || targetProfile.agentCode,
        payload: payload as unknown as Prisma.InputJsonValue,
        updatedAt: new Date(),
      },
    }).catch(() => undefined);
  }

  // Symmetrically synchronize MarketingContact
  await syncMarketingContactForLead(updatedLead).catch(() => undefined);

  const targetName = targetProfile.user?.displayName || targetProfile.agentCode || 'Teammate';
  const reasonText = note ? ` Reason: ${note}` : ' Reason: Manual handoff';

  await prisma.salesLeadTimelineEntry.create({
    data: {
      tenantId,
      leadId: lead.id,
      userId: user.userId,
      agentId: targetProfile.id,
      type: 'LEAD_TRANSFERRED',
      body: `Lead transferred to ${targetName}.${reasonText}`,
      metadata: { fromUserId: user.userId, toAgentId: targetProfile.id, note: note || null },
    },
  }).catch(() => undefined);

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: lead.id,
      actorUserId: user.userId,
      action: 'LEAD_REASSIGNED',
      note: `Lead transferred to ${targetName}.${reasonText}`,
      metadata: { fromUserId: user.userId, toAgentId: targetProfile.id, note: note || null },
    },
  }).catch(() => undefined);

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.transferred',
    payload: {
      leadId: lead.id,
      fromAgentId: lead.assignedAgentId,
      toAgentId: targetProfile.id,
      targetAgentName: targetName,
      note: note || null,
    },
    actorUserId: user.userId,
  }).catch(() => undefined);

  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.updated',
    payload: { leadId: lead.id, assignedAgentId: targetProfile.id },
    actorUserId: user.userId,
  }).catch(() => undefined);

  res.json({
    success: true,
    lead: updatedLead,
    message: `Lead successfully transferred to ${targetName}`,
    error: null,
  });
});


// GET /:id/notes - Get internal notes for a lead
leadsRouter.get('/:id/notes', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const entries = await prisma.salesLeadTimelineEntry.findMany({
    // Keep follow-up/task entries in the 360 history stream, not in notes.
    where: { leadId: check.lead.id, tenantId, type: 'NOTE' },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    success: true,
    data: {
      notes: entries,
      timelineNotes: entries,
      summaryNotes: check.lead.notes || '',
    },
    error: null,
  });
});

// POST /:id/notes - Add an internal note to a lead
leadsRouter.post('/:id/notes', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const rawBody = req.body || {};
  const noteText = (rawBody.body || rawBody.note || rawBody.content || rawBody.text || '').trim();

  if (!noteText) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'Note content cannot be empty' });
    return;
  }

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const entry = await prisma.salesLeadTimelineEntry.create({
    data: {
      tenantId,
      leadId: check.lead.id,
      type: 'NOTE',
      body: noteText,
      userId: req.user?.userId,
    },
  });

  res.status(201).json({ success: true, data: entry });
});

// PATCH /:id/notes/:noteId - Edit a timeline note
leadsRouter.patch('/:id/notes/:noteId', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const noteId = String(req.params.noteId);
  const { body } = req.body as { body?: string };

  if (!body || !body.trim()) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'Note content cannot be empty' });
    return;
  }

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const existingNote = await prisma.salesLeadTimelineEntry.findFirst({
    where: { id: noteId, leadId: check.lead.id, tenantId },
  });

  if (!existingNote) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Note not found' });
    return;
  }

  if (req.user?.role === 'SALES_AGENT' && existingNote.userId && existingNote.userId !== req.user.userId) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Cannot edit a note created by another user' });
    return;
  }

  const updated = await prisma.salesLeadTimelineEntry.update({
    where: { id: noteId },
    data: { body: body.trim() },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: check.lead.id,
      actorUserId: req.user?.userId,
      action: 'NOTE_UPDATED',
      note: 'Lead note updated',
      metadata: { noteId, previousBody: existingNote.body, body: updated.body },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: 'Note updated successfully', data: updated });
});

// DELETE /:id/notes/:noteId - Delete a timeline note
leadsRouter.delete('/:id/notes/:noteId', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const noteId = String(req.params.noteId);

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const existingNote = await prisma.salesLeadTimelineEntry.findFirst({
    where: { id: noteId, leadId: check.lead.id, tenantId },
  });

  if (!existingNote) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Note not found' });
    return;
  }

  if (req.user?.role === 'SALES_AGENT' && existingNote.userId && existingNote.userId !== req.user.userId) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Cannot delete a note created by another user' });
    return;
  }

  await prisma.salesLeadTimelineEntry.delete({
    where: { id: noteId },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: check.lead.id,
      actorUserId: req.user?.userId,
      action: 'NOTE_DELETED',
      note: 'Lead note deleted',
      metadata: { noteId, body: existingNote.body },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: 'Note deleted successfully', data: { deletedNoteId: noteId } });
});

// GET /:id/tasks - Get tasks for a lead
leadsRouter.get('/:id/tasks', async (req: Request, res: Response) => {
  const id = String(req.params.id);

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const tasks = await prisma.gxLeadTask.findMany({
    where: { salesLeadId: check.lead.id },
    orderBy: { dueAt: 'asc' },
  });

  res.json({ success: true, data: tasks });
});

// POST /:id/tasks - Create task for a lead
leadsRouter.post('/:id/tasks', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const rawBody = req.body || {};
  const title = (rawBody.title || rawBody.task || rawBody.name || rawBody.content || '').trim();
  const description = (rawBody.description || rawBody.desc || rawBody.notes || '').trim() || null;
  const rawDueAt = rawBody.dueAt || rawBody.dueDate || rawBody.due;
  const dueAt = rawDueAt && !isNaN(new Date(rawDueAt).getTime())
    ? new Date(rawDueAt)
    : new Date(Date.now() + 24 * 60 * 60 * 1000);
  const priority = (rawBody.priority || 'NORMAL').toUpperCase();

  if (!title) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'Task title is required' });
    return;
  }

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const task = await prisma.gxLeadTask.create({
    data: {
      salesLeadId: check.lead.id,
      ownerAgentId: check.lead.assignedAgentId || null,
      createdById: req.user?.userId,
      title,
      description,
      dueAt,
      priority,
      status: 'OPEN',
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: check.lead.tenantId,
      assignmentId: check.lead.id,
      actorUserId: req.user?.userId,
      action: 'FOLLOW_UP_CREATED',
      note: `Follow-up created: ${task.title}`,
      metadata: { taskId: task.id, dueAt: task.dueAt, priority: task.priority },
    },
  }).catch(() => undefined);

  res.status(201).json({ success: true, data: task });
});

// PATCH /:id/tasks/:taskId - Update task status, reschedule, or edit details
leadsRouter.patch('/:id/tasks/:taskId', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const taskId = String(req.params.taskId);
  const { status, title, description, dueAt, priority } = req.body as {
    status?: string;
    title?: string;
    description?: string;
    dueAt?: string;
    priority?: string;
  };

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const existingTask = await prisma.gxLeadTask.findFirst({
    where: { id: taskId, salesLeadId: check.lead.id },
  });
  if (!existingTask) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Task not found on this lead' });
    return;
  }

  const task = await prisma.gxLeadTask.update({
    where: { id: taskId },
    data: {
      ...(status !== undefined ? {
        status: status.toUpperCase(),
        completedAt: status.toUpperCase() === 'DONE' ? new Date() : null,
      } : {}),
      ...(title !== undefined ? { title: title.trim() } : {}),
      ...(description !== undefined ? { description: description.trim() } : {}),
      ...(dueAt !== undefined ? { dueAt: new Date(dueAt) } : {}),
      ...(priority !== undefined ? { priority: priority.toUpperCase() } : {}),
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: check.lead.tenantId,
      assignmentId: check.lead.id,
      actorUserId: req.user?.userId,
      action: 'FOLLOW_UP_UPDATED',
      note: `Follow-up ${task.title} updated to ${task.status}`,
      metadata: { taskId: task.id, previousStatus: existingTask.status, status: task.status },
    },
  }).catch(() => undefined);

  res.json({ success: true, data: task });
});

// DELETE /:id/tasks/:taskId - Delete a task
leadsRouter.delete('/:id/tasks/:taskId', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const taskId = String(req.params.taskId);

  const check = await verifyLeadAccess(id, req);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error, message: check.message });
    return;
  }

  const existingTask = await prisma.gxLeadTask.findFirst({
    where: { id: taskId, salesLeadId: check.lead.id },
  });
  if (!existingTask) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Task not found on this lead' });
    return;
  }

  await prisma.gxLeadTask.delete({
    where: { id: taskId },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId: check.lead.tenantId,
      assignmentId: check.lead.id,
      actorUserId: req.user?.userId,
      action: 'FOLLOW_UP_DELETED',
      note: `Follow-up deleted: ${existingTask.title}`,
      metadata: { taskId, dueAt: existingTask.dueAt, status: existingTask.status },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: 'Task deleted successfully' });
});

// GET /api/v1/leads/delta - High-efficiency delta sync for mobile and web offline sync
leadsRouter.get('/delta', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const since = req.query.since ? String(req.query.since) : undefined;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));

  const where: any = { tenantId };

  if (since) {
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) {
      where.updatedAt = { gt: sinceDate };
    }
  }

  // Closer scoping
  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    where.assignedAgentId = profile?.id ?? '__NO_ACCESS__';
  }

  const rows = await prisma.salesLeadAssignment.findMany({
    where,
    take: limit + 1,
    orderBy: { updatedAt: 'asc' },
    include: {
      assignedAgent: {
        select: {
          id: true,
          agentCode: true,
          user: { select: { displayName: true } },
        },
      },
    },
  });

  const hasMore = rows.length > limit;
  const leads = hasMore ? rows.slice(0, limit) : rows;
  const lastLead = leads[leads.length - 1];
  const nextSyncCursor = lastLead?.updatedAt?.toISOString() || since || new Date().toISOString();

  res.json({
    success: true,
    data: {
      leads,
      hasMore,
      nextSyncCursor,
      count: leads.length,
      serverTime: new Date().toISOString(),
    },
    error: null,
  });
});


const reassignLeadSchema = z.object({
  assignedAgentId: z.string().min(1, 'Target assignedAgentId is required'),
  reason: z.string().optional(),
});

// POST /:id/reassign - Dedicated lead reassignment endpoint
leadsRouter.post('/:id/reassign', requirePermissions(PERM_LEADS_REASSIGN), validateBody(reassignLeadSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { assignedAgentId, reason } = req.body as z.infer<typeof reassignLeadSchema>;

  const lead = await prisma.salesLeadAssignment.findUnique({
    where: { id },
  });

  if (!lead) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found in this workspace' });
    return;
  }

  if (lead.tenantId !== tenantId) {
    res.status(403).json({
      success: false,
      code: 'TENANT_ISOLATION_VIOLATION',
      error: 'TenantIsolationViolation',
      message: 'Cross-tenant reassignment is strictly prohibited: lead belongs to another workspace',
    });
    return;
  }

  // Resolve target agent profile
  const targetAgent = await prisma.salesAgentProfile.findFirst({
    where: {
      OR: [
        { id: assignedAgentId },
        { userId: assignedAgentId },
      ],
    },
    include: { user: { select: { id: true, displayName: true, role: true } } },
  });

  if (!targetAgent) {
    res.status(404).json({
      success: false,
      code: 'AGENT_NOT_IN_WORKSPACE',
      error: 'AgentNotInWorkspace',
      message: 'Target agent not found in workspace',
    });
    return;
  }

  if (targetAgent.tenantId !== tenantId) {
    res.status(403).json({
      success: false,
      code: 'TENANT_ISOLATION_VIOLATION',
      error: 'TenantIsolationViolation',
      message: 'Target agent belongs to a different workspace',
    });
    return;
  }

  if (targetAgent.status !== 'ACTIVE') {
    res.status(400).json({
      success: false,
      code: 'AGENT_NOT_ACTIVE',
      error: 'AgentNotActive',
      message: `Target agent is not active (status: ${targetAgent.status}). Only ACTIVE agents can be assigned.`,
    });
    return;
  }

  if (targetAgent.user.role === 'ADMIN' || targetAgent.user.role === 'SUPER_ADMIN') {
    res.status(400).json({
      success: false,
      code: 'AGENT_NOT_ACTIVE',
      error: 'InvalidTargetRole',
      message: 'Administrators and Super Admins cannot be assigned leads. Target must be a sales agent or closer.',
    });
    return;
  }

  // Idempotent duplicate check
  if (lead.assignedAgentId === targetAgent.id) {
    res.status(200).json({
      success: true,
      code: 'DUPLICATE_ASSIGNMENT',
      message: `Lead is already assigned to ${targetAgent.user.displayName || targetAgent.agentCode} (idempotent)`,
      data: {
        id: lead.id,
        assignedAgentId: targetAgent.id,
        agentCode: targetAgent.agentCode,
        idempotent: true,
      },
      error: null,
    });
    return;
  }

  const updated = await prisma.salesLeadAssignment.update({
    where: { id: lead.id },
    data: {
      assignedAgentId: targetAgent.id,
      updatedAt: new Date(),
    },
  });

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: lead.id,
      actorUserId: req.user?.userId,
      action: 'LEAD_REASSIGNED',
      note: `Lead reassigned to ${targetAgent.user.displayName || targetAgent.agentCode}${reason ? ': ' + reason : ''}`,
      metadata: { previousAgentId: lead.assignedAgentId, newAgentId: targetAgent.id, reason },
    },
  }).catch(() => undefined);

  // Symmetrically sync linked MarketingContact and appConversation with new assignee
  const normPhone = normalizeLeadPhone(lead.customerPhone);
  await prisma.marketingContact.updateMany({
    where: {
      tenantId,
      OR: [
        { leadId: lead.id },
        ...(normPhone ? [{ e164Phone: normPhone }] : []),
      ],
    },
    data: {
      assignedAgentId: targetAgent.id,
      updatedAt: new Date(),
    },
  }).catch(() => undefined);

  await syncLeadConversationAssignment(tenantId, updated, targetAgent).catch(() => undefined);

  await persistApiRealtimeEvent({
    tenantId,
    actorUserId: req.user?.userId,
    audienceRoles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SALES_AGENT'],
    eventType: 'lead.reassigned',
    payload: { id: lead.id, assignedAgentId: targetAgent.id, agentCode: targetAgent.agentCode },
  }).catch(() => undefined);

  res.json({
    success: true,
    data: updated,
    message: `Lead successfully reassigned to ${targetAgent.user.displayName || targetAgent.agentCode}`,
  });
});

// POST /bulk-reassign - Dedicated bulk lead reassignment endpoint
const bulkReassignSchema = z.object({
  leadIds: z.array(z.string().min(1)).min(1, 'Provide at least one lead ID to reassign'),
  assignedAgentId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  reason: z.string().optional(),
}).refine((d) => Boolean(d.assignedAgentId || d.agentId), {
  message: 'Target assignedAgentId or agentId is required',
  path: ['assignedAgentId'],
});

leadsRouter.post('/bulk-reassign', requirePermissions(PERM_LEADS_REASSIGN), validateBody(bulkReassignSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body as z.infer<typeof bulkReassignSchema>;
  const rawTargetAgentId = (body.assignedAgentId || body.agentId)!.trim();

  // Resolve target agent profile in this workspace
  const targetAgent = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      OR: [
        { id: rawTargetAgentId },
        { userId: rawTargetAgentId },
      ],
    },
    include: { user: { select: { id: true, displayName: true, role: true } } },
  });

  if (!targetAgent) {
    res.status(404).json({
      success: false,
      code: 'AGENT_NOT_IN_WORKSPACE',
      error: 'AgentNotInWorkspace',
      message: 'Target agent not found in workspace',
    });
    return;
  }

  if (targetAgent.status !== 'ACTIVE') {
    res.status(400).json({
      success: false,
      code: 'AGENT_NOT_ACTIVE',
      error: 'AgentNotActive',
      message: `Target agent is not active (status: ${targetAgent.status}). Only ACTIVE agents can be assigned.`,
    });
    return;
  }

  if (targetAgent.user.role === 'ADMIN' || targetAgent.user.role === 'SUPER_ADMIN') {
    res.status(400).json({
      success: false,
      code: 'INVALID_TARGET_ROLE',
      error: 'InvalidTargetRole',
      message: 'Administrators and Super Admins cannot be assigned leads. Target must be a sales closer.',
    });
    return;
  }

  // Find all matching leads strictly within this tenant
  const validLeads = await prisma.salesLeadAssignment.findMany({
    where: {
      tenantId,
      id: { in: body.leadIds },
    },
    select: { id: true, customerPhone: true, customerName: true, assignedAgentId: true },
  });

  if (validLeads.length === 0) {
    res.status(404).json({
      success: false,
      error: 'NotFound',
      message: 'No matching leads found in workspace to reassign',
    });
    return;
  }

  const validLeadIds = validLeads.map((l) => l.id);
  const phones = validLeads
    .map((l) => normalizeLeadPhone(l.customerPhone))
    .filter((p): p is string => Boolean(p));

  // Perform bulk reassignment in a transaction
  await prisma.$transaction(async (tx) => {
    // 1. Reassign SalesLeadAssignment records
    await tx.salesLeadAssignment.updateMany({
      where: {
        tenantId,
        id: { in: validLeadIds },
      },
      data: {
        assignedAgentId: targetAgent.id,
        updatedAt: new Date(),
      },
    });

    // 2. Reassign mirrored MarketingContact records
    const contactOrConditions: Array<Record<string, unknown>> = [{ leadId: { in: validLeadIds } }];
    if (phones.length > 0) {
      contactOrConditions.push({ e164Phone: { in: phones } });
    }
    await tx.marketingContact.updateMany({
      where: {
        tenantId,
        OR: contactOrConditions,
      },
      data: {
        assignedAgentId: targetAgent.id,
        updatedAt: new Date(),
      },
    });

    // 3. Activity logs for all reassigned leads
    for (const lead of validLeads) {
      await tx.salesActivityLog.create({
        data: {
          tenantId,
          assignmentId: lead.id,
          actorUserId: req.user?.userId,
          action: 'LEAD_REASSIGNED',
          note: `Lead reassigned to ${targetAgent.user.displayName || targetAgent.agentCode}${body.reason ? ': ' + body.reason : ''}`,
          metadata: { previousAgentId: lead.assignedAgentId, newAgentId: targetAgent.id, reason: body.reason, isBulk: true },
        },
      });
    }
  });

  // Reassign linked conversations
  for (const lead of validLeads) {
    await syncLeadConversationAssignment(tenantId, lead, targetAgent).catch(() => undefined);
  }

  // Emit realtime events
  for (const lead of validLeads) {
    await persistApiRealtimeEvent({
      tenantId,
      actorUserId: req.user?.userId,
      audienceRoles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SALES_AGENT'],
      eventType: 'lead.reassigned',
      payload: { id: lead.id, assignedAgentId: targetAgent.id, agentCode: targetAgent.agentCode },
    }).catch(() => undefined);
  }

  res.json({
    success: true,
    message: `Successfully reassigned ${validLeadIds.length} lead(s) to ${targetAgent.user.displayName || targetAgent.agentCode}`,
    data: {
      reassignedLeadIds: validLeadIds,
      assignedAgentId: targetAgent.id,
      agentCode: targetAgent.agentCode,
      count: validLeadIds.length,
    },
    error: null,
  });
});




// ==========================================
// Unified Lead Import & Multi-Source Ingestion
// ==========================================

const unifiedImportSchema = z.object({
  source: z.string().default('CSV'),
  rows: z.array(
    z.object({
      customerName: z.string().min(1, 'Customer name is required'),
      customerPhone: z.string().optional(),
      customerEmail: z.string().optional(),
      serviceInterest: z.string().optional(),
      budgetAmount: z.number().optional(),
      notes: z.string().optional(),
      customFields: z.record(z.any()).optional(),
    })
  ).min(1, 'Provide at least one row to import'),
  distributionMode: z.enum(['AUTO', 'ROUND_ROBIN', 'POOL', 'MANUAL']).default('AUTO'),
  duplicateAction: z.enum(['SKIP', 'UPDATE', 'OVERWRITE']).default('SKIP'),
});

// POST /import - Unified Lead Import for CSV, Excel, WhatsApp, Google Sheets
leadsRouter.post('/import', requirePermissions(PERM_LEADS_REASSIGN), validateBody(unifiedImportSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { source, rows, duplicateAction, distributionMode } = req.body;
  const upperSource = source.toUpperCase().trim();

  let createdCount = 0;
  let updatedCount = 0;
  let skippedDuplicates = 0;
  const sampleAssignments: Array<{ leadId: string; customerName: string; stage: string; assignedAgentId: string | null }> = [];

  // Fetch a fallback profile for required assignedAgentId field
  const fallbackAgent = await prisma.salesAgentProfile.findFirst({
    where: { tenantId, status: 'ACTIVE', user: { role: 'SALES_AGENT', packageStatus: 'ACTIVE' } },
  }) || await prisma.salesAgentProfile.findFirst({ where: { tenantId, user: { role: 'SALES_AGENT' } } })
  || await prisma.salesAgentProfile.findFirst({ where: { tenantId } });

  if (!fallbackAgent) {
    res.status(409).json({ success: false, error: 'NoAgentProfiles', message: 'No agent profile found in workspace to attach leads' });
    return;
  }

  for (const row of rows) {
    const res = await upsertCompanyLead({
      tenantId,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      customerEmail: row.customerEmail,
      serviceInterest: row.serviceInterest,
      budgetAmount: row.budgetAmount,
      notes: row.notes,
      customFields: row.customFields,
      source: upperSource,
      duplicateAction: duplicateAction as any,
      distributionMode: distributionMode as any,
      actorUserId: req.user?.userId,
    });

    if (res.wasCreated) createdCount++;
    else if (res.wasUpdated) updatedCount++;
    else skippedDuplicates++;

    if (sampleAssignments.length < 10 && res.lead) {
      sampleAssignments.push({
        leadId: res.lead.id,
        customerName: res.lead.customerName,
        stage: res.lead.stage,
        assignedAgentId: res.lead.assignedAgentId,
      });
    }
  }

  res.status(201).json({
    success: true,
    message: `Import complete: ${createdCount} created, ${updatedCount} updated, ${skippedDuplicates} duplicates skipped`,
    data: {
      source: upperSource,
      totalRows: rows.length,
      createdCount,
      updatedCount,
      skippedDuplicates,
      sampleAssignments,
    },
    error: null,
  });
});

// POST /import/google-sheets - Google Sheets lead ingestion
const googleSheetsImportSchema = z.object({
  spreadsheetUrl: z.string().optional(),
  sheetRows: z.array(z.record(z.any())).optional(),
  distributionMode: z.enum(['AUTO', 'ROUND_ROBIN', 'POOL', 'MANUAL']).default('AUTO'),
});

leadsRouter.post('/import/google-sheets', requirePermissions(PERM_LEADS_REASSIGN), validateBody(googleSheetsImportSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { spreadsheetUrl, sheetRows } = req.body;

  let rowsToIngest: Array<any> = [];

  if (Array.isArray(sheetRows) && sheetRows.length > 0) {
    rowsToIngest = sheetRows.map((r) => ({
      customerName: r.name || r.customerName || r['Client Name'] || r['Full Name'] || 'Inbound Lead',
      customerPhone: r.phone || r.customerPhone || r['Phone'] || r['Mobile'] || r['Contact Number'],
      customerEmail: r.email || r.customerEmail || r['Email'],
      serviceInterest: r.service || r.serviceInterest || r['Service'] || r['Requirement'],
      notes: r.notes || r['Notes'] || r['Remarks'] || 'Imported from Google Sheets',
    }));
  } else if (spreadsheetUrl) {
    // If public Google Sheet URL provided, fetch CSV export
    try {
      let exportUrl = spreadsheetUrl;
      const match = spreadsheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (match) {
        exportUrl = `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv`;
      }

      const fetchRes = await fetch(exportUrl);
      if (fetchRes.ok) {
        const csvText = await fetchRes.text();
        const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 1) {
          const headers = lines[0].split(',').map((h) => h.replace(/"/g, '').trim().toLowerCase());
          const nameIdx = headers.findIndex((h) => h.includes('name'));
          const phoneIdx = headers.findIndex((h) => h.includes('phone') || h.includes('mobile'));
          const emailIdx = headers.findIndex((h) => h.includes('email'));

          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map((c) => c.replace(/"/g, '').trim());
            if (cols.length > 0) {
              rowsToIngest.push({
                customerName: nameIdx >= 0 ? cols[nameIdx] : `Lead #${i}`,
                customerPhone: phoneIdx >= 0 ? cols[phoneIdx] : null,
                customerEmail: emailIdx >= 0 ? cols[emailIdx] : null,
                notes: 'Imported from Google Sheet ' + spreadsheetUrl.slice(0, 50),
              });
            }
          }
        }
      }
    } catch (err) {
      logger.warn('Failed to fetch public Google Sheets export URL', { error: String(err) });
    }
  }

  if (rowsToIngest.length === 0) {
    res.status(400).json({
      success: false,
      error: 'NoData',
      message: 'No valid lead rows found in sheet payload or provided Google Sheets URL',
    });
    return;
  }

  // Forward to internal import processing
  const fallbackAgent = await prisma.salesAgentProfile.findFirst({
    where: { tenantId, status: 'ACTIVE', user: { role: 'SALES_AGENT' } },
  }) || await prisma.salesAgentProfile.findFirst({ where: { tenantId, user: { role: 'SALES_AGENT' } } });

  let createdCount = 0;
  for (const row of rowsToIngest) {
    const rawPhone = String(row.customerPhone || '').replace(/\D/g, '');
    const normalizedPhone = rawPhone.length === 10 ? `+91${rawPhone}` : (rawPhone ? `+${rawPhone}` : null);

    const lead = await prisma.salesLeadAssignment.create({
      data: {
        tenantId,
        assignedAgentId: fallbackAgent ? fallbackAgent.id : '__UNASSIGNED__',
        createdById: req.user?.userId,
        customerName: row.customerName,
        customerPhone: normalizedPhone,
        customerEmail: row.customerEmail,
        source: 'GOOGLE_SHEETS',
        notes: row.notes || 'Google Sheets Lead',
        stage: 'NEW',
      },
    });

    await assignLeadToNextCloser({
      tenantId,
      leadId: lead.id,
      source: 'GOOGLE_SHEETS',
      actorUserId: req.user?.userId,
    }).catch(() => undefined);

    createdCount++;
  }

  res.status(201).json({
    success: true,
    message: `Successfully ingested ${createdCount} leads from Google Sheets`,
    data: { createdCount, source: 'GOOGLE_SHEETS' },
    error: null,
  });
});

// POST /intake/email - Inbound email enquiry ingestion
const emailIntakeSchema = z.object({
  senderEmail: z.string().email('Valid sender email required'),
  senderName: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().min(1, 'Email body is required'),
  extractedPhone: z.string().optional(),
  serviceInterest: z.string().optional(),
});

leadsRouter.post('/intake/email', validateBody(emailIntakeSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { senderEmail, senderName, subject, body, extractedPhone, serviceInterest } = req.body;

  const fallbackAgent = await prisma.salesAgentProfile.findFirst({
    where: { tenantId, status: 'ACTIVE', user: { role: 'SALES_AGENT' } },
  }) || await prisma.salesAgentProfile.findFirst({ where: { tenantId, user: { role: 'SALES_AGENT' } } });

  const rawPhone = String(extractedPhone || '').replace(/\D/g, '');
  const normalizedPhone = rawPhone.length === 10 ? `+91${rawPhone}` : (rawPhone ? `+${rawPhone}` : null);

  const lead = await prisma.salesLeadAssignment.create({
    data: {
      tenantId,
      assignedAgentId: fallbackAgent ? fallbackAgent.id : '__UNASSIGNED__',
      customerName: senderName || senderEmail.split('@')[0],
      customerEmail: senderEmail.toLowerCase().trim(),
      customerPhone: normalizedPhone,
      source: 'EMAIL',
      serviceInterest: serviceInterest || subject || 'Email Inquiry',
      notes: `Subject: ${subject || 'No subject'}\n\n${body.slice(0, 300)}`,
      stage: 'NEW',
    },
  });

  const assignment = await assignLeadToNextCloser({
    tenantId,
    leadId: lead.id,
    source: 'EMAIL',
    actorUserId: req.user?.userId,
  });

  res.status(201).json({
    success: true,
    message: 'Email enquiry successfully ingested into lead pipeline',
    data: {
      leadId: lead.id,
      stage: assignment.stage,
      assignedAgentId: assignment.assignedAgentId,
      source: 'EMAIL',
    },
    error: null,
  });
});

// POST /intake/webhook/:sourceKey - Generic intake webhook (IndiaMART, Justdial, Facebook Ads, Google Ads)
leadsRouter.post('/intake/webhook/:sourceKey', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const sourceKey = String(req.params.sourceKey || 'WEBHOOK').toUpperCase();
  const body = req.body || {};

  // Extract common lead properties regardless of vendor payload structure
  const customerName = body.customerName || body.name || body.sender_name || body.full_name || body.ContactName || 'Online Inbound Lead';
  const customerPhone = body.customerPhone || body.phone || body.mobile || body.sender_mobile || body.MobileNo || body.phone_number;
  const customerEmail = body.customerEmail || body.email || body.sender_email || body.Email;
  const query = body.query || body.requirement || body.subject || body.message || body.service || '';

  const rawPhone = String(customerPhone || '').replace(/\D/g, '');
  const normalizedPhone = rawPhone.length === 10 ? `+91${rawPhone}` : (rawPhone ? `+${rawPhone}` : null);

  const fallbackAgent = await prisma.salesAgentProfile.findFirst({
    where: { tenantId, status: 'ACTIVE', user: { role: 'SALES_AGENT' } },
  }) || await prisma.salesAgentProfile.findFirst({ where: { tenantId, user: { role: 'SALES_AGENT' } } });

  const lead = await prisma.salesLeadAssignment.create({
    data: {
      tenantId,
      assignedAgentId: fallbackAgent ? fallbackAgent.id : '__UNASSIGNED__',
      customerName,
      customerPhone: normalizedPhone,
      customerEmail: customerEmail ? String(customerEmail).toLowerCase().trim() : null,
      source: sourceKey,
      serviceInterest: query ? String(query).slice(0, 100) : sourceKey,
      notes: `Inbound lead from ${sourceKey}: "${String(query).slice(0, 250)}"`,
      stage: 'NEW',
    },
  });

  const assignment = await assignLeadToNextCloser({
    tenantId,
    leadId: lead.id,
    source: sourceKey,
  });

  res.status(201).json({
    success: true,
    message: `Lead ingested from ${sourceKey} webhook`,
    data: {
      leadId: lead.id,
      stage: assignment.stage,
      assignedAgentId: assignment.assignedAgentId,
      source: sourceKey,
    },
    error: null,
  });
});

// GET /whatsapp-desktop/status & POST /whatsapp-desktop/sync
leadsRouter.get('/whatsapp-desktop/status', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const [channel, activeSessions, totalConversations, totalContacts] = await Promise.all([
    prisma.whatsAppChannel.findFirst({
      where: { tenantId },
      select: { status: true, displayPhoneNumber: true, verifiedName: true, lastSyncedAt: true, phoneNumberId: true },
    }),
    prisma.appClientSession.count({
      where: { tenantId, status: 'ACTIVE' },
    }),
    prisma.appConversation.count({ where: { tenantId, serviceSlug: 'whatsapp' } }),
    prisma.marketingContact.count({ where: { tenantId } }),
  ]);

  const clientStatus = channel ? channel.status : (activeSessions > 0 ? 'CONNECTED' : 'NOT_CONFIGURED');

  res.json({
    success: true,
    data: {
      clientStatus,
      isConfigured: Boolean(channel),
      phoneNumber: channel?.displayPhoneNumber || null,
      verifiedName: channel?.verifiedName || null,
      sessionName: 'WhatsApp Linked Device Desktop Gateway',
      totalSyncedChats: totalConversations,
      totalSyncedContacts: totalContacts,
      lastSyncHeartbeat: channel?.lastSyncedAt?.toISOString() || new Date().toISOString(),
      qrScanRequired: clientStatus !== 'ACTIVE' && clientStatus !== 'CONNECTED',
    },
    error: null,
  });
});

leadsRouter.post('/whatsapp-desktop/sync', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { contacts = [] } = req.body;

  let ingested = 0;
  for (const c of contacts) {
    const rawPhone = String(c.phone || c.jid || '').replace(/\D/g, '');
    if (!rawPhone) continue;
    const normalizedPhone = rawPhone.length === 10 ? `+91${rawPhone}` : `+${rawPhone}`;

    await prisma.marketingContact.upsert({
      where: {
        tenantId_e164Phone: {
          tenantId,
          e164Phone: normalizedPhone,
        },
      },
      create: {
        tenantId,
        fullName: c.name || normalizedPhone,
        e164Phone: normalizedPhone,
        source: 'WHATSAPP_DESKTOP',
      },
      update: {
        fullName: c.name || undefined,
      },
    }).catch(() => undefined);
    ingested++;
  }

  res.json({
    success: true,
    message: `Synced ${ingested} WhatsApp desktop contacts`,
    data: { ingestedCount: ingested },
    error: null,
  });
});
