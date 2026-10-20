/**
 * Background process #1: publishes the outbox to Kafka and expires stale holds.
 */
import { loadEnv } from './config/env.js';
import { createContainer } from './container.js';
import { createKafka, createKafkaPublisher, ensureTopic } from './kafka/client.js';
import { createLogger } from './lib/logger.js';
import { registerGracefulShutdown } from './lib/shutdown.js';
import { createOutboxRelay } from './workers/outbox-relay.js';
import { startPoller } from './workers/poller.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    name: 'ledgerly-relay',
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });
  const container = createContainer(env, logger);

  const kafka = createKafka(env, logger);
  await ensureTopic(kafka, env.KAFKA_TOPIC);
  const publisher = await createKafkaPublisher(kafka, env.KAFKA_TOPIC);

  const relay = createOutboxRelay({
    pool: container.pool,
    publisher,
    batchSize: env.OUTBOX_BATCH_SIZE,
    logger,
  });
  const pollers = [
    startPoller(relay.publishBatch, {
      name: 'outbox-relay',
      intervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
      logger,
    }),
    startPoller(
      async () => {
        const expired = await container.holds.expireDue(100);
        if (expired > 0) logger.info({ expired }, 'Expired holds released');
        return expired;
      },
      { name: 'hold-expiry', intervalMs: env.HOLD_SWEEP_INTERVAL_MS, batchSize: 100, logger },
    ),
  ];

  registerGracefulShutdown(logger, [
    () => Promise.all(pollers.map((poller) => poller.stop())).then(() => undefined),
    () => publisher.disconnect(),
    () => container.dispose(),
  ]);
  logger.info({ topic: env.KAFKA_TOPIC }, 'Outbox relay started');
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to start relay: ${String(error)}\n`);
  process.exit(1);
});
