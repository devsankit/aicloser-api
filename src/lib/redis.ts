import Redis from 'ioredis';
import { env } from '../config/env.js';

export type RealtimeBusEvent = { id: string; eventType: string; tenantId: string; createdAt: string; payload: unknown };

let publisher: Redis | null = null;

function channel(tenantId: string) {
  return `aicloser:realtime:${tenantId}`;
}

function getPublisher() {
  if (!env.REDIS_URL) return null;
  if (!publisher) publisher = new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 });
  return publisher;
}

export async function publishRealtimeEvent(event: RealtimeBusEvent) {
  const client = getPublisher();
  if (!client) return;
  await client.publish(channel(event.tenantId), JSON.stringify(event));
}

export async function subscribeRealtimeEvents(tenantId: string, onEvent: (event: RealtimeBusEvent) => void) {
  if (!env.REDIS_URL) return () => undefined;
  const subscriber = new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 });
  await subscriber.subscribe(channel(tenantId));
  const listener = (_name: string, message: string) => {
    try {
      const event = JSON.parse(message) as RealtimeBusEvent;
      if (event.tenantId === tenantId) onEvent(event);
    } catch {
      // Ignore malformed bus messages; the database outbox remains authoritative.
    }
  };
  subscriber.on('message', listener);
  return () => { subscriber.removeListener('message', listener); subscriber.disconnect(); };
}
