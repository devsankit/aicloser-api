import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middlewares/auth.js';
import { enforceTenantIsolation } from '../middlewares/tenant-isolation.js';

export const mobileCompatRouter = Router();

mobileCompatRouter.use(authenticate, enforceTenantIsolation);

// 1. GET /sales/mobile/bootstrap
mobileCompatRouter.get('/bootstrap', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const userId = req.user!.userId;

    const agent = await prisma.salesAgentProfile.findFirst({
      where: { userId, tenantId },
      include: { user: { select: { displayName: true, email: true, phone: true } } },
    });

    if (!agent) {
      res.status(404).json({ ok: false, error: 'Sales agent profile not found' });
      return;
    }

    const leads = await prisma.salesLeadAssignment.findMany({
      where: { tenantId, assignedAgentId: agent.id },
      orderBy: [{ stageChangedAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });

    res.json({
      ok: true,
      agent: {
        id: agent.id,
        agentCode: agent.agentCode,
        displayName: agent.user.displayName,
        email: agent.user.email,
        phone: agent.user.phone,
        status: agent.status,
      },
      leads: leads.map((l) => ({
        id: l.id,
        customerName: l.customerName,
        customerPhone: l.customerPhone ?? '',
        customerEmail: l.customerEmail ?? '',
        stage: l.stage,
        notes: l.notes ?? '',
        source: l.source ?? 'MANUAL',
        budgetAmount: l.budgetAmount ?? 0,
        tags: l.tags ?? [],
        followUpAt: l.followUpAt?.toISOString() ?? null,
      })),
      settings: {
        recordingUploadPolicy: 'WIFI_AND_CELLULAR',
        leadGrabbingEnabled: true,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Bootstrap failed' });
  }
});

// 2. POST /sales/mobile/call/start
mobileCompatRouter.post('/call/start', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const userId = req.user!.userId;
    const body = req.body || {};

    const agent = await prisma.salesAgentProfile.findFirst({
      where: { userId, tenantId },
    });

    if (!agent) {
      res.status(404).json({ ok: false, error: 'Sales agent profile not found' });
      return;
    }

    const clientCallId = (body.clientCallId || body.callSessionId || body.idempotencyKey || '').trim();

    if (clientCallId) {
      const existing = await prisma.salesMobileCall.findFirst({
        where: {
          tenantId,
          agentId: agent.id,
          OR: [{ clientCallId }, { id: clientCallId }],
        },
      });
      if (existing) {
        res.json({ ok: true, call: existing });
        return;
      }
    }

    const assignmentId = (body.leadId || body.assignmentId || '').trim();
    const phoneNumber = (body.phoneNumber || '').trim();

    const call = await prisma.salesMobileCall.create({
      data: {
        tenantId,
        agentId: agent.id,
        assignmentId: assignmentId || null,
        clientCallId: clientCallId || null,
        phoneNumber: phoneNumber || 'UNKNOWN',
        direction: (body.direction || 'OUTBOUND').toUpperCase() === 'INBOUND' ? 'INBOUND' : 'OUTBOUND',
        status: 'INITIATED',
        deviceId: body.deviceId ? String(body.deviceId) : null,
        startedAt: new Date(),
      },
    });

    res.json({ ok: true, call });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'Unable to start call' });
  }
});

// 3. POST /sales/mobile/call/disposition
mobileCompatRouter.post('/call/disposition', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const userId = req.user!.userId;
    const body = req.body || {};

    const agent = await prisma.salesAgentProfile.findFirst({
      where: { userId, tenantId },
    });

    if (!agent) {
      res.status(404).json({ ok: false, error: 'Sales agent profile not found' });
      return;
    }

    const callId = (body.clientCallId || body.callSessionId || body.idempotencyKey || body.callId || '').trim();
    const call = await prisma.salesMobileCall.findFirst({
      where: {
        tenantId,
        agentId: agent.id,
        OR: [{ id: callId }, { clientCallId: callId }],
      },
    });

    if (!call) {
      res.status(404).json({ ok: false, error: 'Call session not found' });
      return;
    }

    const outcome = (body.outcome || '').trim().toUpperCase();
    const note = (body.note || '').trim();
    const stageUpdate = (body.stageUpdate || '').trim().toUpperCase();

    const updated = await prisma.salesMobileCall.update({
      where: { id: call.id },
      data: {
        outcome: outcome || 'CONNECTED',
        note: note || undefined,
        status: 'COMPLETED',
        endedAt: new Date(),
      },
    });

    if (call.assignmentId && stageUpdate) {
      await prisma.salesLeadAssignment.updateMany({
        where: { id: call.assignmentId, tenantId },
        data: {
          stage: stageUpdate as any,
          stageChangedAt: new Date(),
          lastContactedAt: new Date(),
        },
      });
    }

    res.json({ ok: true, call: updated });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'Unable to save disposition' });
  }
});

// 4. POST /sales/mobile/call/discard
mobileCompatRouter.post('/call/discard', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const userId = req.user!.userId;
    const body = req.body || {};

    const agent = await prisma.salesAgentProfile.findFirst({
      where: { userId, tenantId },
    });

    if (!agent) {
      res.status(404).json({ ok: false, error: 'Sales agent profile not found' });
      return;
    }

    const callId = (body.clientCallId || body.callSessionId || body.callId || '').trim();
    if (callId) {
      await prisma.salesMobileCall.updateMany({
        where: {
          tenantId,
          agentId: agent.id,
          OR: [{ id: callId }, { clientCallId: callId }],
        },
        data: { status: 'MISSED' },
      });
    }

    res.json({ ok: true, discarded: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'Unable to discard call' });
  }
});

// 5. POST /sales/mobile/register-device
mobileCompatRouter.post('/register-device', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const userId = req.user!.userId;
    const body = req.body || {};

    const agent = await prisma.salesAgentProfile.findFirst({
      where: { userId, tenantId },
    });

    if (!agent) {
      res.status(404).json({ ok: false, error: 'Sales agent profile not found' });
      return;
    }

    const deviceId = (body.deviceId || '').trim();
    if (!deviceId) {
      res.status(400).json({ ok: false, error: 'deviceId is required' });
      return;
    }

    const device = await prisma.salesMobileDevice.upsert({
      where: { deviceId },
      create: {
        tenantId,
        agentId: agent.id,
        deviceId,
        deviceName: body.deviceName || 'Android Device',
        appVersion: body.appVersion || '1.0.0',
        manufacturer: body.manufacturer,
        model: body.model,
        androidVersion: body.androidVersion,
        simLabel: body.simLabel,
        officeSimNumber: body.officeSimNumber,
        lastSeenAt: new Date(),
      },
      update: {
        tenantId,
        agentId: agent.id,
        deviceName: body.deviceName || undefined,
        appVersion: body.appVersion || undefined,
        manufacturer: body.manufacturer || undefined,
        model: body.model || undefined,
        androidVersion: body.androidVersion || undefined,
        simLabel: body.simLabel || undefined,
        officeSimNumber: body.officeSimNumber || undefined,
        lastSeenAt: new Date(),
      },
    });

    res.json({ ok: true, device });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'Unable to register device' });
  }
});

// 6. POST /sales/mobile/heartbeat
mobileCompatRouter.post('/heartbeat', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const body = req.body || {};
    const deviceId = (body.deviceId || '').trim();

    if (deviceId) {
      await prisma.salesMobileDevice.updateMany({
        where: { deviceId, tenantId },
        data: {
          lastSeenAt: new Date(),
        },
      });
    }

    res.json({ ok: true, timestamp: Date.now() });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'Heartbeat failed' });
  }
});