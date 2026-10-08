import { randomUUID } from 'node:crypto';
import { AppClientChannel, AppClientSessionStatus, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

export const CLIENT_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;
export const CLIENT_HEARTBEAT_WRITE_INTERVAL_MS = 30 * 1000;

export class ClientSlotOccupiedError extends Error {
  readonly code = 'ClientSlotOccupied';
  readonly channel: AppClientChannel;
  readonly lastActiveAt: Date | null;
  readonly deviceName: string | null;

  constructor(channel: AppClientChannel, lastActiveAt: Date | null, deviceName: string | null) {
    super(`An active ${channel.toLowerCase()} session already exists for this user`);
    this.name = 'ClientSlotOccupiedError';
    this.channel = channel;
    this.lastActiveAt = lastActiveAt;
    this.deviceName = deviceName;
  }
}

type ClientSessionInput = {
  userId: string;
  tenantId: string | null;
  channel: AppClientChannel;
  installationId: string;
  deviceId?: string | null;
  deviceName?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  replaceExisting?: boolean;
};

function slotLockKey(input: Pick<ClientSessionInput, 'userId' | 'channel'>) {
  return `aicloser:client-slot:${input.userId}:${input.channel}`;
}

export async function acquireClientSession(input: ClientSessionInput) {
  return prisma.$transaction(async (tx) => {
    // Serialize competing logins for the same user/channel. This protects the
    // one-mobile + one-desktop seat rule even when two requests arrive together.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${slotLockKey(input)}))`;

    let slot = await tx.appClientSlot.findUnique({
      where: { userId_channel: { userId: input.userId, channel: input.channel } },
      include: { activeSession: true },
    });

    if (slot?.activeSession?.status === AppClientSessionStatus.ACTIVE) {
      if (slot.activeSession.installationId !== input.installationId) {
        if (!input.replaceExisting) {
          throw new ClientSlotOccupiedError(
            input.channel,
            slot.activeSession.lastActiveAt,
            slot.activeSession.deviceName,
          );
        }
        const now = new Date();
        await tx.appClientSession.update({
          where: { id: slot.activeSession.id },
          data: {
            status: AppClientSessionStatus.REVOKED,
            revokedAt: now,
            revokeReason: 'Replaced by explicit login from another installation',
          },
        });
      } else {
        const now = new Date();
        const session = await tx.appClientSession.update({
          where: { id: slot.activeSession.id },
          data: {
            lastActiveAt: now,
            deviceId: input.deviceId ?? slot.activeSession.deviceId,
            deviceName: input.deviceName ?? slot.activeSession.deviceName,
            platform: input.platform ?? slot.activeSession.platform,
            appVersion: input.appVersion ?? slot.activeSession.appVersion,
          },
        });
        await tx.appClientSlot.update({
          where: { id: slot.id },
          data: {
            status: 'ACTIVE',
            lastActiveAt: now,
            deviceId: input.deviceId ?? slot.deviceId,
            deviceName: input.deviceName ?? slot.deviceName,
            platform: input.platform ?? slot.platform,
            appVersion: input.appVersion ?? slot.appVersion,
          },
        });
        return { session, resumed: true };
      }
    }

    if (!slot) {
      slot = await tx.appClientSlot.create({
        data: {
          userId: input.userId,
          tenantId: input.tenantId,
          channel: input.channel,
          status: 'AVAILABLE',
        },
        include: { activeSession: true },
      });
    }

    const now = new Date();
    const session = await tx.appClientSession.create({
      data: {
        sessionId: randomUUID(),
        userId: input.userId,
        tenantId: input.tenantId,
        slotId: slot.id,
        channel: input.channel,
        installationId: input.installationId,
        deviceId: input.deviceId ?? null,
        deviceName: input.deviceName ?? null,
        platform: input.platform ?? null,
        appVersion: input.appVersion ?? null,
        status: 'ACTIVE',
        loginAt: now,
        lastActiveAt: now,
      },
    });

    await tx.appClientSlot.update({
      where: { id: slot.id },
      data: {
        status: 'ACTIVE',
        activeSessionId: session.id,
        installationId: input.installationId,
        deviceId: input.deviceId ?? null,
        deviceName: input.deviceName ?? null,
        platform: input.platform ?? null,
        appVersion: input.appVersion ?? null,
        lastLoginAt: now,
        lastActiveAt: now,
      },
    });

    return { session, resumed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function touchClientSession(sessionId: string) {
  const current = await prisma.appClientSession.findUnique({ where: { sessionId }, select: { id: true, status: true, lastActiveAt: true, slotId: true } });
  if (!current || current.status !== AppClientSessionStatus.ACTIVE) return null;

  const now = new Date();
  if (now.getTime() - current.lastActiveAt.getTime() < CLIENT_HEARTBEAT_WRITE_INTERVAL_MS) return current;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.appClientSession.updateMany({
      where: {
        id: current.id,
        status: AppClientSessionStatus.ACTIVE,
        lastActiveAt: { lt: new Date(now.getTime() - CLIENT_HEARTBEAT_WRITE_INTERVAL_MS) },
      },
      data: { lastActiveAt: now },
    });
    if (updated.count > 0) {
      await tx.appClientSlot.updateMany({ where: { id: current.slotId, status: 'ACTIVE' }, data: { lastActiveAt: now } });
    }
    return { ...current, lastActiveAt: updated.count > 0 ? now : current.lastActiveAt };
  });
}

export async function getActiveClientSession(sessionId: string) {
  return prisma.appClientSession.findUnique({ where: { sessionId } });
}

export async function closeClientSession(sessionId: string, status: 'LOGGED_OUT' | 'REVOKED', reason?: string) {
  return prisma.$transaction(async (tx) => {
    const session = await tx.appClientSession.findUnique({ where: { sessionId } });
    if (!session || session.status !== AppClientSessionStatus.ACTIVE) return session;

    const now = new Date();
    await tx.appClientSession.update({
      where: { id: session.id },
      data: {
        status,
        logoutAt: status === 'LOGGED_OUT' ? now : session.logoutAt,
        revokedAt: status === 'REVOKED' ? now : session.revokedAt,
        revokeReason: status === 'REVOKED' ? reason ?? 'Revoked by administrator' : session.revokeReason,
      },
    });
    await tx.appClientSlot.updateMany({
      where: { id: session.slotId, activeSessionId: session.id },
      data: { status: 'AVAILABLE', activeSessionId: null, lastLogoutAt: now },
    });
    return session;
  });
}

export async function listUserSessions(userId: string, tenantId: string | null) {
  return prisma.appClientSlot.findMany({
    where: { userId, ...(tenantId ? { tenantId } : {}) },
    orderBy: { channel: 'asc' },
    include: {
      activeSession: true,
      sessions: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
}

function activityStatus(slot: { status: string; activeSession: { status: string; lastActiveAt: Date } | null; sessions: Array<{ status: string; lastActiveAt: Date }> }) {
  const current = slot.activeSession;
  if (current?.status === 'ACTIVE') {
    return Date.now() - current.lastActiveAt.getTime() <= CLIENT_ACTIVITY_WINDOW_MS ? 'ONLINE' : 'OFFLINE';
  }
  const last = slot.sessions[0];
  return last?.status === 'REVOKED' ? 'REVOKED' : last ? 'OFFLINE' : 'NEVER_CONNECTED';
}

export async function listCloserActivity(tenantId: string) {
  const users = await prisma.appAuthUser.findMany({
    where: { tenantId, role: 'SALES_AGENT' },
    orderBy: { displayName: 'asc' },
    select: {
      id: true,
      displayName: true,
      email: true,
      phone: true,
      role: true,
      clientSlots: {
        include: { activeSession: true, sessions: { orderBy: { createdAt: 'desc' }, take: 1 } },
      },
    },
  });

  return users.map((user) => {
    const byChannel = (channel: AppClientChannel) => {
      const slot = user.clientSlots.find((item) => item.channel === channel);
      const current = slot?.activeSession ?? null;
      const last = slot?.sessions[0] ?? null;
      return {
        status: slot ? activityStatus(slot) : 'NEVER_CONNECTED',
        lastLoginAt: slot?.lastLoginAt?.toISOString() ?? last?.loginAt?.toISOString() ?? null,
        lastActiveAt: current?.lastActiveAt?.toISOString() ?? last?.lastActiveAt?.toISOString() ?? null,
        sessionId: current?.sessionId ?? null,
        deviceId: current?.deviceId ?? last?.deviceId ?? null,
        deviceName: current?.deviceName ?? last?.deviceName ?? null,
        platform: current?.platform ?? last?.platform ?? null,
        appVersion: current?.appVersion ?? last?.appVersion ?? null,
      };
    };

    return {
      userId: user.id,
      displayName: user.displayName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      mobile: byChannel(AppClientChannel.MOBILE),
      desktop: byChannel(AppClientChannel.DESKTOP),
    };
  });
}

