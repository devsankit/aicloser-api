import { Router, Request, Response } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';

export const stagesRouter = Router();

stagesRouter.use(authenticate, enforceTenantIsolation);

export const DEFAULT_PIPELINE_STAGES = [
  { id: 'NEW', key: 'NEW', label: 'New Lead', color: '#3B82F6', probability: 0.1, position: 1 },
  { id: 'CONTACTED', key: 'CONTACTED', label: 'Contacted', color: '#8B5CF6', probability: 0.2, position: 2 },
  { id: 'IN_PROGRESS', key: 'IN_PROGRESS', label: 'In Progress', color: '#EC4899', probability: 0.35, position: 3 },
  { id: 'DEMO_SCHEDULED', key: 'DEMO_SCHEDULED', label: 'Demo Booked', color: '#EAB308', probability: 0.5, position: 4 },
  { id: 'FOLLOW_UP', key: 'FOLLOW_UP', label: 'Follow Up', color: '#F97316', probability: 0.6, position: 5 },
  { id: 'NEGOTIATION', key: 'NEGOTIATION', label: 'Negotiation', color: '#6366F1', probability: 0.8, position: 6 },
  { id: 'CLOSED_WON', key: 'CLOSED_WON', label: 'Closed Won', color: '#10B981', probability: 1.0, position: 7 },
  { id: 'CLOSED_LOST', key: 'CLOSED_LOST', label: 'Closed Lost', color: '#EF4444', probability: 0.0, position: 8 },
];

stagesRouter.get('/', async (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: DEFAULT_PIPELINE_STAGES,
  });
});
