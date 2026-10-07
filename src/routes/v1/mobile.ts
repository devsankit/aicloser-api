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
