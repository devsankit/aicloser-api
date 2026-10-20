import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody } from '../../middlewares/validate.js';
import { logger } from '../../lib/logger.js';

export const developerRouter = Router();

developerRouter.use(authenticate, enforceTenantIsolation);

// ==========================================
// 1. Developer Bearer Token Generator & Retriever
// ==========================================

const handleGetDeveloperToken = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true, name: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  let tokenData = settings.developerToken;

  if (!tokenData || !tokenData.token) {
    const token = jwt.sign(
      {
        userId: user.userId,
        tenantId,
        role: user.role,
        displayName: user.displayName,
        email: user.email,
        tokenType: 'DEVELOPER_API_TOKEN',
      },
      env.JWT_SECRET,
      { expiresIn: '365d' }
    );

    tokenData = {
      token,
      prefix: token.slice(0, 14) + '...',
      scopes: ['leads:read', 'leads:write', 'campaigns:read', 'webhooks:write', 'forms:manage'],
      expiresIn: '365d',
      tenantId,
      createdBy: user.userId,
      createdAt: new Date().toISOString(),
    };

    await prisma.aicloserWorkspace.update({
      where: { id: tenantId },
      data: {
        settings: {
          ...settings,
          developerToken: tokenData,
        },
      },
    });
  }

  res.json({
    success: true,
    message: 'Developer API token active',
    data: tokenData,
    token: tokenData.token,
    error: null,
  });
};

const handleGenerateDeveloperToken = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;

  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};

  const token = jwt.sign(
    {
      userId: user.userId,
      tenantId,
      role: user.role,
      displayName: user.displayName,
      email: user.email,
      tokenType: 'DEVELOPER_API_TOKEN',
    },
    env.JWT_SECRET,
    { expiresIn: '365d' }
  );

  const tokenData = {
    token,
    prefix: token.slice(0, 14) + '...',
    scopes: ['leads:read', 'leads:write', 'campaigns:read', 'webhooks:write', 'forms:manage'],
    expiresIn: '365d',
    tenantId,
    createdBy: user.userId,
    createdAt: new Date().toISOString(),
  };

  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        developerToken: tokenData,
      },
    },
  });

  res.status(201).json({
    success: true,
    message: 'Fresh developer API token generated successfully',
    data: tokenData,
    token,
    error: null,
  });
};

developerRouter.get('/token', handleGetDeveloperToken);
developerRouter.get('/developer-token', handleGetDeveloperToken);
developerRouter.post('/token', handleGenerateDeveloperToken);
developerRouter.post('/developer-token', handleGenerateDeveloperToken);

// ==========================================
// 2. Sandbox API Tester Request Runner
// ==========================================

const testRequestSchema = z.object({
  endpoint: z.string().min(1, 'Endpoint is required'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  headers: z.record(z.string()).optional(),
  body: z.any().optional(),
});

developerRouter.post('/test-request', validateBody(testRequestSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const user = req.user!;
  const { endpoint: rawEndpoint, method, headers: clientHeaders, body: clientBody } = req.body;

  // Clean and normalize endpoint path
  let cleaned = rawEndpoint.trim();
  // Strip optional leading HTTP method e.g. "GET /api/v1/leads"
  cleaned = cleaned.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, '').trim();

  if (!cleaned.startsWith('/')) {
    cleaned = '/' + cleaned;
  }

  // Ensure prefix /api/v1
  let normalizedPath = cleaned;
  if (!normalizedPath.startsWith('/api/v1')) {
    if (normalizedPath.startsWith('/v1')) {
      normalizedPath = '/api' + normalizedPath;
    } else {
      normalizedPath = '/api/v1' + normalizedPath;
    }
  }

  // Generate ephemeral developer token to authenticate the runner
  const token = jwt.sign(
    {
      userId: user.userId,
      tenantId,
      role: user.role,
      displayName: user.displayName,
      email: user.email,
      tokenType: 'DEVELOPER_API_TOKEN',
    },
    env.JWT_SECRET,
    { expiresIn: '10m' }
  );

  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'x-tenant-id': tenantId,
    ...(clientHeaders || {}),
  };

  const targetUrl = `http://127.0.0.1:3060${normalizedPath}`;
  const start = Date.now();

  try {
    const fetchOptions: RequestInit = {
      method,
      headers: requestHeaders,
      signal: AbortSignal.timeout(10000),
    };

    if (method !== 'GET' && method !== 'HEAD' && clientBody !== undefined) {
      fetchOptions.body = typeof clientBody === 'string' ? clientBody : JSON.stringify(clientBody);
    }

    const upstreamRes = await fetch(targetUrl, fetchOptions);
    const latencyMs = Date.now() - start;

    const responseHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((val, key) => {
      responseHeaders[key] = val;
    });

    const textPayload = await upstreamRes.text();
    let jsonPayload: any = null;
    try {
      jsonPayload = JSON.parse(textPayload);
    } catch {
      jsonPayload = textPayload;
    }

    res.json({
      success: upstreamRes.status < 400,
      statusCode: upstreamRes.status,
      statusText: upstreamRes.statusText,
      latencyMs,
      endpoint: normalizedPath,
      method,
      requestHeaders: {
        'Content-Type': requestHeaders['Content-Type'],
        Authorization: `Bearer ${token.slice(0, 10)}...${token.slice(-6)}`,
        'x-tenant-id': tenantId,
      },
      responseHeaders: {
        'content-type': responseHeaders['content-type'] || 'application/json',
      },
      payload: jsonPayload,
      data: jsonPayload,
      error: upstreamRes.status >= 400 ? (jsonPayload?.error || jsonPayload?.message || `HTTP ${upstreamRes.status}`) : null,
    });
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    logger.warn('Developer sandbox test-request failed', { error: String(err) });
    res.status(502).json({
      success: false,
      statusCode: 502,
      statusText: 'Bad Gateway',
      latencyMs,
      endpoint: normalizedPath,
      method,
      error: 'RunnerExecutionError',
      message: `Failed to execute sandbox request: ${err.message || String(err)}`,
    });
  }
});
