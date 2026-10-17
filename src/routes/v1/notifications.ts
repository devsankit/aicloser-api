import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate, enforceTenantIsolation);

// GET /api/v1/notifications
notificationsRouter.get('/', async (req: Request, res: Response) => {
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
    prisma.appNotification.count({
      where: { userId, ...(req.tenantId ? { tenantId: req.tenantId } : {}), status: 'UNREAD' },
    }),
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

// POST /api/v1/notifications/:id/read
notificationsRouter.post('/:id/read', async (req: Request, res: Response) => {
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

// POST /api/v1/notifications/read-all
notificationsRouter.post('/read-all', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  await prisma.appNotification.updateMany({
    where: { userId, ...(req.tenantId ? { tenantId: req.tenantId } : {}), status: 'UNREAD' },
    data: { status: 'READ', readAt: new Date() },
  });
  res.json({
    success: true,
    data: { success: true },
    error: null,
  });
});
