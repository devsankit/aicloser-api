import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { publishRealtimeEvent } from './redis.js';

export async function persistApiRealtimeEvent(input: {
  tenantId: string;
  eventType: string;
  payload: unknown;
  actorUserId?: string | null;
  audienceRoles?: string[];
  audienceUserIds?: string[];
}) {
  const id = `evt-${randomUUID()}`;
  const createdAt = new Date();
  await prisma.$executeRaw`
    INSERT INTO "AppRealtimeEvent"
      ("id", "topic", "eventType", "tenantId", "actorUserId", "audienceUserIds", "audienceRoles", "payload")
    VALUES
      (${id}, ${`tenant:${input.tenantId}`}, ${input.eventType}, ${input.tenantId}, ${input.actorUserId ?? null}, ${input.audienceUserIds ?? []}, ${input.audienceRoles ?? []}, CAST(${JSON.stringify(input.payload ?? {})} AS JSONB))
  `;
  await publishRealtimeEvent({ id, eventType: input.eventType, tenantId: input.tenantId, createdAt: createdAt.toISOString(), payload: input.payload ?? {} }).catch(() => undefined);
}
