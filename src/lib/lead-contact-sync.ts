import { prisma } from './prisma.js';
import { persistApiRealtimeEvent } from './realtime.js';

export function normalizeLeadPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (String(raw).trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

type LeadContactSource = {
  tenantId: string;
  id: string;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  source?: string | null;
  assignedAgentId?: string | null;
};

/** Keep the CRM lead and the contacts directory tied to the same record. */
export async function syncMarketingContactForLead(lead: LeadContactSource) {
  const phone = normalizeLeadPhone(lead.customerPhone);
  if (!phone) return null;

  return prisma.marketingContact.upsert({
    where: {
      tenantId_e164Phone: {
        tenantId: lead.tenantId,
        e164Phone: phone,
      },
    },
    create: {
      tenantId: lead.tenantId,
      fullName: lead.customerName?.trim() || 'Inbound Lead',
      e164Phone: phone,
      email: lead.customerEmail || null,
      source: String(lead.source || 'MANUAL').toUpperCase(),
      leadId: lead.id,
      assignedAgentId: lead.assignedAgentId || null,
    },
    update: {
      fullName: lead.customerName?.trim() || undefined,
      email: lead.customerEmail || undefined,
      source: lead.source ? String(lead.source).toUpperCase() : undefined,
      leadId: lead.id,
      assignedAgentId: lead.assignedAgentId || null,
      updatedAt: new Date(),
    },
  });
}

export interface DeleteContactLeadResult {
  deletedContactIds: string[];
  deletedLeadIds: string[];
  deletedContactId: string | null;
  deletedLeadId: string | null;
}

/**
 * Atomically delete one or more contacts and their linked Kanban leads in a single database transaction.
 *
 * Symmetrically and safely cleans up:
 * 1. SalesLeadPoolItem (clears convertedAssignmentId so pool item is not locked)
 * 2. GxLeadTask (deletes lead tasks/follow-ups)
 * 3. SalesLeadTimelineEntry (deletes notes and timeline entries)
 * 4. GxLeadIdentityLink (deletes identity links)
 * 5. SalesActivityLog (deletes activity logs)
 * 6. ContactGroupMembership, WhatsAppCampaignRecipient, WhatsAppOptIn (cleans up contact join tables)
 * 7. SalesLeadAssignment + MarketingContact
 */
export async function deleteContactsAndLinkedLeadsTransactional(
  tenantId: string,
  target: {
    contactIds?: string[];
    leadIds?: string[];
  }
): Promise<DeleteContactLeadResult> {
  const initialContactIds = (target.contactIds || []).map((id) => String(id).trim()).filter(Boolean);
  const initialLeadIds = (target.leadIds || []).map((id) => String(id).trim()).filter(Boolean);

  const resolvedContactIds = new Set<string>(initialContactIds);
  const resolvedLeadIds = new Set<string>(initialLeadIds);
  const resolvedPhones = new Set<string>();

  // 1. If contact IDs provided, look up their records to discover linked leadIds and phones
  if (resolvedContactIds.size > 0) {
    const contacts = await prisma.marketingContact.findMany({
      where: {
        tenantId,
        id: { in: Array.from(resolvedContactIds) },
      },
      select: { id: true, leadId: true, e164Phone: true },
    });
    for (const c of contacts) {
      resolvedContactIds.add(c.id);
      if (c.leadId) resolvedLeadIds.add(c.leadId);
      if (c.e164Phone) {
        resolvedPhones.add(c.e164Phone);
        const norm = normalizeLeadPhone(c.e164Phone);
        if (norm) resolvedPhones.add(norm);
      }
    }
  }

  // 2. If lead IDs provided, look up their records to discover customerPhones
  if (resolvedLeadIds.size > 0) {
    const leads = await prisma.salesLeadAssignment.findMany({
      where: {
        tenantId,
        id: { in: Array.from(resolvedLeadIds) },
      },
      select: { id: true, customerPhone: true },
    });
    for (const l of leads) {
      resolvedLeadIds.add(l.id);
      if (l.customerPhone) {
        resolvedPhones.add(l.customerPhone);
        const norm = normalizeLeadPhone(l.customerPhone);
        if (norm) resolvedPhones.add(norm);
      }
    }
  }

  // 3. Find any additional linked leads by matching phone in this tenant
  if (resolvedPhones.size > 0) {
    const matchingLeads = await prisma.salesLeadAssignment.findMany({
      where: {
        tenantId,
        customerPhone: { in: Array.from(resolvedPhones) },
      },
      select: { id: true },
    });
    for (const l of matchingLeads) {
      resolvedLeadIds.add(l.id);
    }
  }

  // 4. Find any additional linked contacts by leadId or matching phone in this tenant
  const contactLookupOr: Array<Record<string, unknown>> = [];
  if (resolvedLeadIds.size > 0) {
    contactLookupOr.push({ leadId: { in: Array.from(resolvedLeadIds) } });
  }
  if (resolvedPhones.size > 0) {
    contactLookupOr.push({ e164Phone: { in: Array.from(resolvedPhones) } });
  }
  if (contactLookupOr.length > 0) {
    const matchingContacts = await prisma.marketingContact.findMany({
      where: {
        tenantId,
        OR: contactLookupOr,
      },
      select: { id: true },
    });
    for (const c of matchingContacts) {
      resolvedContactIds.add(c.id);
    }
  }

  const finalContactIds = Array.from(resolvedContactIds);
  const finalLeadIds = Array.from(resolvedLeadIds);

  // 5. Execute deletion in an atomic database transaction
  await prisma.$transaction(async (tx) => {
    // A. Clean up child records and references for all target leads
    if (finalLeadIds.length > 0) {
      // A deleted customer must not reappear as an open, claimable pool item.
      await tx.salesLeadPoolItem.deleteMany({
        where: {
          tenantId,
          convertedAssignmentId: { in: finalLeadIds },
        },
      });

      // Delete lead tasks / follow-ups
      await tx.gxLeadTask.deleteMany({
        where: { salesLeadId: { in: finalLeadIds } },
      });

      // Delete timeline entries and internal notes
      await tx.salesLeadTimelineEntry.deleteMany({
        where: {
          tenantId,
          leadId: { in: finalLeadIds },
        },
      });

      // Delete identity links
      await tx.gxLeadIdentityLink.deleteMany({
        where: { salesLeadId: { in: finalLeadIds } },
      });

      // Delete activity logs
      await tx.salesActivityLog.deleteMany({
        where: {
          tenantId,
          assignmentId: { in: finalLeadIds },
        },
      });

      // Unlink any other contacts that point to these leads (preventing orphan references)
      await tx.marketingContact.updateMany({
        where: {
          tenantId,
          leadId: { in: finalLeadIds },
        },
        data: { leadId: null },
      });

      // Delete canonical SalesLeadAssignment records
      await tx.salesLeadAssignment.deleteMany({
        where: {
          tenantId,
          id: { in: finalLeadIds },
        },
      });
    }

    // B. Clean up child records and references for all target contacts
    if (finalContactIds.length > 0) {
      await tx.contactGroupMembership.deleteMany({
        where: { contactId: { in: finalContactIds } },
      });

      await tx.whatsAppCampaignRecipient.deleteMany({
        where: { contactId: { in: finalContactIds } },
      });

      await tx.whatsAppOptIn.deleteMany({
        where: { contactId: { in: finalContactIds } },
      });

      await tx.marketingContact.deleteMany({
        where: {
          tenantId,
          id: { in: finalContactIds },
        },
      });
    }
  });

  await persistApiRealtimeEvent({ tenantId, eventType: 'lead.deleted', payload: { deletedContactIds: finalContactIds, deletedLeadIds: finalLeadIds } }).catch(() => undefined);
  return {
    deletedContactIds: finalContactIds,
    deletedLeadIds: finalLeadIds,
    deletedContactId: finalContactIds[0] || null,
    deletedLeadId: finalLeadIds[0] || null,
  };
}


/** Atomically synchronizes linked conversation ownership whenever a lead is reassigned or claimed. */
export async function syncLeadConversationAssignment(
  tenantId: string,
  lead: { id: string; customerPhone?: string | null; conversationId?: string | null },
  targetAgent: { id: string; agentCode?: string | null; user?: { id?: string; displayName?: string | null; email?: string | null } | null }
) {
  const normPhone = normalizeLeadPhone(lead.customerPhone);
  const conv = lead.conversationId
    ? await prisma.appConversation.findFirst({
        where: { id: lead.conversationId, tenantId },
      })
    : await prisma.appConversation.findFirst({
        where: {
          tenantId,
          OR: [
            ...(lead.customerPhone ? [{ customerPhone: lead.customerPhone }] : []),
            ...(normPhone ? [{ customerPhone: normPhone }] : []),
            { payload: { path: ['leadId'], equals: lead.id } },
          ],
        },
      });

  if (conv) {
    const payload = (conv.payload && typeof conv.payload === 'object' && !Array.isArray(conv.payload))
      ? { ...(conv.payload as Record<string, any>) }
      : {};
    const displayName = targetAgent.user?.displayName || targetAgent.agentCode || 'Assigned Closer';
    payload.assignedTo = displayName;
    payload.assignedAgentId = targetAgent.id;
    payload.assignedFreelancerId = targetAgent.id;

    await prisma.appConversation.update({
      where: { id: conv.id },
      data: {
        assignedFreelancerId: targetAgent.id,
        assignedFreelancerName: displayName,
        payload: payload as any,
        updatedAt: new Date(),
      },
    }).catch(() => undefined);
  }
}
