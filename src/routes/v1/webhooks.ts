import { assignLeadToNextCloser } from '../../lib/lead-assignment-engine.js';
import { generateAiCloserReply } from '../../lib/ai-provider-engine.js';
import { Router, Request, Response } from 'express';
import { verifyWebhookSignature } from '../../middlewares/webhook-signature.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { persistApiRealtimeEvent } from '../../lib/realtime.js';

export const webhooksRouter = Router();

// ==========================================
// 1. Meta / WhatsApp Webhooks
// ==========================================

// Meta verification handshake GET endpoint
webhooksRouter.get(['/meta', '/whatsapp'], (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && (token === process.env.META_VERIFY_TOKEN || token === 'aicloser_webhook_secret_2026')) {
    logger.info('Meta webhook handshake verified');
    res.status(200).send(challenge);
    return;
  }

  res.status(403).send('Verification token mismatch');
});

// Meta incoming event POST endpoint with signature verification
webhooksRouter.post(['/meta', '/whatsapp'], verifyWebhookSignature, async (req: Request, res: Response) => {
  const body = req.body;

  // Acknowledge Meta immediately with 200 OK within 3 seconds
  res.status(200).json({ status: 'received' });

  // Process asynchronously
  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value) return;

    const channelId = value.metadata?.phone_number_id;

    // Map channel to tenant
    if (!channelId) {
      console.warn('[Webhook Quarantine] Received event with missing phoneNumberId. Rejecting.');
      return;
    }

    const channel = await prisma.whatsAppChannel.findFirst({
      where: { phoneNumberId: channelId },
      select: { tenantId: true, id: true },
    });

    if (!channel || !channel.tenantId) {
      console.warn('[Webhook Quarantine] Unmapped WhatsApp channel phoneNumberId: ' + channelId + '. Quarantining event.');
      return;
    }

    const tenantId = channel.tenantId;

    // 1. Handle incoming message
    if (value.messages?.length) {
      for (const msg of value.messages) {
        const rawFrom = String(msg.from || '').replace(/\D/g, '');
        const normalizedPhone = rawFrom.startsWith('+') ? rawFrom : (rawFrom.length === 10 ? `+91${rawFrom}` : `+${rawFrom}`);
        const messageText = msg.text?.body || msg.caption || (msg.type ? `[${msg.type}]` : '[Attachment]');
        const messageId = msg.id || `msg-${Date.now()}`;
        const profileName = value.contacts?.[0]?.profile?.name || normalizedPhone;

        // Find existing conversation
        let conversation = await prisma.appConversation.findFirst({
          where: { tenantId, customerPhone: normalizedPhone },
        });

        const newMessage = {
          id: messageId,
          role: 'customer',
          senderRole: 'customer',
          senderLabel: profileName,
          body: messageText,
          lane: 'customer',
          externalMessageId: messageId,
          createdAt: new Date(Number(msg.timestamp || Date.now() / 1000) * 1000).toISOString(),
          status: 'DELIVERED',
        };

        if (conversation) {
          const payload = (conversation.payload as Record<string, unknown>) || {};
          const existingMessages = Array.isArray(payload.messages) ? (payload.messages as Record<string, unknown>[]) : [];

          // Idempotency check: don't append if message ID already exists
          if (!existingMessages.some((m) => m.externalMessageId === messageId || m.id === messageId)) {
            existingMessages.push(newMessage);
            // Bounded message storage: keep last 100 messages
            const boundedMessages = existingMessages.slice(-100);
            payload.messages = boundedMessages;

            await prisma.appConversation.update({
              where: { id: conversation.id },
              data: {
                payload: payload as any,
                updatedAt: new Date(),
              },
            });
          }
        } else {
          // Create normalized conversation
          conversation = await prisma.appConversation.create({
            data: {
              id: `conv-${Math.random().toString(36).slice(2, 10)}`,
              tenantId,
              serviceId: 'svc-whatsapp',
              leadStatusId: 'new',
              customerName: profileName,
              customerPhone: normalizedPhone,
              status: 'Open',
              serviceSlug: 'whatsapp',
              payload: {
                messages: [newMessage],
                sourceChannel: 'whatsapp',
                customerName: profileName,
                customerPhone: normalizedPhone,
              },
            },
          });
        }

        // Deduplicated Lead Check: link or touch lead without creating duplicates
        const last10 = normalizedPhone.replace(/\D/g, '').slice(-10);
        let lead = await prisma.salesLeadAssignment.findFirst({
          where: { tenantId, customerPhone: { contains: last10 } },
          orderBy: [
            { stage: 'desc' },
            { createdAt: 'asc' },
          ],
        });

        if (lead) {
          await prisma.salesLeadAssignment.update({
            where: { id: lead.id },
            data: {
              lastContactedAt: new Date(),
              conversationId: conversation.id,
            },
          });
        } else {
          // Strictly fetch non-admin active sales agent profile as fallback holder
          let agent = await prisma.salesAgentProfile.findFirst({
            where: {
              tenantId,
              status: 'ACTIVE',
              user: { role: 'SALES_AGENT', packageStatus: 'ACTIVE' },
            },
          });

          if (!agent) {
            agent = await prisma.salesAgentProfile.findFirst({
              where: { tenantId },
            });
          }

          if (agent) {
            lead = await prisma.salesLeadAssignment.create({
              data: {
                tenantId,
                assignedAgentId: agent.id,
                customerName: profileName,
                customerPhone: normalizedPhone,
                conversationId: conversation.id,
                source: 'WHATSAPP',
                stage: 'NEW',
                notes: `Inbound message from WhatsApp: "${messageText.slice(0, 100)}"`,
              },
            });

            // Execute strict round-robin & source rule distribution
            try {
              await assignLeadToNextCloser({
                tenantId,
                leadId: lead.id,
                source: 'WHATSAPP',
              });
            } catch (rrErr) {
              logger.warn('Inbound WhatsApp lead assignment engine failed, keeping fallback', { error: String(rrErr) });
            }
          }
        }

        // Broadcast Realtime Event to Closer UI
        await persistApiRealtimeEvent({
          tenantId,
          eventType: 'chat.message',
          payload: {
            conversationId: conversation.id,
            leadId: lead?.id,
            message: newMessage,
            customerPhone: normalizedPhone,
            customerName: profileName,
          },
        }).catch(() => undefined);

        // ==========================================
        // Runtime AI Auto-Reply Execution
        // ==========================================
        try {
          const workspace = await prisma.aicloserWorkspace.findUnique({
            where: { id: tenantId },
            select: { settings: true },
          });

          const wsSettings = (workspace?.settings as Record<string, any>) || {};
          const botConfig = wsSettings.aiBotConfig || {};

          if (botConfig.enabled) {
            const aiResult = await generateAiCloserReply({
              tenantId,
              customerPhone: normalizedPhone,
              customerName: profileName,
              messageText,
            });

            if (aiResult?.reply) {
              // Dispatch to Meta Graph API if access token exists
              const channelRecord = await prisma.whatsAppChannel.findFirst({
                where: { phoneNumberId: channelId },
                select: { encryptedAccessToken: true, phoneNumberId: true },
              });

              const token = channelRecord?.encryptedAccessToken || process.env.META_ACCESS_TOKEN;
              if (token && channelRecord) {
                await fetch(`https://graph.facebook.com/v22.0/${channelRecord.phoneNumberId}/messages`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                  },
                  body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to: normalizedPhone.replace(/\D/g, ''),
                    type: 'text',
                    text: { preview_url: false, body: aiResult.reply },
                  }),
                }).catch((err) => {
                  logger.warn('Meta Graph API outbound dispatch failed', { error: String(err) });
                });
              }

              // Record outbound message in conversation payload
              const outboundMessage = {
                id: `ai-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                role: 'assistant',
                senderRole: 'ai',
                senderLabel: 'AI Closer Bot',
                body: aiResult.reply,
                lane: 'agent',
                createdAt: new Date().toISOString(),
                status: 'SENT',
                metadata: {
                  provider: aiResult.provider,
                  model: aiResult.model,
                  latencyMs: aiResult.latencyMs,
                },
              };

              const convFresh = await prisma.appConversation.findUnique({ where: { id: conversation.id } });
              if (convFresh) {
                const p = (convFresh.payload as Record<string, unknown>) || {};
                const msgs = Array.isArray(p.messages) ? (p.messages as Record<string, unknown>[]) : [];
                msgs.push(outboundMessage);
                p.messages = msgs.slice(-100);

                await prisma.appConversation.update({
                  where: { id: conversation.id },
                  data: {
                    payload: p as any,
                    updatedAt: new Date(),
                  },
                });

                // Broadcast outbound AI reply via realtime SSE
                await persistApiRealtimeEvent({
                  tenantId,
                  eventType: 'chat.message',
                  payload: {
                    conversationId: conversation.id,
                    leadId: lead?.id,
                    message: outboundMessage,
                    customerPhone: normalizedPhone,
                    customerName: profileName,
                  },
                }).catch(() => undefined);

                // Log activity on lead
                if (lead) {
                  await prisma.salesActivityLog.create({
                    data: {
                      tenantId,
                      assignmentId: lead.id,
                      action: 'AI_AUTOREPLY_DISPATCHED',
                      note: `AI Bot sent reply: "${aiResult.reply.slice(0, 80)}..."`,
                      metadata: { provider: aiResult.provider, latencyMs: aiResult.latencyMs },
                    },
                  }).catch(() => undefined);
                }
              }
            }
          }
        } catch (aiErr) {
          logger.warn('AI auto-reply execution failed in webhook', { error: String(aiErr) });
        }
      }
    }

    // 2. Handle message delivery status updates
    if (value.statuses?.length) {
      for (const st of value.statuses) {
        const wamid = st.id;
        const statusStr = (st.status || 'SENT').toUpperCase();

        await prisma.whatsAppMessageEvent.create({
          data: {
            tenantId,
            wamid,
            eventType: statusStr,
            occurredAt: new Date(Number(st.timestamp || Date.now() / 1000) * 1000),
            rawPayload: st,
          },
        }).catch(() => undefined);

        await persistApiRealtimeEvent({
          tenantId,
          eventType: 'chat.status_updated',
          payload: {
            wamid,
            status: statusStr,
            timestamp: new Date().toISOString(),
          },
        }).catch(() => undefined);
      }
    }
  } catch (err: unknown) {
    logger.error('Error processing Meta webhook event', { error: String(err) });
  }
});

// ==========================================
// 2. Instagram Direct Webhooks
// ==========================================

webhooksRouter.get('/instagram', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    res.status(200).send(challenge);
    return;
  }
  res.status(403).send('Verification token mismatch');
});

webhooksRouter.post('/instagram', verifyWebhookSignature, async (req: Request, res: Response) => {
  res.status(200).json({ status: 'received' });
  logger.info('Instagram webhook received', { entries: req.body.entry?.length });
});

webhooksRouter.post('/instagram/deauthorize', async (req: Request, res: Response) => {
  res.json({ success: true, message: 'Instagram deauthorization acknowledged' });
});

webhooksRouter.post('/instagram/data-deletion', async (req: Request, res: Response) => {
  const confirmationCode = `del_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  res.json({
    url: `https://aicloser.in/privacy/deletion-status?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
});
