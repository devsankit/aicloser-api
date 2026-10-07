import { Router, Request, Response } from 'express';
import { verifyWebhookSignature } from '../../middlewares/webhook-signature.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';

export const webhooksRouter = Router();

// Meta verification handshake GET endpoint
webhooksRouter.get('/meta', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    logger.info('Meta webhook handshake verified');
    res.status(200).send(challenge);
    return;
  }

  res.status(403).send('Verification token mismatch');
});

// Meta incoming event POST endpoint with signature verification
webhooksRouter.post('/meta', verifyWebhookSignature, async (req: Request, res: Response) => {
  const body = req.body;
  logger.info('Meta webhook event received', { entryCount: body.entry?.length });

  // Acknowledge Meta immediately with 200 OK
  res.status(200).json({ status: 'received' });

  // Process asynchronously
  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (value?.messages?.length) {
      const msg = value.messages[0];
      const from = msg.from;
      const text = msg.text?.body;
      const channelId = value.metadata?.phone_number_id;

      // Map channel to tenant
      const channel = await prisma.whatsAppChannel.findFirst({
        where: { phoneNumberId: channelId },
        select: { tenantId: true },
      });

      const tenantId = channel?.tenantId || 'tenant-gigxomi';

      logger.info('Routed WhatsApp message to tenant', { from, tenantId, hasText: Boolean(text) });
    }
  } catch (err: unknown) {
    logger.error('Error processing webhook payload', { error: err instanceof Error ? err.message : String(err) });
  }
});
