import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { subscribeRealtimeEvents, type RealtimeBusEvent } from '../../lib/redis.js';

export const realtimeRouter = Router();
realtimeRouter.use(authenticate, enforceTenantIsolation);

function eventLine(eventName: string, event: { id: string; eventType: string; createdAt: Date; payload: Prisma.JsonValue }) {
  return `id: ${event.id}\nevent: ${eventName}\ndata: ${JSON.stringify({ id: event.id, type: event.eventType, createdAt: event.createdAt.toISOString(), payload: event.payload })}\n\n`;
}

realtimeRouter.get('/events', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const sinceText = typeof req.query.since === 'string' ? req.query.since : undefined;
  const parsedSince = sinceText ? new Date(sinceText) : new Date(Date.now() - 5 * 60 * 1000);
  let since = Number.isNaN(parsedSince.getTime()) ? new Date(Date.now() - 5 * 60 * 1000) : parsedSince;
  let afterId = typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : '';

  res.status(200);
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`event: connected\ndata: ${JSON.stringify({ createdAt: new Date().toISOString() })}\n\n`);

  let closed = false;
  const poll = async () => {
    if (closed) return;
    const rows = await prisma.$queryRaw<Array<{ id: string; eventType: string; payload: Prisma.JsonValue; createdAt: Date }>>`
      SELECT "id", "eventType", "payload", "createdAt"
      FROM "AppRealtimeEvent"
      WHERE "tenantId" = ${tenantId}
        AND ("createdAt" > ${since} OR ("createdAt" = ${since} AND "id" > ${afterId}))
        AND (
          cardinality("audienceUserIds") = 0
          OR ${req.user!.userId} = ANY("audienceUserIds")
          OR ${req.user!.role} = ANY("audienceRoles")
        )
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 100
    `;
    for (const row of rows) {
      if (closed) return;
      res.write(eventLine('crm', row));
      since = row.createdAt;
      afterId = row.id;
    }
  };

  const interval = setInterval(() => { void poll().catch(() => undefined); }, 1000);
  const heartbeat = setInterval(() => { if (!closed) res.write(`event: ping\ndata: ${JSON.stringify({ createdAt: new Date().toISOString() })}\n\n`); }, 25_000);
  const unsubscribe = await subscribeRealtimeEvents(tenantId, (event: RealtimeBusEvent) => {
    if (closed) return;
    const createdAt = new Date(event.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt < since || (createdAt.getTime() === since.getTime() && event.id <= afterId)) return;
    res.write(eventLine('crm', { id: event.id, eventType: event.eventType, createdAt, payload: event.payload as Prisma.JsonValue }));
    since = createdAt;
    afterId = event.id;
  }).catch(() => () => undefined);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };
  req.on('close', cleanup);
  await poll().catch(cleanup);
});
