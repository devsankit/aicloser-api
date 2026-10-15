import express, { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody } from '../../middlewares/validate.js';
import { createRecordingUploadUrl, getRecordingPlayback, recordingExists, recordingStorageMode, writeRecording } from '../../lib/recording-storage.js';

export const recordingsRouter = express.Router();
recordingsRouter.use(authenticate, enforceTenantIsolation);

const initSchema = z.object({
  callId: z.string().min(1),
  clientUploadId: z.string().min(8).max(160),
  deviceId: z.string().optional(),
  mimeType: z.string().max(120).optional(),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024).optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
});

function safePart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
}

recordingsRouter.post('/init', validateBody(initSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const input = req.body as z.infer<typeof initSchema>;
  const call = await prisma.salesMobileCall.findFirst({
    where: { id: input.callId, tenantId },
    select: { id: true, tenantId: true, agentId: true },
  });

  if (!call) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Call not found in this workspace' });
    return;
  }

  const existing = await prisma.callRecordingUpload.findUnique({
    where: { tenantId_clientUploadId: { tenantId, clientUploadId: input.clientUploadId } },
  });
  if (existing) {
    if (existing.callId !== call.id) {
      res.status(409).json({ success: false, error: 'IdempotencyKeyConflict', message: 'clientUploadId is already assigned to another call' });
      return;
    }
    const upload = await createRecordingUploadUrl({ objectKey: existing.objectKey, contentType: existing.mimeType });
    res.json({ success: true, data: { upload: existing, uploadUrl: upload.url, uploadMethod: upload.method, storageMode: upload.mode, idempotent: true } });
    return;
  }

  // Device ownership validation
  if (input.deviceId) {
    const device = await prisma.salesMobileDevice.findFirst({
      where: { deviceId: input.deviceId, tenantId },
    });
    if (!device) {
      res.status(403).json({ success: false, error: 'UnregisteredDevice', message: 'Device not registered in this workspace' });
      return;
    }
  }

  const objectKey = `${safePart(tenantId)}/calls/${safePart(call.id)}/${safePart(input.clientUploadId)}`;
  const upload = await prisma.callRecordingUpload.create({
    data: {
      tenantId,
      callId: call.id,
      deviceId: input.deviceId,
      clientUploadId: input.clientUploadId,
      objectKey,
      status: 'LOCAL_PENDING',
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      durationSeconds: input.durationSeconds,
    },
  });
  const destination = await createRecordingUploadUrl({ objectKey, contentType: input.mimeType });
  res.status(201).json({ success: true, data: { upload, uploadUrl: destination.url, uploadMethod: destination.method, storageMode: destination.mode, idempotent: false } });
});

recordingsRouter.post('/:id/content', express.raw({ type: ['application/octet-stream', 'audio/*'], limit: '50mb' }), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const uploadId = String(req.params.id);
  const upload = await prisma.callRecordingUpload.findFirst({ where: { id: uploadId, tenantId } });
  if (!upload) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Recording upload not found in this workspace' });
    return;
  }
  if (recordingStorageMode() !== 'local') {
    res.status(409).json({ success: false, error: 'DirectUploadRequired', message: 'Use the signed upload URL returned by the init endpoint' });
    return;
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ success: false, error: 'ValidationError', message: 'Recording content is required' });
    return;
  }

  try {
    await prisma.callRecordingUpload.update({ where: { id: upload.id }, data: { status: 'UPLOADING', attemptCount: { increment: 1 }, startedAt: new Date(), lastError: null } });
    await writeRecording(upload.objectKey, req.body, upload.mimeType);
    res.status(204).send();
  } catch (error) {
    await prisma.callRecordingUpload.update({ where: { id: upload.id }, data: { status: 'FAILED', lastError: error instanceof Error ? error.message : 'Recording upload failed' } });
    res.status(500).json({ success: false, error: 'UploadFailed', message: 'Recording upload failed' });
  }
});

recordingsRouter.post('/:id/complete', validateBody(z.object({ checksum: z.string().max(256).optional(), sizeBytes: z.number().int().positive().max(50 * 1024 * 1024).optional() })), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const uploadId = String(req.params.id);
  const upload = await prisma.callRecordingUpload.findFirst({ where: { id: uploadId, tenantId } });
  if (!upload) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Recording upload not found in this workspace' });
    return;
  }
  if (!(await recordingExists(upload.objectKey))) {
    await prisma.callRecordingUpload.update({ where: { id: upload.id }, data: { status: 'FAILED', lastError: 'Uploaded object was not found' } });
    res.status(409).json({ success: false, error: 'ObjectMissing', message: 'Recording bytes are not available yet' });
    return;
  }

  const body = req.body as { checksum?: string; sizeBytes?: number };
  const completed = await prisma.$transaction(async (tx) => {
    const saved = await tx.callRecordingUpload.update({
      where: { id: upload.id },
      data: { status: 'UPLOADED', checksum: body.checksum, sizeBytes: body.sizeBytes ?? upload.sizeBytes, completedAt: new Date(), lastError: null },
    });
    await tx.salesMobileCall.update({
      where: { id: upload.callId },
      data: { recordingStatus: 'UPLOADED', recordingPath: upload.objectKey, recordingMimeType: upload.mimeType, recordingSizeBytes: body.sizeBytes ?? upload.sizeBytes },
    });
    return saved;
  });
  res.json({ success: true, data: completed });
});

recordingsRouter.get('/:id/playback', async (req: Request, res: Response) => {
  const uploadId = String(req.params.id);
  const upload = await prisma.callRecordingUpload.findFirst({ where: { id: uploadId, tenantId: req.tenantId!, status: 'UPLOADED' } });
  if (!upload) {
    res.status(404).json({ success: false, error: 'NotFound', message: 'Uploaded recording not found in this workspace' });
    return;
  }

  // Strict closer scoping: Closers can only listen to recordings of calls they conducted
  if (req.user?.role === 'SALES_AGENT') {
    const profile = await prisma.salesAgentProfile.findFirst({
      where: { userId: req.user.userId, tenantId: req.tenantId! },
      select: { id: true },
    });
    const call = await prisma.salesMobileCall.findFirst({
      where: { id: upload.callId, tenantId: req.tenantId! },
      select: { agentId: true },
    });
    if (call?.agentId !== profile?.id) {
      res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only listen to recordings for your own calls' });
      return;
    }
  }

  const playback = await getRecordingPlayback({ objectKey: upload.objectKey, contentType: upload.mimeType });
  if (playback.mode === 's3') {
    res.json({ success: true, data: { url: playback.url, expiresIn: 300 } });
    return;
  }
  res.setHeader('Content-Type', playback.contentType);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(playback.bytes);
});
