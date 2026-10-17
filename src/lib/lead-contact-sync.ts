import { prisma } from './prisma.js';

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
