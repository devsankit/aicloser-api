import { prisma } from './prisma.js';
import { logger } from './logger.js';

export interface AssignmentResult {
  assigned: boolean;
  leadId: string;
  assignedAgentId: string | null;
  agentName: string | null;
  stage: string;
  distributionMode: string;
  source: string;
  sentToPool?: boolean;
  reason?: string;
}

export interface SourceRule {
  id: string;
  source: string; // e.g. WHATSAPP, GOOGLE_SHEETS, CSV, INDIAMART, FACEBOOK_ADS
  action: 'ROUND_ROBIN' | 'POOL' | 'MANUAL';
  allowedCloserIds?: string[];
  maxDailyLeads?: number;
}

// 1. Fetch eligible closers with STRICT admin & manager exclusion
export async function getEligibleClosers(tenantId: string, maxActiveQuota = 50) {
  // Fetch profiles that belong to SALES_AGENT users only
  const profiles = await prisma.salesAgentProfile.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      canClaimLeads: true,
      user: {
        role: 'SALES_AGENT', // STRICTLY exclude ADMIN, SUPER_ADMIN, and MANAGER
        packageStatus: 'ACTIVE', // STRICTLY exclude SUSPENDED or EXPIRED
      },
    },
    include: {
      user: {
        select: {
          id: true,
          displayName: true,
          email: true,
          phone: true,
          role: true,
        },
      },
      _count: {
        select: {
          leadAssignments: {
            where: {
              stage: { notIn: ['CLOSED_WON', 'CLOSED_LOST', 'LOST'] as any },
            },
          },
        },
      },
    },
  });

  return profiles.map((p) => {
    const activeLeads = p._count?.leadAssignments || 0;
    const isAtQuota = activeLeads >= maxActiveQuota;
    return {
      agentId: p.id,
      userId: p.userId,
      name: p.user?.displayName || 'Sales Agent',
      email: p.user?.email || null,
      phone: p.user?.phone || null,
      activeLeads,
      maxQuota: maxActiveQuota,
      isAvailable: !isAtQuota,
    };
  });
}

// 2. Main assignment orchestration
export async function assignLeadToNextCloser(params: {
  tenantId: string;
  leadId: string;
  source?: string;
  preferredCloserId?: string;
  actorUserId?: string;
}): Promise<AssignmentResult> {
  const { tenantId, leadId, source = 'DIRECT', preferredCloserId, actorUserId } = params;

  const lead = await prisma.salesLeadAssignment.findFirst({
    where: { id: leadId, tenantId },
  });

  if (!lead) {
    throw new Error(`Lead ${leadId} not found in workspace ${tenantId}`);
  }

  // Read workspace settings for round-robin & source rules
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const rrSettings = settings.roundRobinSettings || {
    enabled: true,
    mode: 'STRICT_ROUND_ROBIN',
    maxActiveLeadsPerCloser: 50,
    lastAssignedAgentId: null,
  };

  const sourceRules: SourceRule[] = settings.sourceDistributionRules || [];

  // Check source-specific rule (only if enabled)
  const matchedRule = sourceRules.find(
    (r) => r.source.toUpperCase() === source.toUpperCase() && (r as any).enabled !== false
  );

  // Enforce maxDailyLeads quota for this source if configured
  if (matchedRule?.maxDailyLeads && matchedRule.maxDailyLeads > 0) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todayCount = await prisma.salesLeadAssignment.count({
      where: {
        tenantId,
        source: { equals: source, mode: 'insensitive' },
        createdAt: { gte: startOfDay },
      },
    });

    if (todayCount > matchedRule.maxDailyLeads) {
      // Quota exceeded: route to pool so lead is preserved
      await prisma.salesLeadPoolItem.create({
        data: {
          tenantId,
          source,
          customerName: lead.customerName || 'Inbound Lead',
          customerPhone: lead.customerPhone,
          customerEmail: lead.customerEmail,
          status: 'OPEN',
          convertedAssignmentId: lead.id,
        },
      }).catch(() => undefined);

      await prisma.salesLeadAssignment.update({
        where: { id: lead.id },
        data: { stage: 'NEW', updatedAt: new Date() },
      });

      return {
        assigned: false,
        leadId: lead.id,
        assignedAgentId: null,
        agentName: null,
        stage: 'NEW',
        distributionMode: 'DAILY_QUOTA_CAP',
        source,
        sentToPool: true,
        reason: `Source ${source} reached daily cap of ${matchedRule.maxDailyLeads} leads`,
      };
    }
  }

  // If rule says POOL, move lead to grab pool instead of direct agent assignment
  if (matchedRule?.action === 'POOL') {
    await prisma.salesLeadPoolItem.create({
      data: {
        tenantId,
        source,
        customerName: lead.customerName || 'Inbound Lead',
        customerPhone: lead.customerPhone,
        customerEmail: lead.customerEmail,
        status: 'OPEN',
        convertedAssignmentId: lead.id,
      },
    }).catch(() => undefined);

    await prisma.salesLeadAssignment.update({
      where: { id: lead.id },
      data: { stage: 'NEW', updatedAt: new Date() },
    });

    return {
      assigned: false,
      leadId: lead.id,
      assignedAgentId: null,
      agentName: null,
      stage: 'NEW',
      distributionMode: 'GRAB_POOL',
      source,
      sentToPool: true,
      reason: `Source ${source} routed to Grab Pool per workspace rule`,
    };
  }

  // If rule says MANUAL or RR disabled, leave unassigned in NEW stage
  if (matchedRule?.action === 'MANUAL' || !rrSettings.enabled) {
    return {
      assigned: false,
      leadId: lead.id,
      assignedAgentId: null,
      agentName: null,
      stage: 'NEW',
      distributionMode: 'MANUAL',
      source,
      reason: 'Round-robin disabled or source routed to manual triage',
    };
  }

  // Fetch strictly eligible non-admin closers
  const maxQuota = rrSettings.maxActiveLeadsPerCloser || 50;
  let allClosers = await getEligibleClosers(tenantId, maxQuota);

  // If source rule limits closers to a specific pool
  if (Array.isArray(matchedRule?.allowedCloserIds) && matchedRule.allowedCloserIds.length > 0) {
    allClosers = allClosers.filter((c) => matchedRule.allowedCloserIds!.includes(c.agentId));
  }

  const availableClosers = allClosers.filter((c) => c.isAvailable);

  if (availableClosers.length === 0) {
    logger.warn('No eligible closers below quota for lead assignment', { tenantId, leadId, totalClosers: allClosers.length });
    // Push to pool as safety fallback so lead is never lost
    await prisma.salesLeadPoolItem.create({
      data: {
        tenantId,
        source,
        customerName: lead.customerName || 'Inbound Lead',
        customerPhone: lead.customerPhone,
        customerEmail: lead.customerEmail,
        status: 'OPEN',
        convertedAssignmentId: lead.id,
      },
    }).catch(() => undefined);

    return {
      assigned: false,
      leadId: lead.id,
      assignedAgentId: null,
      agentName: null,
      stage: 'NEW',
      distributionMode: 'UNASSIGNED_AT_QUOTA',
      source,
      sentToPool: true,
      reason: `All ${allClosers.length} closers are at quota or inactive`,
    };
  }

  // Select closer
  let selected = availableClosers[0];

  if (preferredCloserId) {
    const pref = availableClosers.find((c) => c.agentId === preferredCloserId);
    if (pref) selected = pref;
  } else if (rrSettings.mode === 'LOAD_BALANCED') {
    availableClosers.sort((a, b) => a.activeLeads - b.activeLeads);
    selected = availableClosers[0];
  } else {
    // STRICT_ROUND_ROBIN
    const lastIndex = availableClosers.findIndex((c) => c.agentId === rrSettings.lastAssignedAgentId);
    const nextIndex = lastIndex >= 0 ? (lastIndex + 1) % availableClosers.length : 0;
    selected = availableClosers[nextIndex];
  }

  // Assign lead
  const updated = await prisma.salesLeadAssignment.update({
    where: { id: lead.id },
    data: {
      assignedAgentId: selected.agentId,
      stage: lead.stage === 'NEW' ? 'ASSIGNED' : lead.stage,
      updatedAt: new Date(),
    },
  });

  // Save last assigned agent ID
  rrSettings.lastAssignedAgentId = selected.agentId;
  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        roundRobinSettings: rrSettings,
      },
      updatedAt: new Date(),
    },
  });

  // Log activity
  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: lead.id,
      actorUserId: actorUserId || null,
      action: 'LEAD_AUTOMATICALLY_ASSIGNED',
      note: `Assigned to ${selected.name} via ${rrSettings.mode} (source: ${source})`,
      metadata: {
        assignedAgentId: selected.agentId,
        source,
        mode: rrSettings.mode,
        previousAgentId: lead.assignedAgentId,
      },
    },
  }).catch(() => undefined);

  return {
    assigned: true,
    leadId: updated.id,
    assignedAgentId: selected.agentId,
    agentName: selected.name,
    stage: updated.stage,
    distributionMode: rrSettings.mode,
    source,
  };
}
