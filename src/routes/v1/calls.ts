import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { SalesMobileCallDirection, SalesMobileCallStatus } from '@prisma/client';
import { SalesLeadStage, salesLeadStageSchema } from '../../types/leads.js';
import { Prisma } from '@prisma/client';
import { persistApiRealtimeEvent } from '../../lib/realtime.js';
import { getRecordingPlayback } from '../../lib/recording-storage.js';
import { hasPermission, PERM_RECORDINGS_PLAY_ALL } from '../../middlewares/rbac.js';

export const callsRouter = Router();

callsRouter.use(authenticate, enforceTenantIsolation);

async function resolveCallRecording(callId: string, req: Request) {
  const tenantId = req.tenantId!;
  const call = await prisma.salesMobileCall.findFirst({
    where: { id: callId, tenantId },
    select: { id: true, tenantId: true, agentId: true, recordingStatus: true },
  });

  if (!call) {
    return { ok: false as const, status: 404, error: 'NotFound', message: 'Call not found in this workspace' };
  }
  if (call.recordingStatus !== 'UPLOADED') {
    return { ok: false as const, status: 404, error: 'RecordingNotReady', message: 'This call does not have an uploaded recording' };
  }

  if (req.user?.role === 'SALES_AGENT') {
    const canPlayAll = await hasPermission(req.user.userId, tenantId, 'SALES_AGENT', PERM_RECORDINGS_PLAY_ALL);
    if (!canPlayAll) {
      const profile = await prisma.salesAgentProfile.findFirst({
        where: { userId: req.user.userId, tenantId },
        select: { id: true },
      });
      if (!profile || call.agentId !== profile.id) {
        return { ok: false as const, status: 403, error: 'Forbidden', message: 'You can only listen to recordings for your own calls' };
      }
    }
  }

  const upload = await prisma.callRecordingUpload.findFirst({
    where: { tenantId, callId: call.id, status: 'UPLOADED' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, objectKey: true, mimeType: true },
  });
  if (!upload) {
    return { ok: false as const, status: 404, error: 'RecordingNotFound', message: 'Uploaded recording metadata was not found' };
  }

  return { ok: true as const, call, upload };
}

async function sendCallRecording(req: Request, res: Response) {
  const result = await resolveCallRecording(String(req.params.id), req);
  if (!result.ok) {
    res.status(result.status).json({ success: false, error: result.error, message: result.message });
    return;
  }

  let playback;
  try {
    playback = await getRecordingPlayback({ objectKey: result.upload.objectKey, contentType: result.upload.mimeType });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'RecordingFileNotFound', message: 'Recording metadata exists but the audio file is unavailable' });
      return;
    }
    throw error;
  }
  if (playback.mode === 's3') {
    res.json({ success: true, data: { url: playback.url, expiresIn: 300, callId: result.call.id, recordingUploadId: result.upload.id } });
    return;
  }
  res.setHeader('Content-Type', playback.contentType);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(playback.bytes);
}

const listCallsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.string().optional().transform((v) => (v ? Math.min(100, Math.max(1, Number(v))) : 25)),
  phoneNumber: z.string().optional(),
  agentId: z.string().optional(),
  recordingStatus: z.string().optional(),
  search: z.string().optional(),
});

callsRouter.get('/', validateQuery(listCallsQuerySchema), async (req: Request, res: Response) => {
  const { cursor, limit, phoneNumber, agentId, recordingStatus, search } = req.query as unknown as {
    cursor?: string;
    limit: number;
    phoneNumber?: string;
    agentId?: string;
    recordingStatus?: string;
    search?: string;
  };

  const tenantId = req.tenantId!;
  const where: Prisma.SalesMobileCallWhereInput = { tenantId };

  if (phoneNumber) where.phoneNumber = phoneNumber;

    // Strict closer scoping: SALES_AGENT can only view calls they logged unless they have calls:view_all permission
  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true, permissions: true },
    });
    const perms = (profile?.permissions as Record<string, boolean> | null) || {};
    if (perms['calls:view_all']) {
      if (agentId) where.agentId = agentId;
    } else {
      where.agentId = profile?.id ?? '__NO_ACCESS__';
    }
  } else if (agentId) {
    where.agentId = agentId;
  }
  if (recordingStatus) where.recordingStatus = recordingStatus as Prisma.EnumSalesMobileRecordingStatusFilter;
  if (search) {
    where.OR = [
      { phoneNumber: { contains: search } },
      { assignment: { customerName: { contains: search, mode: 'insensitive' } } },
      { assignment: { customerEmail: { contains: search, mode: 'insensitive' } } },
    ];
  }

  const rows = await prisma.salesMobileCall.findMany({
    where,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: limit + 1,
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    include: {
      agent: {
        select: {
          id: true,
          agentCode: true,
          user: { select: { displayName: true } },
        },
      },
      assignment: {
        select: {
          id: true,
          customerName: true,
          customerPhone: true,
          stage: true,
        },
      },
    },
  });
  const hasMore = rows.length > limit;
  const calls = hasMore ? rows.slice(0, limit) : rows;
  const recordingUploads = calls.length
    ? await prisma.callRecordingUpload.findMany({
        where: { tenantId, callId: { in: calls.map((call) => call.id) }, status: 'UPLOADED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, callId: true },
      })
    : [];
  const recordingByCallId = new Map<string, string>();
  for (const upload of recordingUploads) {
    if (!recordingByCallId.has(upload.callId)) recordingByCallId.set(upload.callId, upload.id);
  }
  const enrichedCalls = calls.map((call) => ({
    ...call,
    recordingUploadId: recordingByCallId.get(call.id) ?? null,
    hasRecording: Boolean(recordingByCallId.get(call.id)),
  }));

  res.json({
    success: true,
    data: {
      // The resolver is intentionally call-ID based so dashboard and chat clients
      // do not need to know storage keys or make a second metadata lookup.
      calls: enrichedCalls,
      pagination: {
        limit,
        cursor: cursor ?? null,
        nextCursor: hasMore ? calls[calls.length - 1]?.id ?? null : null,
        hasMore,
      },
    },
  });
});

// Call-ID based playback bridge for dashboard/chat clients. The existing
// /recordings/:id/playback contract remains available for mobile upload flows.
callsRouter.get('/:id/recording', sendCallRecording);
callsRouter.get('/:id/playback', sendCallRecording);

const logCallSchema = z.object({
  assignmentId: z.string().min(1, 'Assignment ID required'),
  agentId: z.string().min(1, 'Agent ID required'),
  phoneNumber: z.string().min(5, 'Phone number required'),
  direction: z.nativeEnum(SalesMobileCallDirection).default('OUTBOUND'),
  status: z.nativeEnum(SalesMobileCallStatus).default('INITIATED'),
  durationSeconds: z.number().int().nonnegative().optional(),
  outcome: z.string().optional(),
  note: z.string().optional(),
});

callsRouter.post('/', validateBody(logCallSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = req.body;

  // Verify lead belongs to same tenant
  const assignment = await prisma.salesLeadAssignment.findFirst({
    where: { id: body.assignmentId, tenantId },
  });

  if (!assignment) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Lead not found in this workspace' });
    return;
  }

  // Strict closer scoping: SALES_AGENT can only log calls for themselves
  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    if (!profile || body.agentId !== profile.id) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'You cannot log calls on behalf of another agent' });
      return;
    }
  }

  // Verify agent belongs to same tenant
  const agent = await prisma.salesAgentProfile.findFirst({
    where: { id: body.agentId, tenantId },
  });

  if (!agent) {
    res.status(400).json({ success: false, error: 'InvalidAgent', message: 'Assigned agent does not exist within your workspace' });
    return;
  }

  const call = await prisma.salesMobileCall.create({
    data: {
      tenantId, // Root ownership strictly enforced
      assignmentId: body.assignmentId,
      agentId: body.agentId,
      phoneNumber: body.phoneNumber,
      direction: body.direction,
      status: body.status,
      durationSeconds: body.durationSeconds,
      outcome: body.outcome,
      note: body.note,
    },
  });

  // Log activity
  await prisma.salesActivityLog.create({
    data: {
      tenantId,
      assignmentId: body.assignmentId,
      actorUserId: req.user?.userId,
      action: 'MOBILE_CALL_LOGGED',
      note: `Call logged for ${body.phoneNumber} (${body.direction})`,
      metadata: { callId: call.id, outcome: body.outcome },
    },
  });
  await persistApiRealtimeEvent({
    tenantId,
    actorUserId: req.user?.userId,
    audienceRoles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SALES_AGENT'],
    eventType: 'call.started',
    payload: { callId: call.id, status: call.status, recordingStatus: call.recordingStatus },
  }).catch(() => undefined);

  res.status(201).json({ success: true, data: call });
});

const endCallSchema = z.object({
  status: z.nativeEnum(SalesMobileCallStatus).default('COMPLETED'),
  connectedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  recordingStatus: z.enum(['NONE', 'RECORDING_UNAVAILABLE', 'LOCAL_PENDING', 'UPLOADING', 'UPLOADED', 'FAILED']).optional(),
  recordingError: z.string().max(2000).optional(),
});

callsRouter.post('/:id/end', validateBody(endCallSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const existing = await prisma.salesMobileCall.findFirst({ where: { id, tenantId } });
  if (!existing) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Call not found in this workspace' });
    return;
  }

  // Ownership verification: SALES_AGENT can only end their own calls
  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    if (!profile || existing.agentId !== profile.id) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'You are not authorized to update this call' });
      return;
    }
  }
  const body = req.body as z.infer<typeof endCallSchema>;
  const call = await prisma.salesMobileCall.update({
    where: { id: existing.id },
    data: {
      status: body.status,
      connectedAt: body.connectedAt ? new Date(body.connectedAt) : existing.connectedAt,
      endedAt: body.endedAt ? new Date(body.endedAt) : new Date(),
      durationSeconds: body.durationSeconds ?? existing.durationSeconds,
      recordingStatus: body.recordingStatus ?? existing.recordingStatus,
      recordingError: body.recordingError ?? existing.recordingError,
    },
  });
  await persistApiRealtimeEvent({
    tenantId,
    actorUserId: req.user?.userId,
    audienceRoles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SALES_AGENT'],
    eventType: 'call.ended',
    payload: { callId: call.id, status: call.status, durationSeconds: call.durationSeconds, recordingStatus: call.recordingStatus },
  }).catch(() => undefined);
  res.json({ success: true, data: call });
});

const dispositionSchema = z.object({
  outcome: z.string().min(1, 'Outcome/disposition is required'),
  note: z.string().optional(),
  nextFollowUpAt: z.string().optional(),
  stage: salesLeadStageSchema.optional(),
});

callsRouter.post('/:id/disposition', validateBody(dispositionSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const body = req.body as { outcome: string; note?: string; nextFollowUpAt?: string; stage?: SalesLeadStage };

  const call = await prisma.salesMobileCall.findFirst({
    where: { id, tenantId },
    include: { assignment: true },
  });

  if (!call) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Call not found in this workspace' });
    return;
  }

  // Ownership verification: SALES_AGENT can only set disposition on their own calls
  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    if (!profile || call.agentId !== profile.id) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'You are not authorized to update this call' });
      return;
    }
  }

  const updatedCall = await prisma.salesMobileCall.update({
    where: { id: call.id },
    data: {
      outcome: body.outcome,
      note: body.note ? (call.note ? `${call.note}\n---\n${body.note}` : body.note) : call.note,
      nextFollowUpAt: body.nextFollowUpAt ? new Date(body.nextFollowUpAt) : call.nextFollowUpAt,
    },
  });

  // Update the Sun (Lead)
  if (call.assignmentId) {
    const nextDate = body.nextFollowUpAt ? new Date(body.nextFollowUpAt) : undefined;
    await prisma.salesLeadAssignment.update({
      where: { id: call.assignmentId },
      data: {
        lastCallDisposition: body.outcome,
        lastCallDurationSec: call.durationSeconds || 0,
        totalCallsCount: { increment: 1 },
        lastContactedAt: new Date(),
        ...(nextDate && !isNaN(nextDate.getTime()) ? { followUpAt: nextDate } : {}),
        ...(body.stage ? { stage: body.stage, stageChangedAt: new Date() } : {}),
      },
    });

    if (nextDate && !isNaN(nextDate.getTime())) {
      await prisma.gxLeadTask.create({
        data: {
          salesLeadId: call.assignmentId,
          title: body.note || `Follow-up call with ${call.assignment?.customerName || call.phoneNumber}`,
          dueAt: nextDate,
          priority: 'HIGH',
          status: 'OPEN',
        },
      }).catch(() => undefined);
    }

    await prisma.salesActivityLog.create({
      data: {
        tenantId,
        assignmentId: call.assignmentId,
        actorUserId: req.user?.userId,
        action: 'CALL_DISPOSITION_SUBMITTED',
        note: `Disposition "${body.outcome}" submitted for call ${call.phoneNumber}`,
        metadata: { callId: call.id, outcome: body.outcome, note: body.note || '' },
      },
    });
  }

  await persistApiRealtimeEvent({
    tenantId,
    actorUserId: req.user?.userId,
    audienceRoles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SALES_AGENT'],
    eventType: 'call.disposition_saved',
    payload: { callId: call.id, leadId: call.assignmentId, outcome: body.outcome },
  }).catch(() => undefined);

  res.json({ success: true, data: updatedCall, error: null });
});

callsRouter.post('/:id/discard', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const id = String(req.params.id);
  const { reason } = req.body as { reason?: string };

  const call = await prisma.salesMobileCall.findFirst({
    where: { id, tenantId },
  });

  if (!call) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Call not found in this workspace' });
    return;
  }

  // Ownership verification: SALES_AGENT can only set disposition on their own calls
  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true },
    });
    if (!profile || call.agentId !== profile.id) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'You are not authorized to update this call' });
      return;
    }
  }

  const updatedCall = await prisma.salesMobileCall.update({
    where: { id: call.id },
    data: {
      outcome: 'DISCARDED_PERSONAL',
      note: reason ? `Discarded: ${reason}` : 'Discarded personal/accidental call',
    },
  });

  res.json({ success: true, message: 'Call marked as discarded from CRM metrics', data: updatedCall, error: null });
});
