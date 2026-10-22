import { assignLeadToNextCloser } from '../../lib/lead-assignment-engine.js';
import { generateAiCloserReply } from '../../lib/ai-provider-engine.js';
import { decryptWhatsAppToken } from '../../lib/crypto-vault.js';
import { Router, Request, Response } from 'express';
import { verifyWebhookSignature } from '../../middlewares/webhook-signature.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { persistApiRealtimeEvent } from '../../lib/realtime.js';
import { env } from '../../config/env.js';

export const webhooksRouter = Router();

// ==========================================
// 1. Meta / WhatsApp Webhooks
// ==========================================

// Meta verification handshake GET endpoint
webhooksRouter.get(['/meta', '/whatsapp', '/whatsapp-marketing'], async (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const allowedTokens = [
    env.META_VERIFY_TOKEN,
    process.env.META_VERIFY_TOKEN,
  ].filter(Boolean);

  let verified = mode === 'subscribe' && typeof token === 'string' && allowedTokens.includes(token);

  if (!verified && mode === 'subscribe' && typeof token === 'string') {
    try {
      const channel = await prisma.whatsAppChannel.findFirst({
        where: { webhookVerifyToken: token },
        select: { id: true },
      });
      if (channel) verified = true;
    } catch {
      // ignore
    }
  }

  if (verified) {
    logger.info('Meta webhook handshake verified successfully', { mode, tokenPrefix: typeof token === 'string' ? token.slice(0, 4) + '***' : '' });
    res.status(200).send(challenge);
    return;
  }

  logger.warn('Meta webhook verification token mismatch', { mode, receivedToken: token });
  res.status(403).send('Verification token mismatch');
});

// Meta incoming event POST endpoint with signature verification
webhooksRouter.post(['/meta', '/whatsapp', '/whatsapp-marketing'], verifyWebhookSignature, async (req: Request, res: Response) => {
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
        const messageText = ((): string => {
          if (msg.text?.body) return msg.text.body;
          if (msg.caption) return msg.caption;
          if (msg.reaction?.emoji) return msg.reaction.emoji;
          if (msg.interactive?.button_reply?.title) return msg.interactive.button_reply.title;
          if (msg.interactive?.list_reply?.title) return msg.interactive.list_reply.title;
          if (msg.interactive?.header?.text) return msg.interactive.header.text;
          if (msg.button?.text) return msg.button.text;
          if (msg.image) return msg.image.caption ? `📷 ${msg.image.caption}` : '📷 Photo';
          if (msg.video) return msg.video.caption ? `🎥 ${msg.video.caption}` : '🎥 Video';
          if (msg.document) return msg.document.filename ? `📄 ${msg.document.filename}` : '📄 Document';
          if (msg.audio || msg.voice) return '🎤 Voice message';
          if (msg.sticker) return '🏷️ Sticker';
          if (msg.location) return msg.location.name ? `📍 ${msg.location.name}` : `📍 Location (${msg.location.latitude || ''}, ${msg.location.longitude || ''})`;
          if (msg.contacts?.length) return `👤 Contact: ${msg.contacts[0]?.name?.formatted_name || msg.contacts[0]?.phones?.[0]?.phone || 'Card'}`;
          if (msg.type === 'reaction' && msg.reaction?.emoji) return msg.reaction.emoji;
          if (msg.type === 'unsupported') {
            const errDetail = msg.errors?.[0]?.details || msg.errors?.[0]?.title;
            if (errDetail && !errDetail.toLowerCase().includes('not supported')) {
              return `[${errDetail}]`;
            }
            return 'OK 👍';
          }
          if (msg.type) return `[${msg.type}]`;
          return '[Attachment]';
        })();
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
          // Strictly fetch non-admin active sales agent profile as initial holder
          const agent = await prisma.salesAgentProfile.findFirst({
            where: {
              tenantId,
              status: 'ACTIVE',
              user: { role: 'SALES_AGENT', packageStatus: 'ACTIVE' },
            },
          });

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
          } else {
            // Admins are NEVER auto-assigned: when no active SALES_AGENT closer is available, send to unassigned Grab Pool
            await prisma.salesLeadPoolItem.create({
              data: {
                tenantId,
                customerName: profileName,
                customerPhone: normalizedPhone,
                source: 'WHATSAPP',
                notes: `Inbound WhatsApp conversation: "${messageText.slice(0, 100)}"`,
                status: 'OPEN',
              },
            }).catch(() => undefined);
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

        // Track reply in WhatsApp marketing campaign if customer is a campaign recipient
        try {
          const campRecip = await prisma.whatsAppCampaignRecipient.findFirst({
            where: {
              e164Phone: normalizedPhone,
              campaign: { tenantId },
            },
            orderBy: { createdAt: 'desc' },
          });

          if (campRecip) {
            await prisma.$transaction([
              prisma.whatsAppCampaign.update({
                where: { id: campRecip.campaignId },
                data: { repliedCount: { increment: 1 } },
              }),
              prisma.whatsAppCampaignRecipient.update({
                where: { id: campRecip.id },
                data: { status: 'READ' },
              }),
            ]).catch(() => undefined);

            // Hook point for future AI Automation on campaign replies
            await persistApiRealtimeEvent({
              tenantId,
              eventType: 'campaign.replied',
              payload: {
                campaignId: campRecip.campaignId,
                recipientId: campRecip.id,
                customerPhone: normalizedPhone,
                customerName: profileName,
                conversationId: conversation.id,
                leadId: lead?.id,
                replyText: messageText,
                repliedAt: new Date().toISOString(),
              },
            }).catch(() => undefined);
          }
        } catch {}

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
            const currentPayload = (conversation.payload as Record<string, any>) || {};

            if (currentPayload.aiAutoReplyDisabled === true) {
              logger.info('AI auto-reply skipped: thread has aiAutoReplyDisabled=true (human takeover)', {
                conversationId: conversation.id,
                customerPhone: normalizedPhone,
              });
            } else {
              const recentMsgs = Array.isArray(currentPayload.messages) ? currentPayload.messages.slice(-8) : [];

              const aiResult = await generateAiCloserReply({
                tenantId,
                customerPhone: normalizedPhone,
                customerName: profileName,
                messageText,
                recentMessages: recentMsgs,
              });

              if (aiResult?.reply) {
              // Dispatch to Meta Graph API if access token exists
              const channelRecord = await prisma.whatsAppChannel.findFirst({
                where: { phoneNumberId: channelId },
                select: { encryptedAccessToken: true, phoneNumberId: true, graphApiVersion: true },
              });

              const rawToken = channelRecord?.encryptedAccessToken || process.env.META_ACCESS_TOKEN;
              const token = decryptWhatsAppToken(rawToken);
              let aiExternalMessageId: string | null = null;

              if (token && channelRecord) {
                const apiVer = channelRecord.graphApiVersion || 'v22.0';
                try {
                  const metaRes = await fetch(`https://graph.facebook.com/${apiVer}/${channelRecord.phoneNumberId}/messages`, {
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
                  });
                  const metaData = (await metaRes.json().catch(() => null)) as any;
                  if (metaRes.ok && metaData?.messages?.[0]?.id) {
                    aiExternalMessageId = metaData.messages[0].id;
                    logger.info('Meta Graph API outbound AI reply dispatched', {
                      wamid: aiExternalMessageId,
                      recipientPhone: normalizedPhone,
                    });
                  } else {
                    logger.warn('Meta Graph API outbound AI reply failed', {
                      status: metaRes.status,
                      error: metaData?.error || metaData,
                    });
                  }
                } catch (err) {
                  logger.warn('Meta Graph API outbound dispatch caught error', { error: String(err) });
                }
              }

              // Record outbound message in conversation payload
              const outboundMessage = {
                id: `ai-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                externalMessageId: aiExternalMessageId,
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
        const occurredAt = new Date(Number(st.timestamp || Date.now() / 1000) * 1000);

        let errorMessage: string | null = null;
        if (Array.isArray(st.errors) && st.errors.length > 0) {
          const err = st.errors[0];
          errorMessage = err.error_data?.details || err.message || err.title || ("Meta error code " + err.code);
        }

        await prisma.whatsAppMessageEvent.create({
          data: {
            tenantId,
            wamid,
            eventType: statusStr,
            occurredAt,
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

        // Reconcile and persist status in AppConversation
        try {
          const mappedStatus = statusStr === 'READ' ? 'read' : statusStr === 'DELIVERED' ? 'delivered' : statusStr === 'FAILED' ? 'failed' : 'sent';
          if (st.recipient_id) {
            const cleanRecip = st.recipient_id.replace(/\D/g, '').slice(-10);
            const conv = await prisma.appConversation.findFirst({
              where: {
                tenantId,
                customerPhone: { contains: cleanRecip },
              },
            });
            if (conv && conv.payload && typeof conv.payload === 'object') {
              const p = conv.payload as Record<string, any>;
              if (Array.isArray(p.messages)) {
                let modified = false;
                const updatedMessages = p.messages.map((m: any) => {
                  if (m.externalMessageId === wamid || m.wamid === wamid || m.id === wamid) {
                    modified = true;
                    return { ...m, status: mappedStatus };
                  }
                  return m;
                });
                if (modified) {
                  await prisma.appConversation.update({
                    where: { id: conv.id },
                    data: {
                      payload: { ...p, messages: updatedMessages },
                    },
                  }).catch(() => undefined);
                }
              }
            }
          }
        } catch {}

        // Reconcile with WhatsApp Campaign Message and Recipient
        try {
          const campMsg = await prisma.whatsAppCampaignMessage.findFirst({
            where: { wamid },
            include: { campaign: true, recipient: true },
          });

          if (campMsg) {
            const dataMsg: Record<string, any> = { rawPayload: st };
            const dataRecip: Record<string, any> = {};

            if (statusStr === 'DELIVERED') {
              dataMsg.status = 'DELIVERED';
              dataMsg.deliveredAt = occurredAt;
              dataRecip.status = 'DELIVERED';
              dataRecip.deliveredAt = occurredAt;
            } else if (statusStr === 'READ') {
              dataMsg.status = 'READ';
              dataMsg.readAt = occurredAt;
              if (!campMsg.deliveredAt) dataMsg.deliveredAt = occurredAt;
              dataRecip.status = 'READ';
              dataRecip.readAt = occurredAt;
              if (!campMsg.recipient?.deliveredAt) dataRecip.deliveredAt = occurredAt;
            } else if (statusStr === 'FAILED') {
              dataMsg.status = 'FAILED';
              dataMsg.failedAt = occurredAt;
              dataMsg.errorMessage = errorMessage || 'Meta delivery failed';
              dataRecip.status = 'FAILED';
              dataRecip.failedAt = occurredAt;
              dataRecip.errorMessage = errorMessage || 'Meta delivery failed';
            } else if (statusStr === 'SENT') {
              dataMsg.status = 'SENT';
              if (!campMsg.sentAt) dataMsg.sentAt = occurredAt;
              dataRecip.status = 'SENT';
              if (!campMsg.recipient?.sentAt) dataRecip.sentAt = occurredAt;
            }

            await prisma.$transaction([
              prisma.whatsAppCampaignMessage.update({
                where: { id: campMsg.id },
                data: dataMsg,
              }),
              prisma.whatsAppCampaignRecipient.update({
                where: { id: campMsg.recipientId },
                data: dataRecip,
              }),
            ]);

            // Re-aggregate campaign recipient statuses for 100% exact live numbers
            const groupCounts = await prisma.whatsAppCampaignRecipient.groupBy({
              by: ['status'],
              where: { campaignId: campMsg.campaignId },
              _count: { _all: true },
            });

            const statusMap: Record<string, number> = {};
            for (const item of groupCounts) {
              statusMap[item.status] = item._count._all;
            }

            const deliveredTotal = (statusMap['DELIVERED'] || 0) + (statusMap['READ'] || 0); // Read implies delivered
            const readTotal = statusMap['READ'] || 0;
            const failedTotal = statusMap['FAILED'] || 0;
            const queuedTotal = statusMap['QUEUED'] || 0;
            const sentInFlight = statusMap['SENT'] || 0;
            const sentTotal = sentInFlight + deliveredTotal + failedTotal;

            let campaignStatus = campMsg.campaign.status;
            if (queuedTotal === 0 && sentInFlight === 0) {
              if (deliveredTotal === 0 && failedTotal > 0) {
                campaignStatus = 'FAILED';
              } else {
                campaignStatus = 'COMPLETED';
              }
            } else if (campaignStatus === 'SENDING' && queuedTotal === 0) {
              campaignStatus = 'RUNNING';
            }

            await prisma.whatsAppCampaign.update({
              where: { id: campMsg.campaignId },
              data: {
                status: campaignStatus,
                sentCount: sentTotal,
                deliveredCount: deliveredTotal,
                readCount: readTotal,
                failedCount: failedTotal,
                ...(campaignStatus === 'COMPLETED' || campaignStatus === 'FAILED' ? { completedAt: new Date() } : {}),
              },
            });

            await persistApiRealtimeEvent({
              tenantId,
              eventType: 'marketing.campaign_status_updated',
              payload: {
                campaignId: campMsg.campaignId,
                wamid,
                status: statusStr,
                recipientPhone: campMsg.recipient?.e164Phone,
                errorMessage,
                counts: {
                  sent: sentTotal,
                  delivered: deliveredTotal,
                  read: readTotal,
                  failed: failedTotal,
                },
              },
            }).catch(() => undefined);
          }
        } catch (campErr) {
          logger.warn('Failed to reconcile campaign status from Meta webhook', { error: String(campErr), wamid });
        }
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
