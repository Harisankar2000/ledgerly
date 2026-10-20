import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Container } from '../container.js';
import { accountRoutes } from '../modules/accounts/account.routes.js';
import { healthRoutes } from '../modules/health/health.routes.js';
import { holdRoutes } from '../modules/holds/hold.routes.js';
import { reconciliationRoutes } from '../modules/reconciliation/reconciliation.routes.js';
import { transactionRoutes } from '../modules/transactions/transaction.routes.js';
import { webhookRoutes } from '../modules/webhooks/webhook.routes.js';
import { registerApiKeyAuth } from './plugins/auth.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { registerSwagger } from './plugins/swagger.js';

export interface BuildAppOptions {
  /** Use Redis for rate-limit counters so limits hold across API replicas. */
  sharedRateLimit?: boolean;
}

export async function buildApp(
  container: Container,
  { sharedRateLimit = true }: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const { env, logger, pool, redis } = container;

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
    },
    bodyLimit: 256 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerErrorHandling(app);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    exposedHeaders: ['idempotent-replayed', 'x-request-id', 'x-ratelimit-remaining'],
  });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    ...(sharedRateLimit && { redis, nameSpace: 'ledgerly:ratelimit:' }),
    keyGenerator: (request) => {
      const apiKey = request.headers['x-api-key'];
      return typeof apiKey === 'string' ? `key:${apiKey}` : `ip:${request.ip}`;
    },
  });
  await registerSwagger(app);
  registerApiKeyAuth(app, env.API_KEYS);

  await app.register(
    healthRoutes({
      checks: {
        database: async () => {
          await pool.query('SELECT 1');
        },
        redis: async () => {
          await redis.ping();
        },
      },
    }),
  );

  await app.register(
    async (api) => {
      await api.register(accountRoutes(container.accounts));
      await api.register(transactionRoutes(container.transactions));
      await api.register(holdRoutes(container.holds));
      await api.register(webhookRoutes(pool));
      await api.register(reconciliationRoutes(container.reconciliation));
    },
    { prefix: '/api/v1' },
  );

  return app;
}
