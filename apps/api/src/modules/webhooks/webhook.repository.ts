import type { Queryable } from '../../db/pool.js';
import { WhereBuilder } from '../../db/sql.js';
import { toSkipTake, type PaginationQuery } from '../../lib/pagination.js';

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  eventTypes: string[];
  isActive: boolean;
  createdAt: Date;
}

export type DeliveryStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  status: DeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: Date;
  deliveredAt: Date | null;
  createdAt: Date;
}

/** A claimed delivery joined with what is needed to send it. */
export interface DueDelivery extends WebhookDelivery {
  url: string;
  secret: string;
}

const ENDPOINT_COLUMNS = `id, url, secret, event_types AS "eventTypes", is_active AS "isActive", created_at AS "createdAt"`;
const DELIVERY_COLUMNS = `
  d.id, d.endpoint_id AS "endpointId", d.event_id AS "eventId", d.event_type AS "eventType", d.payload,
  d.status, d.attempts, d.response_status AS "responseStatus", d.last_error AS "lastError",
  d.next_attempt_at AS "nextAttemptAt", d.delivered_at AS "deliveredAt", d.created_at AS "createdAt"`;

export interface DeliveryFilters extends PaginationQuery {
  status?: DeliveryStatus;
  endpointId?: string;
}

export interface DeliveryOutcome {
  id: string;
  succeeded: boolean;
  responseStatus: number | null;
  error: string | null;
  /** Null when the delivery has no attempts left. */
  retryInSeconds: number | null;
}

export const webhookRepository = {
  async insertEndpoint(
    db: Queryable,
    endpoint: { url: string; secret: string; eventTypes: string[] },
  ): Promise<WebhookEndpoint> {
    const { rows } = await db.query<WebhookEndpoint>(
      `INSERT INTO webhook_endpoints (url, secret, event_types) VALUES ($1, $2, $3) RETURNING ${ENDPOINT_COLUMNS}`,
      [endpoint.url, endpoint.secret, endpoint.eventTypes],
    );
    return rows[0] as WebhookEndpoint;
  },

  async listEndpoints(db: Queryable): Promise<WebhookEndpoint[]> {
    const { rows } = await db.query<WebhookEndpoint>(
      `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints ORDER BY created_at DESC`,
    );
    return rows;
  },

  async deleteEndpoint(db: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM webhook_endpoints WHERE id = $1', [id]);
    return rowCount === 1;
  },

  /**
   * Fans an event out to every subscribed endpoint. ON CONFLICT makes the
   * Kafka consumer idempotent when the same event is delivered twice.
   */
  async createDeliveries(
    db: Queryable,
    event: { eventId: string; eventType: string; payload: unknown },
  ): Promise<number> {
    const { rowCount } = await db.query(
      `INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload)
       SELECT id, $1, $2, $3 FROM webhook_endpoints
        WHERE is_active AND ($2 = ANY(event_types) OR '*' = ANY(event_types))
       ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
      [event.eventId, event.eventType, JSON.stringify(event.payload)],
    );
    return rowCount ?? 0;
  },

  /**
   * Claims due deliveries with a short lease instead of holding row locks during
   * HTTP calls: the claim commits immediately and pushes next_attempt_at forward,
   * so a crashed dispatcher's work is picked up again once the lease expires.
   */
  async claimDue(db: Queryable, limit: number, leaseSeconds: number): Promise<DueDelivery[]> {
    const { rows } = await db.query<DueDelivery>(
      `WITH due AS (
         SELECT id FROM webhook_deliveries
          WHERE status = 'PENDING' AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE webhook_deliveries d
          SET attempts = d.attempts + 1, next_attempt_at = now() + make_interval(secs => $2)
         FROM due, webhook_endpoints e
        WHERE d.id = due.id AND e.id = d.endpoint_id
       RETURNING ${DELIVERY_COLUMNS}, e.url, e.secret`,
      [limit, leaseSeconds],
    );
    return rows;
  },

  async recordOutcome(db: Queryable, outcome: DeliveryOutcome): Promise<void> {
    if (outcome.succeeded) {
      await db.query(
        `UPDATE webhook_deliveries
            SET status = 'SUCCEEDED', response_status = $2, last_error = NULL, delivered_at = now()
          WHERE id = $1`,
        [outcome.id, outcome.responseStatus],
      );
      return;
    }
    await db.query(
      `UPDATE webhook_deliveries
          SET status = CASE WHEN $4::int IS NULL THEN 'FAILED' ELSE 'PENDING' END,
              response_status = $2, last_error = $3,
              next_attempt_at = now() + make_interval(secs => COALESCE($4::int, 0))
        WHERE id = $1`,
      [outcome.id, outcome.responseStatus, outcome.error, outcome.retryInSeconds],
    );
  },

  async resetForRedelivery(db: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE webhook_deliveries SET status = 'PENDING', attempts = 0, next_attempt_at = now()
        WHERE id = $1 AND status <> 'PENDING'`,
      [id],
    );
    return rowCount === 1;
  },

  async findDeliveries(
    db: Queryable,
    filters: DeliveryFilters,
  ): Promise<{ items: WebhookDelivery[]; total: number }> {
    const where = new WhereBuilder()
      .addIf(filters.status, 'd.status = ?', filters.status)
      .addIf(filters.endpointId, 'd.endpoint_id = ?', filters.endpointId);
    const countParams = [...where.params];
    const { skip, take } = toSkipTake(filters);
    const page = `LIMIT ${where.param(take)} OFFSET ${where.param(skip)}`;

    const [items, count] = await Promise.all([
      db.query<WebhookDelivery>(
        `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries d ${where.sql} ORDER BY d.created_at DESC ${page}`,
        where.params,
      ),
      db.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM webhook_deliveries d ${where.sql}`,
        countParams,
      ),
    ]);
    return { items: items.rows, total: count.rows[0]?.total ?? 0 };
  },
};
