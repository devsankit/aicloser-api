import { Router, Request, Response } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { authenticate } from '../../middlewares/auth.js';
import { enforceTenantIsolation } from '../../middlewares/tenant-isolation.js';
import { validateBody } from '../../middlewares/validate.js';
import { readRecordingBytes } from '../../lib/recording-storage.js';

export const googleDriveRouter = Router();

googleDriveRouter.use(authenticate, enforceTenantIsolation);

// Local storage directory for tenant Google Drive integration metadata
function getTenantConfigPath(tenantId: string): string {
  const dir = path.resolve(process.cwd(), 'data', 'tenants', tenantId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'google-drive-config.json');
}

export interface GoogleDriveConfig {
  isConnected: boolean;
  connectedEmail?: string;
  refreshToken?: string;
  accessToken?: string;
  tokenExpiresAt?: number;
  rootFolderId?: string;
  rootFolderName?: string;
  recordingsFolderId?: string;
  recordingsFolderName?: string;
  backupRecordings: boolean;
  backupMedia: boolean;
  connectedAt?: string;
  lastSyncAt?: string;
  lastSyncError?: string;
  isMockDemo?: boolean;
}

export function getTenantDriveConfig(tenantId: string): GoogleDriveConfig {
  const filePath = getTenantConfigPath(tenantId);
  if (!fs.existsSync(filePath)) {
    return {
      isConnected: false,
      backupRecordings: true,
      backupMedia: true,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return {
      isConnected: false,
      backupRecordings: true,
      backupMedia: true,
    };
  }
}

export function saveTenantDriveConfig(tenantId: string, config: GoogleDriveConfig): void {
  const filePath = getTenantConfigPath(tenantId);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

const ROOT_FOLDER_NAME = 'AI Closer CRM Vault';
const RECORDINGS_FOLDER_NAME = 'Call Recordings';
const DEFAULT_GOOGLE_CLIENT_ID = '959854902294-76sfr419m2umot190n71b6toqcghclgf.apps.googleusercontent.com';
const DEFAULT_GOOGLE_DRIVE_REDIRECT_URI = 'https://app.aicloser.in/settings/storage/callback';

function googleDriveRedirectUri(req: Request) {
  const configured = process.env.GOOGLE_DRIVE_REDIRECT_URI?.trim();
  if (configured) return configured;

  // Local UI testing can use the browser origin, while production must use
  // the callback registered on the Google OAuth client. Never derive a
  // production callback from an arbitrary Origin header.
  if (process.env.NODE_ENV !== 'production' && req.headers.origin) {
    return `${req.headers.origin.replace(/\/$/, '')}/settings/storage/callback`;
  }
  return DEFAULT_GOOGLE_DRIVE_REDIRECT_URI;
}

function isMockConfig(config: GoogleDriveConfig) {
  return config.isMockDemo === true || config.accessToken === 'mock-access-token-active';
}

async function getValidAccessToken(tenantId: string, config: GoogleDriveConfig): Promise<string> {
  if (!config.accessToken) throw new Error('Google Drive access token is missing');
  if (isMockConfig(config)) return config.accessToken;

  const expiresSoon = (config.tokenExpiresAt || 0) <= Date.now() + 60_000;
  if (!expiresSoon || !config.refreshToken) return config.accessToken;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Google Drive OAuth credentials are not configured');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const tokenData = (await tokenRes.json()) as Record<string, any>;
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(String(tokenData.error_description || tokenData.error || 'Google Drive token refresh failed'));
  }

  config.accessToken = String(tokenData.access_token);
  config.tokenExpiresAt = Date.now() + (Number(tokenData.expires_in) || 3600) * 1000;
  saveTenantDriveConfig(tenantId, config);
  return config.accessToken;
}

async function driveJsonRequest<T>(accessToken: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    throw new Error(String(payload.error?.message || payload.error_description || payload.message || `Google Drive request failed with status ${response.status}`));
  }
  return payload as T;
}

async function findOrCreateFolder(accessToken: string, name: string, parentId?: string) {
  const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const parentClause = parentId ? `'${parentId}' in parents and ` : "'root' in parents and ";
  const query = `${parentClause}name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const list = await driveJsonRequest<{ files?: Array<{ id?: string; name?: string }> }>(
    accessToken,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&pageSize=1&fields=files(id,name)`
  );
  const existing = list.files?.[0];
  if (existing?.id) return { id: String(existing.id), name: String(existing.name || name) };

  const created = await driveJsonRequest<{ id?: string; name?: string }>(
    accessToken,
    'https://www.googleapis.com/drive/v3/files',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parentId ? { parents: [parentId] } : {}),
        description: 'AI Closer CRM storage folder',
      }),
    }
  );
  if (!created.id) throw new Error(`Google Drive did not return an id for folder ${name}`);
  return { id: String(created.id), name: String(created.name || name) };
}

async function ensureDriveFolders(tenantId: string, config: GoogleDriveConfig, accessToken: string) {
  const root = await findOrCreateFolder(accessToken, config.rootFolderName || ROOT_FOLDER_NAME);
  config.rootFolderId = root.id;
  config.rootFolderName = root.name;
  const recordings = await findOrCreateFolder(accessToken, config.recordingsFolderName || RECORDINGS_FOLDER_NAME, root.id);
  config.recordingsFolderId = recordings.id;
  config.recordingsFolderName = recordings.name;
  saveTenantDriveConfig(tenantId, config);
  return { root, recordings };
}

async function uploadDriveFile(input: { accessToken: string; folderId: string; fileName: string; mimeType: string; bytes: Buffer }) {
  const boundary = `aicloser-${Date.now().toString(36)}`;
  const metadata = Buffer.from(JSON.stringify({
    name: input.fileName,
    parents: [input.folderId],
    mimeType: input.mimeType,
  }));
  const preamble = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`);
  const fileHeader = Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`);
  const closing = Buffer.from(`\r\n--${boundary}--`);
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: Buffer.concat([preamble, metadata, fileHeader, input.bytes, closing]),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok || !payload.id) {
    throw new Error(String(payload.error?.message || payload.message || `Google Drive upload failed with status ${response.status}`));
  }
  return { id: String(payload.id), name: String(payload.name || input.fileName), webViewLink: payload.webViewLink ? String(payload.webViewLink) : undefined };
}

export async function backupRecordingToGoogleDrive(input: {
  tenantId: string;
  objectKey: string;
  callId: string;
  mimeType?: string | null;
  fileName?: string;
}) {
  const config = getTenantDriveConfig(input.tenantId);
  if (!config.isConnected || !config.backupRecordings) return { status: 'SKIPPED' as const };
  if (isMockConfig(config)) {
    config.lastSyncAt = new Date().toISOString();
    config.lastSyncError = undefined;
    saveTenantDriveConfig(input.tenantId, config);
    return { status: 'MOCKED' as const, targetFolder: config.recordingsFolderName || RECORDINGS_FOLDER_NAME };
  }

  try {
    const accessToken = await getValidAccessToken(input.tenantId, config);
    const folders = await ensureDriveFolders(input.tenantId, config, accessToken);
    const recording = await readRecordingBytes({ objectKey: input.objectKey, contentType: input.mimeType });
    const extension = (input.mimeType || 'audio/mp4').split('/')[1]?.split(';')[0] || 'bin';
    const fileName = input.fileName || `call-${input.callId}.${extension}`;
    const uploaded = await uploadDriveFile({
      accessToken,
      folderId: folders.recordings.id,
      fileName,
      mimeType: recording.contentType,
      bytes: recording.bytes,
    });
    config.lastSyncAt = new Date().toISOString();
    config.lastSyncError = undefined;
    saveTenantDriveConfig(input.tenantId, config);
    return { status: 'UPLOADED' as const, ...uploaded, targetFolder: folders.recordings.name };
  } catch (error) {
    config.lastSyncError = error instanceof Error ? error.message : 'Google Drive recording backup failed';
    saveTenantDriveConfig(input.tenantId, config);
    return { status: 'FAILED' as const, error: config.lastSyncError };
  }
}

// 1. GET /auth-url - Generate Google OAuth consent URL with drive.file scope
const handleAuthUrl = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() || DEFAULT_GOOGLE_CLIENT_ID;
  const redirectUri = googleDriveRedirectUri(req);

  const statePayload = Buffer.from(
    JSON.stringify({
      tenantId,
      userId: req.user?.userId,
      timestamp: Date.now(),
    })
  ).toString('base64url');

  const scope = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/drive.file', // Strict scoped access only to CRM created files
  ].join(' ');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline', // Required for background upload refresh_token
    prompt: 'consent',       // Guarantees refresh_token is returned
    state: statePayload,
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  res.json({
    success: true,
    data: {
      authUrl,
      scope: 'https://www.googleapis.com/auth/drive.file',
      accessType: 'offline',
    },
    error: null,
  });
};

googleDriveRouter.get('/auth-url', handleAuthUrl);
googleDriveRouter.get('/auth/url', handleAuthUrl);
googleDriveRouter.get('/oauth/start', handleAuthUrl);
googleDriveRouter.get('/oauth-url', handleAuthUrl);

const callbackSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  redirectUri: z.string().optional(),
});

// 2. POST /callback - Exchange code, create root folder, store refresh_token
googleDriveRouter.post('/callback', validateBody(callbackSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const { code, redirectUri } = req.body as z.infer<typeof callbackSchema>;

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() || DEFAULT_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const allowMock = process.env.GOOGLE_DRIVE_ALLOW_MOCK === 'true';
  const configuredRedirectUri = googleDriveRedirectUri(req);
  // The authorization code is bound to the redirect URI used by /auth-url.
  // Ignore a stale/mismatched browser value so it cannot break the exchange.
  const resolvedRedirectUri = redirectUri?.trim() === configuredRedirectUri ? redirectUri.trim() : configuredRedirectUri;

  if (!clientSecret && !allowMock) {
    res.status(503).json({
      success: false,
      data: null,
      error: 'GoogleOAuthNotConfigured',
      message: 'Google Drive OAuth is not configured on the server. Set GOOGLE_CLIENT_SECRET in protected deployment settings.',
    });
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret || 'mock-secret',
        redirect_uri: resolvedRedirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = (await tokenRes.json()) as Record<string, any>;

    if (!tokenRes.ok || !tokenData.access_token) {
      // Mock mode must be explicitly enabled; missing production credentials
      // must never look like a successful Google Drive connection.
      if (process.env.GOOGLE_DRIVE_ALLOW_MOCK === 'true') {
        const mockConfig: GoogleDriveConfig = {
          isConnected: true,
          connectedEmail: req.user?.email || 'admin@aicloser.in',
          refreshToken: 'mock-refresh-token-active',
          accessToken: 'mock-access-token-active',
          tokenExpiresAt: Date.now() + 3600 * 1000,
          rootFolderId: 'mock-folder-aicloser-vault',
          rootFolderName: ROOT_FOLDER_NAME,
          recordingsFolderId: 'mock-folder-call-recordings',
          recordingsFolderName: RECORDINGS_FOLDER_NAME,
          backupRecordings: true,
          backupMedia: true,
          connectedAt: new Date().toISOString(),
          isMockDemo: true,
        };
        saveTenantDriveConfig(tenantId, mockConfig);

        res.json({
          success: true,
          data: {
            isConnected: true,
            connectedEmail: mockConfig.connectedEmail,
            rootFolderName: mockConfig.rootFolderName,
            recordingsFolderName: mockConfig.recordingsFolderName,
            backupRecordings: true,
            backupMedia: true,
            isMockDemo: true,
          },
          error: null,
        });
        return;
      }

      res.status(400).json({
        success: false,
        data: null,
        error: 'GoogleOAuthError',
        message: String(tokenData.error_description || tokenData.error || 'Failed to exchange authorization code with Google'),
      });
      return;
    }

    // Fetch user profile from Google to store connected account email
    let connectedEmail = req.user?.email || 'connected-account';
    try {
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (userRes.ok) {
        const userInfo = (await userRes.json()) as Record<string, any>;
        if (userInfo.email) connectedEmail = String(userInfo.email);
      }
    } catch (e) {
      // fallback to user email
    }

    // Create or find the root vault and its call-recordings subfolder.
    const folderName = ROOT_FOLDER_NAME;

    const config: GoogleDriveConfig = {
      isConnected: true,
      connectedEmail,
      refreshToken: tokenData.refresh_token ? String(tokenData.refresh_token) : undefined,
      accessToken: String(tokenData.access_token),
      tokenExpiresAt: Date.now() + (Number(tokenData.expires_in) || 3600) * 1000,
      rootFolderName: folderName,
      recordingsFolderName: RECORDINGS_FOLDER_NAME,
      backupRecordings: true,
      backupMedia: true,
      connectedAt: new Date().toISOString(),
    };

    try {
      const folders = await ensureDriveFolders(tenantId, config, String(tokenData.access_token));
      config.rootFolderId = folders.root.id;
      config.rootFolderName = folders.root.name;
      config.recordingsFolderId = folders.recordings.id;
      config.recordingsFolderName = folders.recordings.name;
    } catch (folderError) {
      console.warn('Google Drive folder setup warning:', folderError);
    }
    saveTenantDriveConfig(tenantId, config);

    res.json({
      success: true,
      data: {
        isConnected: true,
        connectedEmail,
        rootFolderName: folderName,
        rootFolderId: config.rootFolderId,
        recordingsFolderId: config.recordingsFolderId,
        recordingsFolderName: config.recordingsFolderName,
        backupRecordings: true,
        backupMedia: true,
        connectedAt: config.connectedAt,
      },
      error: null,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      data: null,
      error: 'ServerError',
      message: error?.message || 'Error completing Google Drive OAuth setup',
    });
  }
});

// 3. GET /status - Current Google Drive connection status
googleDriveRouter.get('/status', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const config = getTenantDriveConfig(tenantId);

  res.json({
    success: true,
    data: {
      isConnected: Boolean(config.isConnected),
      connectedEmail: config.connectedEmail,
      rootFolderName: config.rootFolderName || '📁 AI Closer CRM Vault',
      rootFolderId: config.rootFolderId,
      backupRecordings: config.backupRecordings ?? true,
      backupMedia: config.backupMedia ?? true,
      connectedAt: config.connectedAt,
      recordingsFolderId: config.recordingsFolderId,
      recordingsFolderName: config.recordingsFolderName || RECORDINGS_FOLDER_NAME,
      lastSyncAt: config.lastSyncAt,
      lastSyncError: config.lastSyncError,
      isMockDemo: isMockConfig(config),
    },
    error: null,
  });
});

const settingsSchema = z.object({
  backupRecordings: z.boolean().optional(),
  backupMedia: z.boolean().optional(),
});

googleDriveRouter.patch('/settings', validateBody(settingsSchema), async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const config = getTenantDriveConfig(tenantId);
  const settings = req.body as z.infer<typeof settingsSchema>;
  const next: GoogleDriveConfig = {
    ...config,
    backupRecordings: settings.backupRecordings ?? config.backupRecordings,
    backupMedia: settings.backupMedia ?? config.backupMedia,
  };
  saveTenantDriveConfig(tenantId, next);
  res.json({
    success: true,
    data: {
      isConnected: Boolean(next.isConnected),
      connectedEmail: next.connectedEmail,
      rootFolderName: next.rootFolderName || ROOT_FOLDER_NAME,
      rootFolderId: next.rootFolderId,
      recordingsFolderId: next.recordingsFolderId,
      recordingsFolderName: next.recordingsFolderName || RECORDINGS_FOLDER_NAME,
      backupRecordings: next.backupRecordings,
      backupMedia: next.backupMedia,
      connectedAt: next.connectedAt,
      lastSyncAt: next.lastSyncAt,
      lastSyncError: next.lastSyncError,
      isMockDemo: isMockConfig(next),
    },
    error: null,
  });
});

// 4. POST /disconnect - Disconnect Google Drive
googleDriveRouter.post('/disconnect', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const config: GoogleDriveConfig = {
    isConnected: false,
    backupRecordings: false,
    backupMedia: false,
  };
  saveTenantDriveConfig(tenantId, config);

  res.json({
    success: true,
    data: { isConnected: false },
    message: 'Google Drive disconnected successfully',
    error: null,
  });
});

// 5. POST /sync-test - Test uploading a small verification file to client's Drive
const handleTestSync = async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const config = getTenantDriveConfig(tenantId);

  if (!config.isConnected) {
    res.status(400).json({
      success: false,
      data: null,
      error: 'NotConnected',
      message: 'Google Drive is not connected for this workspace',
    });
    return;
  }

  if (isMockConfig(config)) {
    res.json({
      success: true,
      data: { status: 'MOCKED', fileName: 'ai-closer-verification.txt', targetFolder: config.recordingsFolderName || RECORDINGS_FOLDER_NAME, timestamp: new Date().toISOString() },
      message: 'Google Drive is connected in demo mode; no external file was written.',
      error: null,
    });
    return;
  }

  try {
    const accessToken = await getValidAccessToken(tenantId, config);
    const folders = await ensureDriveFolders(tenantId, config, accessToken);
    const uploaded = await uploadDriveFile({
      accessToken,
      folderId: folders.recordings.id,
      fileName: `ai-closer-verification-${Date.now()}.txt`,
      mimeType: 'text/plain',
      bytes: Buffer.from('AI Closer Google Drive connection verified.\n', 'utf8'),
    });
    config.lastSyncAt = new Date().toISOString();
    config.lastSyncError = undefined;
    saveTenantDriveConfig(tenantId, config);
    res.json({
      success: true,
      data: { status: 'VERIFIED', ...uploaded, targetFolder: folders.recordings.name, timestamp: config.lastSyncAt },
      message: 'Google Drive vault write verification passed successfully',
      error: null,
    });
  } catch (error) {
    config.lastSyncError = error instanceof Error ? error.message : 'Google Drive verification failed';
    saveTenantDriveConfig(tenantId, config);
    res.status(502).json({ success: false, data: null, error: 'GoogleDriveWriteFailed', message: config.lastSyncError });
  }
};

googleDriveRouter.post('/sync-test', handleTestSync);
googleDriveRouter.post('/test-sync', handleTestSync);