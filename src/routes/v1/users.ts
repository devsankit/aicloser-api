import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';

export const usersRouter = Router();
usersRouter.use(authenticate);

const themeSchema = z.object({
  themePreference: z.string().min(1).transform((v) => (v.toLowerCase() === 'dark' ? 'dark' : 'light')),
});

const profileSchema = z.object({
  displayName: z.string().min(2).optional(),
  phone: z.string().min(8).optional(),
  themePreference: z
    .string()
    .optional()
    .transform((v) => (v ? (v.toLowerCase() === 'dark' ? 'dark' : 'light') : undefined)),
});

usersRouter.get('/theme', async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  const user = await prisma.appAuthUser.findUnique({
    where: { id: userId },
    select: { themePreference: true },
  });
  res.json({
    success: true,
    data: { themePreference: user?.themePreference || 'light' },
  });
});

usersRouter.patch('/theme', validateBody(themeSchema), async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  const { themePreference } = req.body;
  const updated = await prisma.appAuthUser.update({
    where: { id: userId },
    data: { themePreference },
    select: { id: true, themePreference: true, displayName: true, email: true },
  });
  res.json({
    success: true,
    data: updated,
    message: 'Theme preference saved successfully',
  });
});

usersRouter.patch('/profile', validateBody(profileSchema), async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  const data: any = {};
  if (req.body.displayName) data.displayName = req.body.displayName;
  if (req.body.phone) data.phone = req.body.phone;
  if (req.body.themePreference) data.themePreference = req.body.themePreference;

  const updated = await prisma.appAuthUser.update({
    where: { id: userId },
    data,
    select: { id: true, displayName: true, email: true, phone: true, role: true, themePreference: true },
  });
  res.json({
    success: true,
    data: updated,
    message: 'Profile updated successfully',
  });
});

usersRouter.get('/profile', async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  const user = await prisma.appAuthUser.findUnique({
    where: { id: userId },
    select: { id: true, displayName: true, email: true, phone: true, role: true, themePreference: true, tenantId: true },
  });
  res.json({
    success: true,
    data: user,
  });
});
