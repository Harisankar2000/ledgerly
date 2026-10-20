import type { Queryable } from '../db/pool.js';

export type LedgerEventType =
  | 'account.created'
  | 'account.status_changed'
  | 'transaction.posted'
  | 'hold.created'
  | 'hold.captured'
  | 'hold.released'
  | 'hold.expired';

export interface OutboxEvent {
  aggregateType: 'account' | 'transaction' | 'hold';
  aggregateId: string;
  eventType: LedgerEventType;
  payload: unknown;
}

/**
 * Writes an event in the caller's transaction. It becomes visible to the relay
 * only if the ledger change commits, so Kafka never sees phantom or lost events.
 */
export async function enqueueEvent(db: Queryable, event: OutboxEvent): Promise<void> {
  await db.query(
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [event.aggregateType, event.aggregateId, event.eventType, JSON.stringify(event.payload)],
  );
}
