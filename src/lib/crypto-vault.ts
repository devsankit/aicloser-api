import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const MASTER_KEY = scryptSync(env.JWT_SECRET || 'aicloser-vault-secret-key-2026', 'aicloser-salt-2026', 32);

/**
 * Encrypt a secret string using AES-256-GCM.
 * Output format: iv:authTag:encryptedHex
 */
export function encryptSecret(plainText: string): string {
  if (!plainText) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, MASTER_KEY, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a secret string encrypted with encryptSecret.
 */
export function decryptSecret(cipherText: string): string {
  if (!cipherText || !cipherText.includes(':')) return cipherText;
  try {
    const parts = cipherText.split(':');
    if (parts.length !== 3) return cipherText;
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, MASTER_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // If decryption fails, return as-is or empty
    return cipherText;
  }
}

/**
 * Mask an API key for safe display in UI/API responses.
 * e.g. "gsk_1234567890abcdef" -> "gsk_...cdef"
 */
export function maskApiKey(key?: string | null): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••••••';
  const prefix = trimmed.slice(0, 4);
  const suffix = trimmed.slice(-4);
  return `${prefix}••••${suffix}`;
}
