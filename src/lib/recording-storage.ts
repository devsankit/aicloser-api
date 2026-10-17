import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

function localPath(objectKey: string) {
  const root = path.resolve(env.RECORDING_STORAGE_PATH);
  const resolved = path.resolve(root, objectKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Invalid recording object key');
  }
  return resolved;
}

function s3Client() {
  if (!env.RECORDING_STORAGE_BUCKET || !env.RECORDING_STORAGE_ACCESS_KEY_ID || !env.RECORDING_STORAGE_SECRET_ACCESS_KEY) {
    throw new Error('S3 recording storage is not fully configured');
  }
  return new S3Client({
    region: env.RECORDING_STORAGE_REGION,
    endpoint: env.RECORDING_STORAGE_ENDPOINT,
    forcePathStyle: Boolean(env.RECORDING_STORAGE_ENDPOINT),
    credentials: {
      accessKeyId: env.RECORDING_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.RECORDING_STORAGE_SECRET_ACCESS_KEY,
    },
  });
}

export function recordingStorageMode() {
  return env.RECORDING_STORAGE_DRIVER;
}

export async function createRecordingUploadUrl(input: { objectKey: string; contentType?: string | null }) {
  if (env.RECORDING_STORAGE_DRIVER === 's3') {
    const command = new PutObjectCommand({
      Bucket: env.RECORDING_STORAGE_BUCKET,
      Key: input.objectKey,
      ContentType: input.contentType ?? 'application/octet-stream',
    });
    return {
      url: await getSignedUrl(s3Client(), command, { expiresIn: env.RECORDING_SIGNED_URL_SECONDS }),
      method: 'PUT' as const,
      mode: 's3' as const,
    };
  }

  return { url: null, method: 'POST' as const, mode: 'local' as const };
}

export async function writeRecording(objectKey: string, bytes: Buffer, contentType?: string | null) {
  if (env.RECORDING_STORAGE_DRIVER === 's3') {
    await s3Client().send(new PutObjectCommand({
      Bucket: env.RECORDING_STORAGE_BUCKET,
      Key: objectKey,
      Body: bytes,
      ContentType: contentType ?? 'application/octet-stream',
    }));
    return;
  }

  const target = localPath(objectKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
    await writeFile(target, bytes);
  });
}

export async function recordingExists(objectKey: string) {
  if (env.RECORDING_STORAGE_DRIVER === 's3') {
    try {
      await s3Client().send(new HeadObjectCommand({ Bucket: env.RECORDING_STORAGE_BUCKET, Key: objectKey }));
      return true;
    } catch {
      return false;
    }
  }
  try {
    await stat(localPath(objectKey));
    return true;
  } catch {
    return false;
  }
}

export async function getRecordingPlayback(input: { objectKey: string; contentType?: string | null }) {
  if (env.RECORDING_STORAGE_DRIVER === 's3') {
    const command = new GetObjectCommand({ Bucket: env.RECORDING_STORAGE_BUCKET, Key: input.objectKey });
    return {
      mode: 's3' as const,
      url: await getSignedUrl(s3Client(), command, { expiresIn: env.RECORDING_SIGNED_URL_SECONDS }),
    };
  }

  return { mode: 'local' as const, bytes: await readFile(localPath(input.objectKey)), contentType: input.contentType ?? 'application/octet-stream' };
}

/**
 * Read a recording into memory for a downstream integration such as Google Drive.
 * This intentionally keeps the storage driver hidden from callers: local files
 * are read directly and S3 recordings are fetched through a short-lived signed URL.
 */
export async function readRecordingBytes(input: { objectKey: string; contentType?: string | null }) {
  const playback = await getRecordingPlayback(input);
  if (playback.mode === 'local') {
    return { bytes: playback.bytes, contentType: playback.contentType };
  }

  const response = await fetch(playback.url);
  if (!response.ok) {
    throw new Error(`Recording download failed with status ${response.status}`);
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: input.contentType ?? response.headers.get('content-type') ?? 'application/octet-stream',
  };
}
