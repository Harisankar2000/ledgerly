import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createContainer, type Container } from '../../src/container.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApp } from '../../src/http/app.js';
import { createLogger } from '../../src/lib/logger.js';

export const API_KEY = 'integration-test-key';
export const auth = { 'x-api-key': API_KEY };

export interface TestContext {
  env: Env;
  container: Container;
  app: FastifyInstance;
  close(): Promise<void>;
}

/** Tests use their own database so they never wipe local development data. */
async function ensureTestDatabase(baseUrl: string): Promise<string> {
  const url = new URL(baseUrl);
  const testDb = `${url.pathname.slice(1)}_test`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      testDb,
    ]);
    if (rowCount === 0) await admin.query(`CREATE DATABASE "${testDb}"`);
  } finally {
    await admin.end();
  }
  url.pathname = `/${testDb}`;
  return url.toString();
}

export async function createTestContext(): Promise<TestContext> {
  const base = loadEnv();
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    API_KEYS: API_KEY,
    DATABASE_URL: await ensureTestDatabase(base.DATABASE_URL),
    RATE_LIMIT_MAX: '100000',
  });
  const logger = createLogger({ name: 'test', level: 'silent', pretty: false });
  const container = createContainer(env, logger);
  await runMigrations(container.pool);
  const app = await buildApp(container, { sharedRateLimit: false });

  return {
    env,
    container,
    app,
    async close() {
      await app.close();
      await container.dispose();
    },
  };
}

/** TRUNCATE skips row triggers, so the append-only guard on entries does not block it. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(`
    TRUNCATE entries, holds, transactions, idempotency_keys, outbox_events,
             webhook_deliveries, webhook_endpoints, reconciliation_runs RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM accounts WHERE kind = 'WALLET'`);
  await pool.query(`UPDATE accounts SET balance = 0`);
}

/** Small typed client over fastify.inject so tests read like API usage. */
export function apiClient(app: FastifyInstance) {
  const call = async <T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    idempotencyKey: string | null = randomUUID(),
  ) => {
    const response = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...auth,
        ...(method === 'POST' && idempotencyKey && { 'idempotency-key': idempotencyKey }),
      },
      ...(payload !== undefined && { payload: payload as object }),
    });
    return { status: response.statusCode, body: response.json<T>(), headers: response.headers };
  };

  return {
    call,
    async createWallet(name: string, currency: 'INR' | 'USD' = 'INR'): Promise<string> {
      const { status, body } = await call<{ id: string }>('POST', '/accounts', { name, currency });
      if (status !== 201) throw new Error(`createWallet failed: ${status}`);
      return body.id;
    },
    async deposit(accountId: string, amount: number) {
      const result = await call<{ id: string }>('POST', '/deposits', { accountId, amount });
      if (result.status !== 201) throw new Error(`deposit failed: ${JSON.stringify(result.body)}`);
      return result.body;
    },
    async balance(accountId: string): Promise<number> {
      return (await call<{ balance: number }>('GET', `/accounts/${accountId}`)).body.balance;
    },
    transfer: (
      sourceAccountId: string,
      destinationAccountId: string,
      amount: number,
      key?: string,
    ) =>
      call<{ id: string; error?: { code: string } }>(
        'POST',
        '/transfers',
        { sourceAccountId, destinationAccountId, amount },
        key ?? randomUUID(),
      ),
    async reconcile() {
      return (
        await call<{
          status: string;
          report: { checks: Array<{ name: string; passed: boolean }> };
        }>('POST', '/reconciliation/runs')
      ).body;
    },
  };
}

export type ApiClient = ReturnType<typeof apiClient>;
