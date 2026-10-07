import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3060').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  CORS_ORIGIN: z.string().default('*'),
  WEBHOOK_APP_SECRET: z.string().default('aicloser_default_webhook_secret'),
  SUPER_ADMIN_AUDIT_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  RECORDING_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  RECORDING_STORAGE_PATH: z.string().default('./data/recordings'),
  RECORDING_STORAGE_BUCKET: z.string().optional(),
  RECORDING_STORAGE_REGION: z.string().default('auto'),
  RECORDING_STORAGE_ENDPOINT: z.string().optional(),
  RECORDING_STORAGE_ACCESS_KEY_ID: z.string().optional(),
  RECORDING_STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  RECORDING_SIGNED_URL_SECONDS: z.string().default('300').transform((v) => Math.max(30, Number(v))),
  REDIS_URL: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
