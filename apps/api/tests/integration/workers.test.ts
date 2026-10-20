/**
 * Outbox relay (with real Kafka) and webhook dispatcher (with a local receiver).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createKafka,
  createKafkaPublisher,
  ensureTopic,
  type EventMessage,
} from '../../src/kafka/client.js';
import { createLogger } from '../../src/lib/logger.js';
import { createOutboxRelay, type EventEnvelope } from '../../src/workers/outbox-relay.js';
import { createWebhookDispatcher } from '../../src/workers/webhook-dispatcher.js';
import { SIGNATURE_HEADER, verifySignature } from '../../src/workers/webhook-signature.js';
import {
  apiClient,
  createTestContext,
  resetDatabase,
  type ApiClient,
  type TestContext,
} from './helpers.js';

const logger = createLogger({ name: 'test', level: 'silent', pretty: false });

let ctx: TestContext;
let api: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  api = apiClient(ctx.app);
});
afterAll(() => ctx.close());
beforeEach(() => resetDatabase(ctx.container.pool));

async function unpublishedCount(): Promise<number> {
  const { rows } = await ctx.container.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM outbox_events WHERE published_at IS NULL',
  );
  return rows[0]?.count ?? 0;
}

describe('outbox relay', () => {
  it('publishes pending events in order and marks them as published', async () => {
    const published: EventMessage[] = [];
    const relay = createOutboxRelay({
      pool: ctx.container.pool,
      publisher: { publish: async (messages) => void published.push(...messages) },
      batchSize: 2,
      logger,
    });
    const wallet = await api.createWallet('Asha');
    await api.deposit(wallet, 100);
    await api.deposit(wallet, 200);

    expect(await relay.publishBatch()).toBe(2);
    expect(await relay.publishBatch()).toBe(1);
    expect(await relay.publishBatch()).toBe(0);

    const types = published.map((message) => message.headers['event-type']);
    expect(types).toEqual(['account.created', 'transaction.posted', 'transaction.posted']);
    expect(await unpublishedCount()).toBe(0);
  });

  it('leaves events unpublished when Kafka is unavailable, so nothing is lost', async () => {
    const relay = createOutboxRelay({
      pool: ctx.container.pool,
      publisher: {
        publish: async () => {
          throw new Error('broker unavailable');
        },
      },
      batchSize: 10,
      logger,
    });
    await api.createWallet('Asha');

    await expect(relay.publishBatch()).rejects.toThrow('broker unavailable');
    expect(await unpublishedCount()).toBe(1);
  });

  it('delivers events to a real Kafka topic', async () => {
    const topic = `ledger.events.test.${randomUUID()}`;
    const kafka = createKafka(ctx.env, logger);
    await ensureTopic(kafka, topic, 1);
    const publisher = await createKafkaPublisher(kafka, topic);
    const consumer = kafka.consumer({ groupId: `test-${randomUUID()}` });

    try {
      const wallet = await api.createWallet('Kafka wallet');
      await api.deposit(wallet, 4_200);
      await createOutboxRelay({
        pool: ctx.container.pool,
        publisher,
        batchSize: 10,
        logger,
      }).publishBatch();

      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: true });
      const received: EventEnvelope[] = [];
      await new Promise<void>((resolve) => {
        void consumer.run({
          eachMessage: async ({ message }) => {
            received.push(JSON.parse(String(message.value)) as EventEnvelope);
            if (received.length === 2) resolve();
          },
        });
      });

      expect(received.map((event) => event.type)).toEqual([
        'account.created',
        'transaction.posted',
      ]);
      expect(received[1]?.data).toMatchObject({ type: 'DEPOSIT', amount: 4_200 });
    } finally {
      await consumer.disconnect();
      await publisher.disconnect();
    }
  }, 60_000);
});

describe('webhook dispatcher', () => {
  let receiver: Server;
  let receiverUrl: string;
  let failuresRemaining = 0;
  const received: Array<{ body: string; signature: string | undefined }> = [];

  beforeAll(async () => {
    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          response.writeHead(500).end();
          return;
        }
        received.push({
          body: Buffer.concat(chunks).toString(),
          signature: request.headers[SIGNATURE_HEADER] as string,
        });
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;
  });

  afterAll(() => new Promise<void>((resolve) => receiver.close(() => resolve())));

  beforeEach(() => {
    failuresRemaining = 0;
    received.length = 0;
  });

  const event = (type: string): EventEnvelope => ({
    id: randomUUID(),
    type,
    aggregateType: 'transaction',
    aggregateId: randomUUID(),
    occurredAt: new Date().toISOString(),
    data: { amount: 100 },
  });

  const dispatcher = (maxAttempts = 3) =>
    createWebhookDispatcher({ pool: ctx.container.pool, logger, maxAttempts, timeoutMs: 2_000 });

  async function registerEndpoint(eventTypes: string[] = ['*']) {
    return (
      await api.call<{ id: string; secret: string }>('POST', '/webhook-endpoints', {
        url: receiverUrl,
        eventTypes,
      })
    ).body;
  }

  async function deliveries() {
    return (
      await api.call<{
        items: Array<{ status: string; attempts: number; responseStatus: number | null }>;
      }>('GET', '/webhook-deliveries')
    ).body.items;
  }

  it('fans out only to subscribed endpoints and signs each request', async () => {
    const all = await registerEndpoint(['*']);
    await registerEndpoint(['hold.created']);
    const webhooks = dispatcher();

    expect(await webhooks.handleEvent(event('transaction.posted'))).toBe(1);
    expect(await webhooks.deliverDue()).toBe(1);

    expect(received).toHaveLength(1);
    expect(verifySignature(all.secret, received[0]?.body ?? '', received[0]?.signature)).toBe(true);
    expect(await deliveries()).toEqual([
      expect.objectContaining({ status: 'SUCCEEDED', responseStatus: 200 }),
    ]);
  });

  it('is idempotent when Kafka redelivers the same event', async () => {
    await registerEndpoint();
    const webhooks = dispatcher();
    const duplicate = event('transaction.posted');

    expect(await webhooks.handleEvent(duplicate)).toBe(1);
    expect(await webhooks.handleEvent(duplicate)).toBe(0);
  });

  it('schedules a retry after a failure and gives up after max attempts', async () => {
    await registerEndpoint();
    const webhooks = dispatcher(2);
    failuresRemaining = 10;
    await webhooks.handleEvent(event('transaction.posted'));

    await webhooks.deliverDue();
    expect(await deliveries()).toEqual([
      expect.objectContaining({ status: 'PENDING', attempts: 1, responseStatus: 500 }),
    ]);

    await ctx.container.pool.query('UPDATE webhook_deliveries SET next_attempt_at = now()');
    await webhooks.deliverDue();
    expect(await deliveries()).toEqual([
      expect.objectContaining({ status: 'FAILED', attempts: 2 }),
    ]);
  });

  it('can redeliver a failed delivery on request', async () => {
    await registerEndpoint();
    const webhooks = dispatcher(1);
    failuresRemaining = 1;
    await webhooks.handleEvent(event('transaction.posted'));
    await webhooks.deliverDue();

    const [failed] = (
      await api.call<{ items: Array<{ id: string }> }>('GET', '/webhook-deliveries?status=FAILED')
    ).body.items;
    expect((await api.call('POST', `/webhook-deliveries/${failed?.id}/redeliver`)).status).toBe(
      202,
    );
    await webhooks.deliverDue();

    expect(await deliveries()).toEqual([expect.objectContaining({ status: 'SUCCEEDED' })]);
  });
});
