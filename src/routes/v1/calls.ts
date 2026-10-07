import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody, validateQuery } from '../../middlewares/validate.js';
import { SalesMobileCallDirection, SalesMobileCallStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { persistApiRealtimeEvent } from '../../lib/realtime.js';

export const callsRouter = Router();

callsRouter.use(authenticate, enforceTenantIsolation);

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
  if (agentId) where.agentId = agentId;
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

  res.json({
    success: true,
    data: {
      calls,
      pagination: {
        limit,
        cursor: cursor ?? null,
        nextCursor: hasMore ? calls[calls.length - 1]?.id ?? null : null,
        hasMore,
      },
    },
  });
});

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
