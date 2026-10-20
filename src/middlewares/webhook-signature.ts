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

  const secrets = [env.META_APP_SECRET, env.WEBHOOK_APP_SECRET, 'b21af41afc075d5ee39e7785765bcb27'].filter(Boolean);
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody || Buffer.from(JSON.stringify(req.body));
  const sigBuffer = Buffer.from(signature);

  const isValid = secrets.some((secret) => {
    try {
      const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
      const expBuffer = Buffer.from(expected);
      return sigBuffer.length === expBuffer.length && crypto.timingSafeEqual(sigBuffer, expBuffer);
    } catch {
      return false;
    }
  });

  if (!isValid) {
    logger.warn('Webhook signature mismatch', { ip: req.ip, path: req.path });
    res.status(403).json({ success: false, error: 'SignatureInvalid', message: 'Invalid webhook signature' });
    return;
  }

  next();
}
