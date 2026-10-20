import { Kafka, Partitioners, logLevel, type Producer } from 'kafkajs';
import type { Env } from '../config/env.js';
import type { Logger } from '../lib/logger.js';

export interface EventMessage {
  key: string;
  value: string;
  headers: Record<string, string>;
}

/** Narrow interface the relay depends on, so tests can use an in-memory fake. */
export interface EventPublisher {
  publish(messages: EventMessage[]): Promise<void>;
}

export function createKafka(
  env: Pick<Env, 'KAFKA_BROKERS' | 'KAFKA_CLIENT_ID'>,
  logger: Logger,
): Kafka {
  return new Kafka({
    clientId: env.KAFKA_CLIENT_ID,
    brokers: env.KAFKA_BROKERS,
    logLevel: logLevel.WARN,
    logCreator: () => (entry) => logger.warn({ kafka: entry.log }, entry.log.message),
    retry: { retries: 8, initialRetryTime: 300 },
  });
}

export async function ensureTopic(kafka: Kafka, topic: string, numPartitions = 3): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    if ((await admin.listTopics()).includes(topic)) return;
    await admin.createTopics({
      topics: [{ topic, numPartitions, replicationFactor: 1 }],
      waitForLeaders: true,
    });
  } finally {
    await admin.disconnect();
  }
}

/**
 * acks=all and one in-flight request keep per-partition ordering. Delivery is
 * at-least-once (a retried batch can be duplicated), which is why every event
 * carries a stable id and consumers de-duplicate on it. KafkaJS's idempotent
 * mode is not used: it needs unbounded retries, which would let a dead broker
 * stall the relay forever instead of failing the batch and retrying later.
 */
export async function createKafkaPublisher(
  kafka: Kafka,
  topic: string,
): Promise<EventPublisher & { disconnect(): Promise<void> }> {
  const producer: Producer = kafka.producer({
    maxInFlightRequests: 1,
    createPartitioner: Partitioners.DefaultPartitioner,
  });
  await producer.connect();
  return {
    async publish(messages) {
      await producer.send({ topic, acks: -1, messages });
    },
    disconnect: () => producer.disconnect(),
  };
}
