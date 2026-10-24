import { prisma } from './prisma.js';
import { SalesLeadStage } from '@prisma/client';
import { logger } from './logger.js';
import { assignLeadToNextCloser } from './lead-assignment-engine.js';
import { normalizeLeadPhone, syncMarketingContactForLead } from './lead-contact-sync.js';
import { persistApiRealtimeEvent } from './realtime.js';

export interface UpsertLeadParams {
  tenantId: string;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  source: string;
  serviceInterest?: string | null;
  budgetAmount?: number | null;
  notes?: string | null;
  stage?: SalesLeadStage;
  priority?: string | null;
  customFields?: Record<string, any>;
  conversationId?: string | null;
  assignedAgentId?: string | null;
  createdById?: string | null;
  duplicateAction?: 'SKIP' | 'UPDATE' | 'OVERWRITE';
  distributionMode?: 'AUTO' | 'ROUND_ROBIN' | 'POOL' | 'MANUAL';
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
export const normalizePhoneNumber = normalizeLeadPhone;

export function isPlaceholderEmail(email?: string | null): boolean {
  if (!email) return true;
  const clean = email.toLowerCase().trim();
  if (['a@gmail.com', 'b@gmail.com', 'c@gmail.com', 'test@gmail.com', 'test@test.com', 'admin@gmail.com', 'no@gmail.com', 'na@na.com', 'none@none.com', 'dummy@gmail.com', 'abc@gmail.com', 'xyz@gmail.com', 'sample@gmail.com'].includes(clean)) return true;
  if (/^(test|dummy|noemail|na|none|sample|placeholder|fake|null)@/i.test(clean)) return true;
  if (/^[a-z]@(gmail|yahoo|outlook|hotmail)\.com$/i.test(clean)) return true;
  return false;
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
    stage,
    priority,
    customFields,
    conversationId,
    createdById,
    duplicateAction = 'UPDATE',
    distributionMode,
    actorUserId,
  } = params;

  const normalizedPhone = normalizePhoneNumber(customerPhone);
  const normalizedEmail = customerEmail ? customerEmail.toLowerCase().trim() : null;
  const last10 = normalizedPhone ? normalizedPhone.replace(/\D/g, '').slice(-10) : null;
  const upperSource = (source || 'DIRECT').toUpperCase().trim();

  // 1. Strict Tenant-Scoped Duplicate Detection (Phone-First!)
  let existingLead = null;

  if (normalizedPhone && last10 && last10.length >= 7) {
    existingLead = await prisma.salesLeadAssignment.findFirst({
      where: {
        tenantId,
        OR: [
          { customerPhone: normalizedPhone },
          { customerPhone: { contains: last10 } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
  } else if (normalizedEmail && !isPlaceholderEmail(normalizedEmail)) {
    // Fall back to email matching ONLY when no valid phone number was supplied
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
      await syncMarketingContactForLead(existingLead).catch(() => undefined);
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
        ...(stage ? { stage, ...(stage !== existingLead.stage ? { stageChangedAt: new Date() } : {}) } : {}),
        ...(priority ? { priority } : {}),
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

    await syncMarketingContactForLead(updated).catch(() => undefined);

    await persistApiRealtimeEvent({
      tenantId,
      eventType: 'lead.updated',
      payload: {
        id: updated.id,
        leadId: updated.id,
        customerName: updated.customerName,
        customerPhone: updated.customerPhone,
        customerEmail: updated.customerEmail,
        stage: updated.stage,
        priority: updated.priority,
        tags: updated.tags,
        budgetAmount: updated.budgetAmount,
        notes: updated.notes,
        followUpAt: updated.followUpAt,
        updatedAt: updated.updatedAt,
      },
      actorUserId: actorUserId || null,
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
      where: {
        tenantId,
        user: { role: 'SALES_AGENT' },
      },
    });
  }

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
      stage: stage || 'NEW',
      priority: priority || 'normal',
    },
  });

  // 4. Synchronize to Marketing Contacts, including the canonical lead link
  // and owner so both screens use the same source of truth.
  await syncMarketingContactForLead(newLead).catch(() => undefined);

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
      distributionMode,
      actorUserId: actorUserId || undefined,
    });
  } catch (rrErr) {
    logger.warn('Failed to assign new lead via engine, fallback preserved', { error: String(rrErr), leadId: newLead.id });
  }

  // Return fresh state
  const finalizedLead = await prisma.salesLeadAssignment.findUnique({
    where: { id: newLead.id },
  });

  if (finalizedLead) {
    await syncMarketingContactForLead(finalizedLead).catch(() => undefined);
  }

  const leadToReturn = finalizedLead || newLead;
  await persistApiRealtimeEvent({
    tenantId,
    eventType: 'lead.created',
    payload: {
      id: leadToReturn.id,
      leadId: leadToReturn.id,
      customerName: leadToReturn.customerName,
      customerPhone: leadToReturn.customerPhone,
      customerEmail: leadToReturn.customerEmail,
      stage: leadToReturn.stage,
      source: leadToReturn.source,
      priority: leadToReturn.priority,
      tags: leadToReturn.tags,
      budgetAmount: leadToReturn.budgetAmount,
      assignedAgentId: leadToReturn.assignedAgentId,
      notes: leadToReturn.notes,
      createdAt: leadToReturn.createdAt,
    },
    actorUserId: actorUserId || null,
  }).catch(() => undefined);

  return {
    lead: finalizedLead || newLead,
    isDuplicate: false,
    wasCreated: true,
    wasUpdated: false,
    actionTaken: 'CREATED',
  };
}
