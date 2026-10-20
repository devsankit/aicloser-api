import crypto from 'node:crypto';
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
          OR: [
            { customerPhone: e164Phone },
            ...(email ? [{ customerEmail: email }] : []),
          ],
        },
        orderBy: [{ stage: 'desc' }, { createdAt: 'asc' }],
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
        } else if (event.type === 'DISPOSITION_SUBMIT') {
          const callId = typeof event.payload.callId === 'string' ? event.payload.callId : '';
          const outcome = typeof event.payload.outcome === 'string' ? event.payload.outcome : 'COMPLETED';
          const note = typeof event.payload.note === 'string' ? event.payload.note : '';
          const leadId = typeof event.payload.leadId === 'string' ? event.payload.leadId : '';
          if (callId) {
            await tx.salesMobileCall.updateMany({ where: { id: callId, tenantId }, data: { outcome, note } });
          }
          if (leadId) {
            await tx.salesLeadAssignment.updateMany({ where: { id: leadId, tenantId }, data: { lastCallDisposition: outcome, lastContactedAt: new Date() } });
          }
        } else if (event.type === 'LEAD_UPDATE') {
          const leadId = typeof event.payload.leadId === 'string' ? event.payload.leadId : '';
          const stage = typeof event.payload.stage === 'string' ? event.payload.stage : undefined;
          const notes = typeof event.payload.notes === 'string' ? event.payload.notes : undefined;
          if (leadId) {
            await tx.salesLeadAssignment.updateMany({ where: { id: leadId, tenantId }, data: { ...(stage ? { stage: stage as any, stageChangedAt: new Date() } : {}), ...(notes ? { notes } : {}), lastContactedAt: new Date() } });
          }
        } else if (event.type === 'CALL_DISCARD') {
          const callId = typeof event.payload.callId === 'string' ? event.payload.callId : '';
          if (callId) {
            await tx.salesMobileCall.updateMany({ where: { id: callId, tenantId }, data: { outcome: 'DISCARDED_PERSONAL' } });
          }
        } else if (event.type === 'RECORDING_RETRY') {
          const uploadId = typeof event.payload.uploadId === 'string' ? event.payload.uploadId : '';
          if (uploadId) {
            await tx.callRecordingUpload.updateMany({ where: { id: uploadId, tenantId }, data: { status: 'LOCAL_PENDING' } });
          }
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

const bootstrapSchema = z.object({
  appVersion: z.string().optional(),
  deviceId: z.string().optional(),
});

mobileRouter.post('/bootstrap', validateBody(bootstrapSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const userId = req.user!.userId;
  const input = req.body as z.infer<typeof bootstrapSchema>;

  const [workspace, agent, user] = await Promise.all([
    prisma.aicloserWorkspace.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, status: true, planTier: true, maxSeats: true },
    }),
    prisma.salesAgentProfile.findFirst({
      where: { userId, tenantId },
      include: {
        mobileDevices: {
          where: { isActive: true },
          take: 5,
        },
      },
    }),
    prisma.appAuthUser.findUnique({
      where: { id: userId },
      select: { id: true, email: true, displayName: true, role: true },
    }),
  ]);

  if (!workspace) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Workspace not found' });
    return;
  }

  const minAppVersion = '1.0.26';
  const forceUpdate = false;

  res.json({
    success: true,
    data: {
      user,
      agent,
      workspace,
      policy: {
        minAppVersion,
        forceUpdate,
        recordingRequired: true,
        heartbeatIntervalSeconds: 60,
        deltaSyncIntervalSeconds: 30,
        allowedCallDirections: ['INCOMING', 'OUTGOING'],
      },
      serverTime: new Date().toISOString(),
    },
    error: null,
  });
});

// GET /mobile/callbacks - Agent-scoped callback schedule for mobile reminders
mobileRouter.get('/callbacks', async (req: Request, res: Response) => {
  const agent = await agentForRequest(req).catch(() => null);
  if (!agent) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Active sales agent profile required' });
    return;
  }

  const requestedLimit = Number(req.query.limit ?? 100);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200) : 100;
  const from = typeof req.query.from === 'string' && req.query.from ? new Date(req.query.from) : new Date(0);
  const to = typeof req.query.to === 'string' && req.query.to ? new Date(req.query.to) : new Date('2999-12-31T23:59:59.999Z');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    res.status(400).json({ success: false, error: 'InvalidRequest', message: 'from and to must be valid ISO date strings' });
    return;
  }

  const assignments = await prisma.salesLeadAssignment.findMany({
    where: {
      tenantId: req.tenantId!,
      assignedAgentId: agent.id,
      followUpAt: { gte: from, lte: to },
    },
    orderBy: { followUpAt: 'asc' },
    take: limit,
    select: {
      id: true,
      conversationId: true,
      customerName: true,
      customerPhone: true,
      stage: true,
      notes: true,
      followUpAt: true,
      updatedAt: true,
    },
  });

  res.json({
    success: true,
    data: {
      callbacks: assignments.map((assignment) => ({
        id: assignment.id,
        conversationId: assignment.conversationId,
        customerName: assignment.customerName,
        customerPhone: assignment.customerPhone,
        stage: assignment.stage,
        note: assignment.notes ?? '',
        scheduledAt: assignment.followUpAt?.toISOString() ?? null,
        reminderAt: assignment.followUpAt
          ? new Date(assignment.followUpAt.getTime() - 5 * 60_000).toISOString()
          : null,
        state: assignment.followUpAt && assignment.followUpAt.getTime() <= Date.now() ? 'due' : 'scheduled',
        deepLinkUrl: assignment.conversationId
          ? `aicloser://conversations/${encodeURIComponent(assignment.conversationId)}`
          : 'aicloser://dashboard',
        updatedAt: assignment.updatedAt.toISOString(),
      })),
    },
    error: null,
  });
});


// GET /mobile/push-config - Firebase WebPush/VAPID public configuration
mobileRouter.get('/push-config', async (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      vapidKey: process.env.FIREBASE_VAPID_KEY || process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || '',
      config: {
        apiKey: process.env.FIREBASE_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '',
        authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
        projectId: process.env.FIREBASE_PROJECT_ID || '',
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
        appId: process.env.FIREBASE_APP_ID || process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '',
      },
    },
    error: null,
  });
});

// GET /mobile/notifications - Unread/inbox notifications for the mobile app
mobileRouter.get('/notifications', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const unreadOnly = String(req.query.unreadOnly ?? '').toLowerCase() === 'true';
  const requestedLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 50;
  const where = {
    userId,
    ...(req.tenantId ? { tenantId: req.tenantId } : {}),
    ...(unreadOnly ? { status: 'UNREAD' } : {}),
  };
  const [notifications, unread] = await Promise.all([
    prisma.appNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.appNotification.count({ where: { userId, ...(req.tenantId ? { tenantId: req.tenantId } : {}), status: 'UNREAD' } }),
  ]);

  res.json({
    success: true,
    data: {
      unread,
      notifications: notifications.map((notification) => ({
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        status: notification.status,
        entityType: notification.entityType,
        entityId: notification.entityId,
        metadata: notification.metadata,
        createdAt: notification.createdAt.toISOString(),
        readAt: notification.readAt?.toISOString() ?? null,
      })),
    },
    error: null,
  });
});

// POST /mobile/notifications/:id/read - Mark one mobile notification read
mobileRouter.post('/notifications/:id/read', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const notification = await prisma.appNotification.findFirst({
    where: { id, userId: req.user!.userId, ...(req.tenantId ? { tenantId: req.tenantId } : {}) },
  });
  if (!notification) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Notification not found' });
    return;
  }

  const updated = await prisma.appNotification.update({
    where: { id: notification.id },
    data: { status: 'READ', readAt: new Date() },
  });
  res.json({
    success: true,
    data: { id: updated.id, status: updated.status, readAt: updated.readAt?.toISOString() ?? null },
    error: null,
  });
});

const pushTokenSchema = z.object({
  token: z.string().min(10).max(500),
  platform: z.enum(['android', 'ios']).default('android'),
  deviceId: z.string().optional(),
});

mobileRouter.post('/push-token', validateBody(pushTokenSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const userId = req.user!.userId;
  const input = req.body as z.infer<typeof pushTokenSchema>;

  const tokenHash = crypto.createHash('sha256').update(input.token).digest('hex');

  const pushToken = await prisma.mobilePushToken.upsert({
    where: { tokenHash },
    create: {
      id: crypto.randomUUID(),
      userId,
      tenantId,
      token: input.token,
      tokenHash,
      platform: input.platform,
      provider: 'fcm',
      role: req.user?.role,
    },
    update: {
      userId,
      tenantId,
      updatedAt: new Date(),
      disabledAt: null,
    },
  });

  res.json({ success: true, data: { id: pushToken.id, registeredAt: pushToken.updatedAt }, error: null });
});

const diagnosticsSchema = z.object({
  deviceId: z.string().min(1),
  appVersion: z.string().optional(),
  logType: z.string().min(1).max(80),
  message: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

mobileRouter.post('/diagnostics', validateBody(diagnosticsSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const input = req.body as z.infer<typeof diagnosticsSchema>;

  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      actorUserId: req.user?.userId,
      action: 'MOBILE_DIAGNOSTICS_REPORT',
      note: 'Device ' + input.deviceId + ' reported [' + input.logType + ']: ' + (input.message || 'No description'),
      metadata: {
        deviceId: input.deviceId,
        appVersion: input.appVersion,
        logType: input.logType,
        ...(input.metadata || {}),
      },
    },
  }).catch(() => undefined);

  res.json({ success: true, message: 'Diagnostic event recorded', loggedAt: new Date().toISOString() });
});
