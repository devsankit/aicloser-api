import { z } from 'zod';

export const SALES_LEAD_STAGES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'QUOTE_SENT',
  'PAYMENT_PENDING',
  'PAID',
  'HANDOFF',
  'CLOSED',
  'LOST',
  'CONVERTED_FREE',
  'ASSIGNED',
  'INTERESTED',
  'WEBINAR_INVITED',
  'WEBINAR_ATTENDED',
  'FOLLOW_UP',
  'NEGOTIATION',
  'CLOSED_WON',
  'CLOSED_LOST',
  'NOT_REACHABLE',
  'RECYCLED',
] as const;

export type SalesLeadStage = (typeof SALES_LEAD_STAGES)[number];

export const salesLeadStageSchema = z.enum(SALES_LEAD_STAGES);
