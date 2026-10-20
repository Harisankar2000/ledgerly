/**
 * Background process #2: consumes ledger events from Kafka and delivers
 * signed webhooks with retries.
 */
import { loadEnv } from './config/env.js';
import { createContainer } from './container.js';
import { createKafka, ensureTopic } from './kafka/client.js';
import { createLogger } from './lib/logger.js';
import { registerGracefulShutdown } from './lib/shutdown.js';
import type { EventEnvelope } from './workers/outbox-relay.js';
import { startPoller } from './workers/poller.js';
import { createWebhookDispatcher } from './workers/webhook-dispatcher.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    name: 'ledgerly-dispatcher',
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });
  const container = createContainer(env, logger);
  const dispatcher = createWebhookDispatcher({
    pool: container.pool,
    logger,
    maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    timeoutMs: env.WEBHOOK_TIMEOUT_MS,
  });

  const kafka = createKafka(env, logger);
  await ensureTopic(kafka, env.KAFKA_TOPIC);
  const consumer = kafka.consumer({ groupId: 'webhook-dispatcher' });
  await consumer.connect();
  await consumer.subscribe({ topic: env.KAFKA_TOPIC, fromBeginning: true });

  const delivery = startPoller(dispatcher.deliverDue, {
    name: 'webhook-delivery',
    intervalMs: env.WEBHOOK_RETRY_INTERVAL_MS,
    batchSize: 20,
    logger,
  });

  // The offset is committed only after the handler resolves, so a crash
  // re-delivers the message; createDeliveries is idempotent on event id.
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString()) as EventEnvelope;
      const created = await dispatcher.handleEvent(event);
      if (created > 0) await dispatcher.deliverDue();
    },
  });

  registerGracefulShutdown(logger, [
    () => consumer.disconnect(),
    () => delivery.stop(),
    () => container.dispose(),
  ]);
  logger.info('Webhook dispatcher started');
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to start dispatcher: ${String(error)}\n`);
  process.exit(1);
});
