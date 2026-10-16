import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { assignLeadToNextCloser } from './lead-assignment-engine.js';

export interface UpsertLeadParams {
  tenantId: string;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  source: string;
  serviceInterest?: string | null;
  budgetAmount?: number | null;
  notes?: string | null;
  customFields?: Record<string, any>;
  conversationId?: string | null;
  assignedAgentId?: string | null;
  createdById?: string | null;
  duplicateAction?: 'SKIP' | 'UPDATE' | 'OVERWRITE';
  actorUserId?: string | null;
}

export interface UpsertLeadResult {
  lead: any;
  isDuplicate: boolean;
  wasCreated: boolean;
  wasUpdated: boolean;
  actionTaken: 'CREATED' | 'ENRICHED' | 'SKIPPED_DUPLICATE';
}

/**
 * Normalize phone number to consistent E.164-compatible representation
 */
export function normalizePhoneNumber(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (String(raw).trim().startsWith('+')) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+91${digits}`;
  }
  return `+${digits}`;
}

/**
 * Universal Tenant-Isolated Lead Upsert & Ingestion Pipeline.
 * Guarantees zero unhandled duplicate key crashes and unifies deduplication across
 * CSV, Excel, Google Sheets, WhatsApp, email, partner webhooks, and manual entries.
 */
export async function upsertCompanyLead(params: UpsertLeadParams): Promise<UpsertLeadResult> {
  const {
    tenantId,
    customerName,
    customerPhone,
    customerEmail,
    source,
    serviceInterest,
    budgetAmount,
    notes,
    customFields,
    conversationId,
    createdById,
    duplicateAction = 'UPDATE',
    actorUserId,
  } = params;

  const normalizedPhone = normalizePhoneNumber(customerPhone);
  const normalizedEmail = customerEmail ? customerEmail.toLowerCase().trim() : null;
  const last10 = normalizedPhone ? normalizedPhone.replace(/\D/g, '').slice(-10) : null;
  const upperSource = (source || 'DIRECT').toUpperCase().trim();

  // 1. Strict Tenant-Scoped Duplicate Detection
  let existingLead = null;

  if (normalizedPhone) {
    existingLead = await prisma.salesLeadAssignment.findFirst({
      where: {
        tenantId,
        OR: [
          { customerPhone: normalizedPhone },
          ...(last10 ? [{ customerPhone: { contains: last10 } }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  if (!existingLead && normalizedEmail) {
    existingLead = await prisma.salesLeadAssignment.findFirst({
      where: {
        tenantId,
        customerEmail: { equals: normalizedEmail, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  // 2. Handle Duplicate Lead
  if (existingLead) {
    if (duplicateAction === 'SKIP') {
      return {
        lead: existingLead,
        isDuplicate: true,
        wasCreated: false,
        wasUpdated: false,
        actionTaken: 'SKIPPED_DUPLICATE',
      };
    }

    // Enrich existing lead with incoming information
    const existingCustomFields = (existingLead.customFields as Record<string, any>) || {};
    const mergedCustomFields = { ...existingCustomFields, ...(customFields || {}) };

    const updatedNotes = notes
      ? `${existingLead.notes || ''}\n[${new Date().toISOString().slice(0, 10)} from ${upperSource}]: ${notes}`.trim()
      : existingLead.notes;

    const updated = await prisma.salesLeadAssignment.update({
      where: { id: existingLead.id },
      data: {
        customerName: customerName || existingLead.customerName,
        customerEmail: normalizedEmail || existingLead.customerEmail,
        serviceInterest: serviceInterest || existingLead.serviceInterest,
        budgetAmount: budgetAmount !== undefined && budgetAmount !== null ? budgetAmount : existingLead.budgetAmount,
        notes: updatedNotes,
        customFields: mergedCustomFields,
        conversationId: conversationId || existingLead.conversationId,
        lastContactedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Timeline entry
    await prisma.salesLeadTimelineEntry.create({
      data: {
        tenantId,
        leadId: updated.id,
        type: 'LEAD_ENRICHED',
        body: notes || `Lead re-enquired via ${upperSource}`,
        metadata: { source: upperSource, duplicateAction },
      },
    }).catch(() => undefined);

    await prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: updated.id,
        actorUserId: actorUserId || null,
        action: 'LEAD_ENRICHED_FROM_IMPORT',
        note: `Existing lead enriched from ${upperSource}`,
        metadata: { source: upperSource },
      },
    }).catch(() => undefined);

    return {
      lead: updated,
      isDuplicate: true,
      wasCreated: false,
      wasUpdated: true,
      actionTaken: 'ENRICHED',
    };
  }

  // 3. Create Brand New Lead
  // Fetch non-admin fallback holder for required assignedAgentId foreign key
  let fallbackAgent = await prisma.salesAgentProfile.findFirst({
    where: {
      tenantId,
      status: 'ACTIVE',
      user: { role: 'SALES_AGENT', packageStatus: 'ACTIVE' },
    },
  });

  if (!fallbackAgent) {
    fallbackAgent = await prisma.salesAgentProfile.findFirst({
      where: { tenantId },
    });
  }

  if (!fallbackAgent) {
    throw new Error(`No agent profile found in workspace ${tenantId} to hold initial lead`);
  }

  const newLead = await prisma.salesLeadAssignment.create({
    data: {
      tenantId,
      assignedAgentId: params.assignedAgentId || fallbackAgent.id,
      createdById: createdById || actorUserId || null,
      customerName: customerName || 'Inbound Lead',
      customerPhone: normalizedPhone,
      customerEmail: normalizedEmail,
      source: upperSource,
      serviceInterest: serviceInterest || null,
      budgetAmount: budgetAmount !== undefined && budgetAmount !== null ? budgetAmount : null,
      notes: notes || `Lead created via ${upperSource}`,
      customFields: customFields || {},
      conversationId: conversationId || null,
      stage: 'NEW',
    },
  });

  // 4. Synchronize to Marketing Contacts
  if (normalizedPhone) {
    await prisma.marketingContact.upsert({
      where: {
        tenantId_e164Phone: {
          tenantId,
          e164Phone: normalizedPhone,
        },
      },
      create: {
        tenantId,
        fullName: customerName,
        e164Phone: normalizedPhone,
        email: normalizedEmail,
        source: upperSource,
      },
      update: {
        fullName: customerName,
        email: normalizedEmail || undefined,
      },
    }).catch(() => undefined);
  }

  // 5. Create Timeline Entry & Activity Log
  await prisma.salesLeadTimelineEntry.create({
    data: {
      tenantId,
      leadId: newLead.id,
      type: 'LEAD_CREATED',
      body: notes || `Lead created from ${upperSource}`,
      metadata: { source: upperSource },
    },
  }).catch(() => undefined);

  // 6. Execute Source Distribution Rules & Round-Robin
  let assignmentResult = null;
  try {
    assignmentResult = await assignLeadToNextCloser({
      tenantId,
      leadId: newLead.id,
      source: upperSource,
      preferredCloserId: params.assignedAgentId || undefined,
      actorUserId: actorUserId || undefined,
    });
  } catch (rrErr) {
    logger.warn('Failed to assign new lead via engine, fallback preserved', { error: String(rrErr), leadId: newLead.id });
  }

  // Return fresh state
  const finalizedLead = await prisma.salesLeadAssignment.findUnique({
    where: { id: newLead.id },
  });

  return {
    lead: finalizedLead || newLead,
    isDuplicate: false,
    wasCreated: true,
    wasUpdated: false,
    actionTaken: 'CREATED',
  };
}
