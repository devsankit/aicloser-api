import { prisma } from './prisma.js';
import { randomUUID } from 'crypto';

export interface PoolLeadSlot {
  poolItemId: string;
  slottedAgentId: string;
  slottedAt: string;
  slotExpiresAt: string;
}

export interface MissedLeadRecord {
  id: string;
  leadId: string;
  poolItemId: string;
  agentId: string;
  customerName?: string;
  customerPhone?: string;
  missedAt: string;
  reason: string;
}

/**
 * Check if a closer is currently on an authorized break
 */
export async function isAgentOnBreak(
  tenantId: string,
  agentProfileId: string,
  userId?: string
): Promise<boolean> {
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const wsSettings = (workspace?.settings as Record<string, any>) || {};
  const activeBreaks = wsSettings.activeBreaks || {};

  const breakData = activeBreaks[agentProfileId] || (userId ? activeBreaks[userId] : null);
  if (breakData && breakData.isOnBreak) {
    const expiresAt = breakData.breakExpiresAt ? new Date(breakData.breakExpiresAt).getTime() : 0;
    if (expiresAt > Date.now()) {
      return true;
    }
  }

  // Also inspect profile permissions / custom fields
  const profile = await prisma.salesAgentProfile.findFirst({
    where: { id: agentProfileId, tenantId },
    select: { permissions: true },
  });
  const perms = (profile?.permissions as Record<string, any>) || {};
  if (perms.activeBreak && perms.activeBreak.isOnBreak) {
    const exp = perms.activeBreak.breakExpiresAt ? new Date(perms.activeBreak.breakExpiresAt).getTime() : 0;
    if (exp > Date.now()) {
      return true;
    }
  }

  return false;
}

/**
 * Check if closer is currently engaged in a live telephony call with the lead's number
 */
export async function isAgentOnLiveCall(
  tenantId: string,
  agentProfileId: string,
  customerPhone?: string | null
): Promise<boolean> {
  if (!customerPhone) return false;
  const digits = customerPhone.replace(/\D/g, '');
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  if (!last10) return false;

  const activeCall = await prisma.salesMobileCall.findFirst({
    where: {
      tenantId,
      agentId: agentProfileId,
      phoneNumber: { contains: last10 },
      status: { in: ['CONNECTED', 'INITIATED', 'RINGING'] },
      endedAt: null,
      startedAt: { gte: new Date(Date.now() - 45 * 60 * 1000) },
    },
  });

  return Boolean(activeCall);
}

/**
 * Synchronize and rotate grab pool slots (10-minute expiry) and detect missed leads
 */
export async function syncAndRotatePoolSlots(
  tenantId: string,
  requestingAgentProfileId?: string
) {
  const now = Date.now();
  const SLOT_DURATION_MS = 10 * 60 * 1000; // 10 minutes

  // 1. Fetch workspace settings
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const wsSettings = (workspace?.settings as Record<string, any>) || {};
  const slottedPoolLeads: Record<string, PoolLeadSlot> = { ...(wsSettings.slottedPoolLeads || {}) };
  const missedLeads: MissedLeadRecord[] = [...(wsSettings.missedLeads || [])];

  // 2. Query open pool items
  const openPoolItems = await prisma.salesLeadPoolItem.findMany({
    where: { tenantId, status: 'OPEN' },
    orderBy: { createdAt: 'asc' },
  });

  // 3. Query active closers for round-robin rotation
  const activeClosers = await prisma.salesAgentProfile.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      user: { role: 'SALES_AGENT' },
    },
    include: {
      user: { select: { id: true, displayName: true, email: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (activeClosers.length === 0) {
    return { openPoolItems, slottedPoolLeads, missedLeads, wsSettings };
  }

  let stateChanged = false;
  let unslottedCounter = 0;

  // 4. Process existing slots for open pool items
  for (const item of openPoolItems) {
    const slot = slottedPoolLeads[item.id];
    if (slot) {
      const expiresAt = new Date(slot.slotExpiresAt).getTime();
      if (expiresAt <= now) {
        // Slot has expired without being claimed!
        const closer = activeClosers.find((c) => c.id === slot.slottedAgentId);
        const onBreak = closer ? await isAgentOnBreak(tenantId, closer.id, closer.userId) : false;
        const onCall = closer ? await isAgentOnLiveCall(tenantId, closer.id, item.customerPhone) : false;

        if (onCall) {
          // Live call exemption: closer is actively talking to customer, extend their slot
          slot.slotExpiresAt = new Date(now + SLOT_DURATION_MS).toISOString();
          slot.slottedAt = new Date(now).toISOString();
          stateChanged = true;
        } else if (onBreak) {
          // Break mode exemption: closer is on break, no missed lead penalty, but rotate slot to next closer
          const currIdx = activeClosers.findIndex((c) => c.id === slot.slottedAgentId);
          const nextIdx = (currIdx + 1) % activeClosers.length;
          const nextCloser = activeClosers[nextIdx];

          slottedPoolLeads[item.id] = {
            poolItemId: item.id,
            slottedAgentId: nextCloser.id,
            slottedAt: new Date(now).toISOString(),
            slotExpiresAt: new Date(now + SLOT_DURATION_MS).toISOString(),
          };
          stateChanged = true;
        } else {
          // Record missed lead
          const missedRecord: MissedLeadRecord = {
            id: `missed-${randomUUID().slice(0, 8)}`,
            leadId: item.convertedAssignmentId || item.id,
            poolItemId: item.id,
            agentId: slot.slottedAgentId,
            customerName: item.customerName,
            customerPhone: item.customerPhone || undefined,
            missedAt: new Date(now).toISOString(),
            reason: '10-minute pool slot expired without claim',
          };
          missedLeads.unshift(missedRecord);

          // Find next closer index
          const currIdx = activeClosers.findIndex((c) => c.id === slot.slottedAgentId);
          const nextIdx = (currIdx + 1) % activeClosers.length;
          const nextCloser = activeClosers[nextIdx];

          // Re-slot lead to next closer
          slottedPoolLeads[item.id] = {
            poolItemId: item.id,
            slottedAgentId: nextCloser.id,
            slottedAt: new Date(now).toISOString(),
            slotExpiresAt: new Date(now + SLOT_DURATION_MS).toISOString(),
          };
          stateChanged = true;

          // Record activity log for missed pool lead (if linked to an assignment)
          if (item.convertedAssignmentId) {
            await prisma.salesActivityLog.create({
              data: {
                tenantId,
                assignmentId: item.convertedAssignmentId,
                actorUserId: closer?.userId,
                action: 'POOL_LEAD_MISSED',
                note: `Grab pool lead ${item.customerName} expired without claim by closer ${closer?.user?.displayName || slot.slottedAgentId}. Rotated to ${nextCloser.user?.displayName || nextCloser.agentCode}.`,
                metadata: { poolItemId: item.id, missedByAgentId: slot.slottedAgentId, rotatedToAgentId: nextCloser.id },
              },
            }).catch(() => undefined);
          }
        }
      }
    } else {
      // Unslotted open item: Distribute round-robin equally across all active closers
      const assignedCloser = activeClosers[unslottedCounter % activeClosers.length];
      unslottedCounter++;

      slottedPoolLeads[item.id] = {
        poolItemId: item.id,
        slottedAgentId: assignedCloser.id,
        slottedAt: new Date(now).toISOString(),
        slotExpiresAt: new Date(now + SLOT_DURATION_MS).toISOString(),
      };
      stateChanged = true;
    }
  }

  // Clean up slots for items that are no longer OPEN
  const openItemIds = new Set(openPoolItems.map((i) => i.id));
  for (const itemId of Object.keys(slottedPoolLeads)) {
    if (!openItemIds.has(itemId)) {
      delete slottedPoolLeads[itemId];
      stateChanged = true;
    }
  }

  // 5. Persist changes to workspace.settings if modified
  if (stateChanged) {
    await prisma.aicloserWorkspace.update({
      where: { id: tenantId },
      data: {
        settings: {
          ...wsSettings,
          slottedPoolLeads,
          missedLeads: missedLeads.slice(0, 500), // maintain last 500 missed
        } as any,
        updatedAt: new Date(),
      },
    });
  }

  return { openPoolItems, slottedPoolLeads, missedLeads, wsSettings };
}
