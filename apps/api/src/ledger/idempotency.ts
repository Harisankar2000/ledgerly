import { createHash } from 'node:crypto';
import { withTransaction, type DbClient, type Pool } from '../db/pool.js';
import { BusinessRuleError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

export interface OperationResult<T> {
  statusCode: number;
  body: T;
}

export interface IdempotentResult<T> extends OperationResult<T> {
  /** True when the stored response of an earlier request was returned. */
  replayed: boolean;
}

export interface IdempotencyRequest {
  /** Operation name, so the same key can be used for different endpoints. */
  scope: string;
  key: string;
  /** The request payload; a reused key with a different payload is rejected. */
  payload: unknown;
}

/** JSON with sorted keys, so `{a,b}` and `{b,a}` hash identically. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashRequest(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * Executes `operation` exactly once per (scope, key).
 *
 * The key is inserted in the SAME database transaction as the money movement:
 * - A concurrent duplicate blocks on the primary key until the first commits,
 *   then reads the stored response (no double charge, no 409 for the client).
 * - If the operation fails, the key rolls back too, so the client can retry.
 */
export async function executeIdempotent<T>(
  pool: Pool,
  request: IdempotencyRequest,
  operation: (client: DbClient) => Promise<OperationResult<T>>,
  logger?: Logger,
): Promise<IdempotentResult<T>> {
  const requestHash = hashRequest(request.payload);

  return withTransaction(
    pool,
    async (client) => {
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (scope, key, request_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (scope, key) DO NOTHING`,
        [request.scope, request.key, requestHash],
      );

      if (inserted.rowCount === 0) {
        const {
          rows: [stored],
        } = await client.query<{ requestHash: string; statusCode: number; body: T }>(
          `SELECT request_hash AS "requestHash", response_status AS "statusCode", response_body AS body
             FROM idempotency_keys WHERE scope = $1 AND key = $2`,
          [request.scope, request.key],
        );
        if (!stored) throw new Error('Idempotency key vanished during lookup');
        if (stored.requestHash !== requestHash) {
          throw new BusinessRuleError(
            'IDEMPOTENCY_KEY_REUSED',
            'This Idempotency-Key was already used with a different request body',
          );
        }
        return { statusCode: stored.statusCode, body: stored.body, replayed: true };
      }

      const result = await operation(client);
      await client.query(
        `UPDATE idempotency_keys SET response_status = $3, response_body = $4
          WHERE scope = $1 AND key = $2`,
        [request.scope, request.key, result.statusCode, JSON.stringify(result.body)],
      );
      return { ...result, replayed: false };
    },
    { logger },
  );
}
