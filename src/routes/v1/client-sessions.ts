import { Router, Request, Response } from 'express';
import { AppClientChannel } from '@prisma/client';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { prisma } from '../../lib/prisma.js';
import { closeClientSession, listCloserActivity, listUserSessions } from '../../lib/client-sessions.js';
import { logger } from '../../lib/logger.js';

export const meSessionsRouter = Router();
meSessionsRouter.use(authenticate);

meSessionsRouter.get('/sessions', async (req: Request, res: Response) => {
  const sessions = await listUserSessions(req.user!.userId, req.user!.tenantId);
  res.json({
    success: true,
    data: sessions.map((slot) => ({
      channel: slot.channel,
      status: slot.status,
      installationId: slot.installationId,
      deviceId: slot.deviceId,
      deviceName: slot.deviceName,
      platform: slot.platform,
      appVersion: slot.appVersion,
      lastLoginAt: slot.lastLoginAt,
      lastActiveAt: slot.lastActiveAt,
      active: Boolean(slot.activeSessionId),
    })),
  });
});

export const adminUsersRouter = Router();
adminUsersRouter.use(authenticate, requireRoles('ADMIN', 'MANAGER', 'SUPER_ADMIN'), enforceTenantIsolation);

adminUsersRouter.get('/activity', async (req: Request, res: Response) => {
  const tenantId = req.tenantId;
  if (!tenantId) {
    res.status(400).json({ success: false, error: 'MissingTenantContext', message: 'A workspace context is required' });
    return;
  }

  const activity = await listCloserActivity(tenantId);
  res.json({
    success: true,
    data: {
      generatedAt: new Date().toISOString(),
      onlineWindowSeconds: 300,
      users: activity,
    },
  });
});

adminUsersRouter.post('/:userId/sessions/:channel/revoke', async (req: Request, res: Response) => {
  const tenantId = req.tenantId;
  const channel = String(req.params.channel).toUpperCase() as AppClientChannel;
  if (!tenantId) {
    res.status(400).json({ success: false, error: 'MissingTenantContext', message: 'A workspace context is required' });
    return;
  }
  if (!Object.values(AppClientChannel).includes(channel)) {
    res.status(400).json({ success: false, error: 'ValidationError', message: 'Channel must be MOBILE or DESKTOP' });
    return;
  }

  const slot = await prisma.appClientSlot.findFirst({
    where: {
      userId: String(req.params.userId),
      tenantId,
      channel,
      activeSessionId: { not: null },
    },
    include: { activeSession: true },
  });
  if (!slot?.activeSession) {
    res.status(404).json({ success: false, error: 'SessionNotFound', message: 'No active session found for this user and channel' });
    return;
  }

  await closeClientSession(slot.activeSession.sessionId, 'REVOKED', `Revoked by ${req.user!.displayName}`);
  logger.warn('Client session revoked by workspace administrator', {
    actorId: req.user!.userId,
    userId: String(req.params.userId),
    tenantId,
    channel,
  });
  res.json({ success: true, data: { channel, revoked: true } });
});
