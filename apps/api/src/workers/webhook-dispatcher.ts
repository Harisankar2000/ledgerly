import type { Pool } from '../db/pool.js';
import { getErrorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { webhookRepository, type DueDelivery } from '../modules/webhooks/webhook.repository.js';
import type { EventEnvelope } from './outbox-relay.js';
import { SIGNATURE_HEADER, signPayload } from './webhook-signature.js';

const BASE_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 3_600;
const CLAIM_BATCH_SIZE = 20;

/** Exponential backoff with jitter: ~5s, 10s, 20s, … capped at an hour. */
export function retryDelaySeconds(attempt: number, random = Math.random): number {
  const base = Math.min(BASE_RETRY_SECONDS * 2 ** (attempt - 1), MAX_RETRY_SECONDS);
  return Math.round(base * (0.8 + random() * 0.4));
}

export interface WebhookDispatcherOptions {
  pool: Pool;
  logger: Logger;
  maxAttempts: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function createWebhookDispatcher({
  pool,
  logger,
  maxAttempts,
  timeoutMs,
  fetchImpl = fetch,
}: WebhookDispatcherOptions) {
  const leaseSeconds = Math.ceil(timeoutMs / 1000) + 30;

  async function send(delivery: DueDelivery) {
    const body = JSON.stringify(delivery.payload);
    try {
      const response = await fetchImpl(delivery.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Ledgerly-Webhooks/1.0',
          'ledgerly-event-id': delivery.eventId,
          'ledgerly-event-type': delivery.eventType,
          [SIGNATURE_HEADER]: signPayload(delivery.secret, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      return {
        responseStatus: response.status,
        error: response.ok ? null : `HTTP ${response.status}`,
      };
    } catch (error) {
      return { responseStatus: null, error: getErrorMessage(error) };
    }
  }

  return {
    /** Kafka handler: turns one event into one delivery row per subscribed endpoint. */
    async handleEvent(event: EventEnvelope): Promise<number> {
      return webhookRepository.createDeliveries(pool, {
        eventId: event.id,
        eventType: event.type,
        payload: event,
      });
    },

    /** Sends every due delivery once. Returns how many were attempted. */
    async deliverDue(): Promise<number> {
      const due = await webhookRepository.claimDue(pool, CLAIM_BATCH_SIZE, leaseSeconds);
      await Promise.all(
        due.map(async (delivery) => {
          const { responseStatus, error } = await send(delivery);
          const succeeded = error === null;
          const exhausted = delivery.attempts >= maxAttempts;
          await webhookRepository.recordOutcome(pool, {
            id: delivery.id,
            succeeded,
            responseStatus,
            error,
            retryInSeconds: succeeded || exhausted ? null : retryDelaySeconds(delivery.attempts),
          });
          if (!succeeded) {
            logger.warn(
              { deliveryId: delivery.id, attempt: delivery.attempts, error, exhausted },
              'Webhook delivery failed',
            );
          }
        }),
      );
      return due.length;
    },
  };
}
