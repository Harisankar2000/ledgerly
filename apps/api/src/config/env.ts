import { config } from 'dotenv';
import { z } from 'zod';

// Works from the repo root and from apps/api (npm workspaces run scripts there).
config({ path: ['.env', '../../.env'], quiet: true });

const csvList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.url(),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  REDIS_URL: z.url(),
  KAFKA_BROKERS: csvList.refine((list) => list.length > 0, 'At least one broker is required'),
  KAFKA_TOPIC: z.string().min(1).default('ledger.events'),
  KAFKA_CLIENT_ID: z.string().min(1).default('ledgerly'),

  API_KEYS: csvList,
  CORS_ORIGINS: csvList,
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  HOLD_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  WEBHOOK_RETRY_INTERVAL_MS: z.coerce.number().int().min(100).default(2_000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
