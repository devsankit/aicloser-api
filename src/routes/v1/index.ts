import { Router } from 'express';
import { authRouter } from './auth.js';
import { leadsRouter } from './leads.js';
import { contactsRouter } from './contacts.js';
import { callsRouter } from './calls.js';
import { conversationsRouter } from './conversations.js';
import { superAdminRouter } from './super-admin.js';
import { webhooksRouter } from './webhooks.js';
import { recordingsRouter } from './recordings.js';
import { realtimeRouter } from './realtime.js';
import { mobileRouter } from './mobile.js';
import { adminUsersRouter, meSessionsRouter } from './client-sessions.js';
import { customFieldsRouter } from './custom-fields.js';
import { paymentsRouter } from './payments.js';
import { reportsRouter } from './reports.js';
import { teamRouter } from './team.js';
import { stagesRouter } from './stages.js';
import { tasksRouter } from './tasks.js';
import { googleDriveRouter } from './google-drive.js';
import { workspaceRouter } from './workspace.js';
import { integrationsRouter } from './integrations.js';
import { marketingRouter } from './marketing.js';
import { aiRouter } from './ai.js';
import { formsRouter } from './forms.js';
import { automationsRouter } from './automations.js';
import { payoutsRouter } from './payouts.js';
import { referralsRouter } from './referrals.js';

export const v1Router = Router();

// Core Canonical V1 API Domains
v1Router.use('/auth', authRouter);
v1Router.use('/leads', leadsRouter);
v1Router.use('/contacts', contactsRouter);
v1Router.use('/calls', callsRouter);
v1Router.use('/conversations', conversationsRouter);
v1Router.use('/super-admin', superAdminRouter);
v1Router.use('/webhooks', webhooksRouter);
v1Router.use('/recordings', recordingsRouter);
v1Router.use('/realtime', realtimeRouter);
v1Router.use('/mobile', mobileRouter);
v1Router.use('/me', meSessionsRouter);
v1Router.use('/admin/users', adminUsersRouter);
v1Router.use('/custom-fields', customFieldsRouter);
v1Router.use('/payments', paymentsRouter);
v1Router.use('/reports', reportsRouter);
v1Router.use('/team', teamRouter);
v1Router.use('/stages', stagesRouter);
v1Router.use('/tasks', tasksRouter);

// Phase 3 Extensions: Forms, Automations, Payouts & Referrals
v1Router.use('/forms', formsRouter);
v1Router.use('/automations', automationsRouter);
v1Router.use('/payouts', payoutsRouter);
v1Router.use('/referrals', referralsRouter);

// Workspace Plan & Entitlements
v1Router.use('/workspace', workspaceRouter);

// Integrations (WhatsApp, Instagram, Google Drive)
v1Router.use('/integrations', integrationsRouter);
v1Router.use('/integrations/google-drive', googleDriveRouter);

// Marketing, Campaigns & Templates
v1Router.use('/marketing', marketingRouter);

// Dedicated AI Engine (Consultative Reply, Lead Scoring, Transcribe, Objection Handling, Copilot)
v1Router.use('/ai', aiRouter);
