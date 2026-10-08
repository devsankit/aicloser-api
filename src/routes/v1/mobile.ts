import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody } from '../../middlewares/validate.js';
import { persistApiRealtimeEvent } from '../../lib/realtime.js';
import { touchClientSession } from '../../lib/client-sessions.js';

export const mobileRouter = Router();
mobileRouter.use(authenticate, enforceTenantIsolation);

const deviceSchema = z.object({
  deviceId: z.string().min(1).max(200),
  deviceName: z.string().min(1).max(200),
  appVersion: z.string().max(60).optional(),
  manufacturer: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  androidVersion: z.string().max(60).optional(),
  simLabel: z.string().max(120).optional(),
  officeSimNumber: z.string().max(40).optional(),
  recordingCapability: z.string().max(80).optional(),
  recordingEnabled: z.boolean().optional(),
});

async function agentForRequest(req: Request) {
  const agent = await prisma.salesAgentProfile.findFirst({ where: { userId: req.user!.userId, tenantId: req.tenantId! } });
  if (!agent) throw new Error('Active sales agent profile not found in this workspace');
  return agent;
}

const mobileContactSchema = z.object({
  name: z.string().trim().min(1, 'Contact name is required').max(160),
  phone: z.string().trim().min(5, 'Contact phone is required').max(40),
  email: z.string().trim().email('A valid email is required').max(320).optional().or(z.literal('')),
  source: z.string().trim().min(1).max(80).default('MOBILE_MANUAL'),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  notes: z.string().trim().max(5000).optional(),
});

const mobileContactsRequestSchema = z.union([
  z.object({ contacts: z.array(mobileContactSchema).min(1).max(100) }),
  z.object({ contact: mobileContactSchema }),
  mobileContactSchema,
]);

function normalizeMobilePhone(rawPhone: string) {
  const trimmed = rawPhone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) throw new Error('Phone must contain 7 to 15 digits.');
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (trimmed.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith('91') || digits.startsWith('1')) return `+${digits}`;
  return `+91${digits}`;
}

function contactResult(lead: {
  id: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  stage: string;
  tags: string[];
  notes: string | null;
}, marketingContact: { id: string }) {
  return {
    id: lead.id,
    leadId: lead.id,
    marketingContactId: marketingContact.id,
    name: lead.customerName,
    phone: lead.customerPhone ?? '',
    email: lead.customerEmail ?? '',
    stage: lead.stage,
    tags: lead.tags,
    notes: lead.notes ?? '',
  };
}

mobileRouter.post('/contacts', validateBody(mobileContactsRequestSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const agent = await agentForRequest(req).catch(() => null);
  if (!agent) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Active sales agent profile required' });
    return;
  }

  const parsed = req.body as z.infer<typeof mobileContactsRequestSchema>;
  const contacts = 'contacts' in parsed ? parsed.contacts : 'contact' in parsed ? [parsed.contact] : [parsed];
  const results: Array<Record<string, unknown>> = [];

  for (const input of contacts) {
    try {
      const e164Phone = normalizeMobilePhone(input.phone);
      const email = input.email?.trim().toLowerCase() || null;
      const tags = Array.from(new Set(['Mobile Contact', ...input.tags]));

      const marketingContact = await prisma.marketingContact.upsert({
        where: { tenantId_e164Phone: { tenantId, e164Phone } },
        update: {
          fullName: input.name,
          email,
          source: input.source,
          assignedAgentId: agent.id,
          tags: { push: tags },
          updatedAt: new Date(),
        },
        create: {
          tenantId,
          fullName: input.name,
          e164Phone,
          email,
          source: input.source,
          assignedAgentId: agent.id,
          tags,
        },
      });

      const existing = await prisma.salesLeadAssignment.findFirst({
        where: {
          tenantId,
          assignedAgentId: agent.id,
          OR: [
            { customerPhone: e164Phone },
            ...(email ? [{ customerEmail: email }] : []),
          ],
        },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, customerName: true, customerPhone: true, customerEmail: true, stage: true, tags: true, notes: true },
      });

      if (existing) {
        const lead = await prisma.salesLeadAssignment.update({
          where: { id: existing.id },
          data: {
            customerName: input.name,
            customerPhone: e164Phone,
            customerEmail: email ?? existing.customerEmail,
            source: input.source,
            tags: Array.from(new Set([...(existing.tags ?? []), ...tags])),
            notes: input.notes ?? existing.notes,
          },
          select: { id: true, customerName: true, customerPhone: true, customerEmail: true, stage: true, tags: true, notes: true },
        });
        results.push({ ok: true, created: false, updated: true, contact: contactResult(lead, marketingContact) });
        continue;
      }

      const lead = await prisma.salesLeadAssignment.create({
        data: {
          tenantId,
          assignedAgentId: agent.id,
          createdById: req.user?.userId,
          customerName: input.name,
          customerPhone: e164Phone,
          customerEmail: email,
          source: input.source,
          serviceInterest: 'Mobile Contact',
          segment: 'CRM Contact',
          priority: 'normal',
          tags,
          notes: input.notes,
          stage: 'NEW',
        },
        select: { id: true, customerName: true, customerPhone: true, customerEmail: true, stage: true, tags: true, notes: true },
      });

      await prisma.salesActivityLog.create({
        data: {
          tenantId,
          assignmentId: lead.id,
          actorUserId: req.user?.userId,
          action: 'LEAD_CREATED',
          note: 'Contact synced from mobile CRM.',
        },
      });
      results.push({ ok: true, created: true, updated: false, contact: contactResult(lead, marketingContact) });
    } catch (error) {
      results.push({ ok: false, error: error instanceof Error ? error.message : 'Contact sync failed.' });
    }
  }

  const failed = results.filter((result) => !result.ok);
  res.status(failed.length === results.length ? 422 : 200).json({
    success: failed.length === 0,
    data: {
      created: results.filter((result) => result.created === true).length,
      updated: results.filter((result) => result.updated === true).length,
      skipped: failed.length,
      contacts: results,
    },
  });
});

mobileRouter.post('/devices', validateBody(deviceSchema), async (req: Request, res: Response) => {
  try {
    const agent = await agentForRequest(req);
    const body = req.body as z.infer<typeof deviceSchema>;
    const existing = await prisma.salesMobileDevice.findUnique({ where: { deviceId: body.deviceId } });
    if (existing && existing.agentId !== agent.id) {
      res.status(409).json({ success: false, error: 'DeviceAssigned', message: 'This device is registered to another agent' });
      return;
    }
    const device = await prisma.salesMobileDevice.upsert({
      where: { deviceId: body.deviceId },
      create: { tenantId: req.tenantId!, agentId: agent.id, deviceId: body.deviceId, deviceName: body.deviceName, appVersion: body.appVersion, manufacturer: body.manufacturer, model: body.model, androidVersion: body.androidVersion, simLabel: body.simLabel, officeSimNumber: body.officeSimNumber, recordingCapability: body.recordingCapability ?? 'UNKNOWN', recordingEnabled: body.recordingEnabled ?? false },
      update: { tenantId: req.tenantId!, agentId: agent.id, deviceName: body.deviceName, appVersion: body.appVersion, manufacturer: body.manufacturer, model: body.model, androidVersion: body.androidVersion, simLabel: body.simLabel, officeSimNumber: body.officeSimNumber, recordingCapability: body.recordingCapability ?? 'UNKNOWN', recordingEnabled: body.recordingEnabled ?? false, isActive: true, lastSeenAt: new Date() },
    });
    res.status(201).json({ success: true, data: device });
  } catch (error) {
    res.status(400).json({ success: false, error: 'DeviceRegistrationFailed', message: error instanceof Error ? error.message : 'Device registration failed' });
  }
});

mobileRouter.post('/devices/:deviceId/heartbeat', async (req: Request, res: Response) => {
  const deviceId = String(req.params.deviceId);
  const device = await prisma.salesMobileDevice.findFirst({ where: { deviceId, tenantId: req.tenantId!, agent: { userId: req.user!.userId } } });
  if (!device || !device.isActive) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Active device not found in this workspace' });
    return;
  }
  const deviceUpdated = await prisma.salesMobileDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), appVersion: typeof req.body?.appVersion === 'string' ? req.body.appVersion : device.appVersion } });
  if (req.user?.sessionId) await touchClientSession(req.user.sessionId);
  res.json({ success: true, data: deviceUpdated });
});

const syncSchema = z.object({ events: z.array(z.object({ localEventId: z.string().min(1).max(200), type: z.string().min(1).max(80), payload: z.record(z.unknown()).default({}) })).max(100) });

mobileRouter.post('/offline-events/sync', validateBody(syncSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const agent = await agentForRequest(req).catch(() => null);
  if (!agent) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Active sales agent profile required' });
    return;
  }
  const results: Array<Record<string, unknown>> = [];
  for (const event of req.body.events as z.infer<typeof syncSchema>['events']) {
    const existing = await prisma.salesMobileOfflineEvent.findUnique({ where: { idempotencyKey: event.localEventId } });
    if (existing && (existing.tenantId !== tenantId || existing.agentId !== agent.id)) {
      results.push({ ok: false, idempotencyKey: event.localEventId, error: 'TenantIsolationViolation' });
      continue;
    }
    if (existing?.status === 'SYNCED') {
      results.push({ ok: true, idempotencyKey: event.localEventId, result: existing.result, duplicate: true });
      continue;
    }
    try {
      const saved = await prisma.$transaction(async (tx) => {
        const row = existing ?? await tx.salesMobileOfflineEvent.create({ data: { tenantId, idempotencyKey: event.localEventId, agentId: agent.id, type: event.type, payload: event.payload as Prisma.InputJsonValue } });
        if (event.type === 'CALL_END') {
          const callId = typeof event.payload.callSessionId === 'string' ? event.payload.callSessionId : '';
          const call = await tx.salesMobileCall.findFirst({ where: { id: callId, tenantId, agentId: agent.id } });
          if (!call) throw new Error('Call not found in this workspace');
          const allowed = ['NONE', 'RECORDING_UNAVAILABLE', 'LOCAL_PENDING', 'UPLOADING', 'UPLOADED', 'FAILED'] as const;
          const rawRecordingStatus = typeof event.payload.recordingStatus === 'string' ? event.payload.recordingStatus : call.recordingStatus;
          const recordingStatus = allowed.includes(rawRecordingStatus as (typeof allowed)[number]) ? rawRecordingStatus as (typeof allowed)[number] : call.recordingStatus;
          await tx.salesMobileCall.update({ where: { id: call.id }, data: { status: 'COMPLETED', endedAt: typeof event.payload.endedAt === 'string' ? new Date(event.payload.endedAt) : new Date(), durationSeconds: typeof event.payload.durationSeconds === 'number' ? Math.max(0, Math.trunc(event.payload.durationSeconds)) : call.durationSeconds, recordingStatus } });
        }
        const result = { accepted: true, appliedType: event.type };
        return tx.salesMobileOfflineEvent.update({ where: { id: row.id }, data: { status: 'SYNCED', result, processedAt: new Date(), error: null } });
      });
      results.push({ ok: true, idempotencyKey: event.localEventId, result: saved.result });
      if (event.type === 'CALL_END') await persistApiRealtimeEvent({ tenantId, actorUserId: req.user?.userId, audienceRoles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SALES_AGENT'], eventType: 'call.ended', payload: event.payload }).catch(() => undefined);
    } catch (error) {
      await prisma.salesMobileOfflineEvent.upsert({ where: { idempotencyKey: event.localEventId }, create: { tenantId, idempotencyKey: event.localEventId, agentId: agent.id, type: event.type, payload: event.payload as Prisma.InputJsonValue, status: 'FAILED', error: error instanceof Error ? error.message : 'Offline event failed', retryCount: 1 }, update: { status: 'FAILED', error: error instanceof Error ? error.message : 'Offline event failed', retryCount: { increment: 1 } } }).catch(() => undefined);
      results.push({ ok: false, idempotencyKey: event.localEventId, error: error instanceof Error ? error.message : 'Offline event failed' });
    }
  }
  res.json({ success: results.every((item) => item.ok), data: { results } });
});
