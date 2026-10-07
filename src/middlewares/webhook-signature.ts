import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export function verifyWebhookSignature(req: Request, res: Response, next: NextFunction): void {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;

  if (!signature) {
    logger.warn('Webhook received without X-Hub-Signature-256', { ip: req.ip, path: req.path });
    res.status(401).json({ success: false, error: 'SignatureMissing', message: 'Webhook signature header missing' });
    return;
  }

  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody || Buffer.from(JSON.stringify(req.body));
  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', env.WEBHOOK_APP_SECRET)
    .update(rawBody)
    .digest('hex')}`;

  const sigBuffer = Buffer.from(signature);
  const expBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
    logger.warn('Webhook signature mismatch', { ip: req.ip, path: req.path });
    res.status(403).json({ success: false, error: 'SignatureInvalid', message: 'Invalid webhook signature' });
    return;
  }

  next();
}
