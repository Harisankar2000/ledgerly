import pg from 'pg';
import type { Logger } from '../lib/logger.js';

export type Pool = pg.Pool;
export type DbClient = pg.PoolClient;
/** Anything that can run a query: the pool or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'>;

const INT8_OID = 20;

/**
 * BIGINT columns arrive as strings by default. Money is stored in minor units,
 * so values fit in a JS number up to ~90 trillion rupees; anything larger is a bug.
 */
pg.types.setTypeParser(INT8_OID, (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`BIGINT ${value} exceeds safe integer range`);
  return parsed;
});

export function createPool(connectionString: string, max: number): Pool {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
}

/** Postgres errors that are safe to retry by re-running the whole transaction. */
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

export function isRetryableDbError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    RETRYABLE_SQLSTATES.has(String((error as { code?: unknown }).code))
  );
}

export interface TransactionOptions {
  maxRetries?: number;
  logger?: Logger;
}

/**
 * Runs `work` in a transaction: COMMIT on success, ROLLBACK on error.
 * Deadlocks and serialization failures are retried with jittered backoff,
 * so callers never see a transient concurrency error.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: DbClient) => Promise<T>,
  { maxRetries = 3, logger }: TransactionOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (!isRetryableDbError(error) || attempt > maxRetries) throw error;
      logger?.warn({ err: error, attempt }, 'Retrying transaction after concurrency conflict');
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt + Math.random() * 20));
    } finally {
      client.release();
    }
  }
}
