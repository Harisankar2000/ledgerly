import { withTransaction, type Pool } from '../db/pool.js';
import type { EventMessage, EventPublisher } from '../kafka/client.js';
import type { Logger } from '../lib/logger.js';

interface OutboxRow {
  id: number;
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  createdAt: Date;
}

/** The message consumers receive. `id` is stable, so consumers can de-duplicate. */
export interface EventEnvelope {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  data: unknown;
}

export function toEnvelope(row: OutboxRow): EventEnvelope {
  return {
    id: row.eventId,
    type: row.eventType,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    occurredAt: row.createdAt.toISOString(),
    data: row.payload,
  };
}

export function toMessage(row: OutboxRow): EventMessage {
  return {
    // Same key → same partition → events for one transaction/account stay ordered.
    key: row.aggregateId,
    value: JSON.stringify(toEnvelope(row)),
    headers: { 'event-id': row.eventId, 'event-type': row.eventType },
  };
}

export interface OutboxRelayOptions {
  pool: Pool;
  publisher: EventPublisher;
  batchSize: number;
  logger: Logger;
}

/**
 * Transactional outbox relay. Rows are locked with SKIP LOCKED, published, then
 * marked in the same transaction. If publishing fails the transaction rolls back
 * and the batch is retried, which gives at-least-once delivery to Kafka.
 */
export function createOutboxRelay({ pool, publisher, batchSize, logger }: OutboxRelayOptions) {
  return {
    publishBatch: () =>
      withTransaction(pool, async (client) => {
        const { rows } = await client.query<OutboxRow>(
          `SELECT id, event_id AS "eventId", aggregate_type AS "aggregateType", aggregate_id AS "aggregateId",
                  event_type AS "eventType", payload, created_at AS "createdAt"
             FROM outbox_events
            WHERE published_at IS NULL
            ORDER BY id
            LIMIT $1
              FOR UPDATE SKIP LOCKED`,
          [batchSize],
        );
        if (rows.length === 0) return 0;

        await publisher.publish(rows.map(toMessage));
        await client.query(
          'UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])',
          [rows.map((row) => row.id)],
        );
        logger.debug({ count: rows.length }, 'Published outbox events');
        return rows.length;
      }),
  };
}
