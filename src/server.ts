import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { env } from './config/env.js';
import { v1Router } from './routes/v1/index.js';
import { healthRouter } from './routes/health.js';
import { mobileCompatRouter } from './routes/mobile-compat.js';
import { logger } from './lib/logger.js';

export function createServer() {
  const app = express();

  // 1. Security Headers
  app.use(helmet());

  // 2. Exact CORS Allowlist (Safe for credentials: true)
  const defaultAllowedOrigins = [
    'https://app.aicloser.in',
    'https://aicloser.in',
    'https://app.aicloser.com',
    'https://aicloser.com',
    'http://localhost:3000',
    'http://localhost:3010',
    'http://localhost:3020',
    'http://localhost:3050',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3010',
    'http://127.0.0.1:3020',
    'http://127.0.0.1:3050',
    'http://127.0.0.1:5173',
  ];

  const envOrigins = env.CORS_ORIGIN === '*' ? [] : env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  const allowedOrigins = Array.from(new Set([...defaultAllowedOrigins, ...envOrigins]));

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          logger.warn(`Blocked CORS request from origin: ${origin}`);
          callback(new Error(`Origin ${origin} not allowed by CORS`));
        }
      },
      credentials: true,
    }),
  );

  // 3. Global Rate Limiter (1000 requests per 15 minutes; internal loopback bypass)
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1000,
    skip: (req) => {
      const ip = req.ip || req.socket.remoteAddress || '';
      return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, data: null, error: 'TooManyRequests', message: 'Rate limit exceeded. Please try again later.' },
  });
  app.use(limiter);

  // 4. Body Parsers with Raw Body preservation for Webhook signatures
  app.use(
    express.json({
      limit: '10mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());

  // 5. Request Correlation ID & Access Logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.requestId = crypto.randomUUID();
    next();
  });

  // 6. Routes
  app.use('/health', healthRouter);
  app.use('/sales/mobile', mobileCompatRouter);
  app.use('/api/sales/mobile', mobileCompatRouter);
  app.use('/api/v1', v1Router);

  // 7. 404 Catch-All
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      data: null,
      error: 'NotFound',
      message: `Cannot ${req.method} ${req.path}`,
    });
  });

  // 8. Global Error Handler
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled Server Error', {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
      requestId: req.requestId,
    });

    res.status(500).json({
      success: false,
      data: null,
      error: 'InternalServerError',
      message: env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    });
  });

  return app;
}

