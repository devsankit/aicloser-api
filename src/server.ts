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

  // 2. CORS Allowlist
  const allowedOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim());
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`Origin ${origin} not allowed by CORS`));
        }
      },
      credentials: true,
    }),
  );

  // 3. Global Rate Limiter (300 requests per 15 minutes)
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, error: 'TooManyRequests', message: 'Rate limit exceeded. Please try again later.' },
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
      error: 'InternalServerError',
      message: env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    });
  });

  return app;
}
