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

export const v1Router = Router();

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
