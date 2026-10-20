import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { NotFoundError } from '../../lib/errors.js';
import { buildPage, paginationQuerySchema } from '../../lib/pagination.js';
import { generateWebhookSecret } from '../../workers/webhook-signature.js';
import { webhookRepository, type WebhookEndpoint } from './webhook.repository.js';

const tags = ['Webhooks'];

const EVENT_TYPES = [
  '*',
  'account.created',
  'account.status_changed',
  'transaction.posted',
  'hold.created',
  'hold.captured',
  'hold.released',
  'hold.expired',
] as const;

const createEndpointBodySchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  eventTypes: z.array(z.enum(EVENT_TYPES)).min(1).default(['*']),
});
const idParamsSchema = z.object({ id: z.uuid() });
const listDeliveriesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']).optional(),
  endpointId: z.uuid().optional(),
});

/** The secret is shown once at creation, like an API key. */
const maskSecret = (endpoint: WebhookEndpoint) => ({
  ...endpoint,
  secret: `${endpoint.secret.slice(0, 10)}…`,
});

export function webhookRoutes(pool: Pool): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/webhook-endpoints',
      {
        schema: {
          tags,
          summary: 'Register a webhook endpoint (returns its signing secret once)',
          body: createEndpointBodySchema,
        },
      },
      async (request, reply) => {
        const endpoint = await webhookRepository.insertEndpoint(pool, {
          url: request.body.url,
          eventTypes: request.body.eventTypes,
          secret: generateWebhookSecret(),
        });
        return reply.code(201).send(endpoint);
      },
    );

    app.get(
      '/webhook-endpoints',
      { schema: { tags, summary: 'List webhook endpoints' } },
      async () => ({
        items: (await webhookRepository.listEndpoints(pool)).map(maskSecret),
      }),
    );

    app.delete(
      '/webhook-endpoints/:id',
      { schema: { tags, summary: 'Delete a webhook endpoint', params: idParamsSchema } },
      async (request, reply) => {
        if (!(await webhookRepository.deleteEndpoint(pool, request.params.id))) {
          throw new NotFoundError('Webhook endpoint', request.params.id);
        }
        return reply.code(204).send();
      },
    );

    app.get(
      '/webhook-deliveries',
      {
        schema: {
          tags,
          summary: 'List webhook delivery attempts',
          querystring: listDeliveriesQuerySchema,
        },
      },
      async (request) => {
        const { items, total } = await webhookRepository.findDeliveries(pool, request.query);
        return buildPage(items, total, request.query);
      },
    );

    app.post(
      '/webhook-deliveries/:id/redeliver',
      {
        schema: {
          tags,
          summary: 'Queue a finished delivery to be sent again',
          params: idParamsSchema,
        },
      },
      async (request, reply) => {
        if (!(await webhookRepository.resetForRedelivery(pool, request.params.id))) {
          throw new NotFoundError('Finished webhook delivery', request.params.id);
        }
        return reply.code(202).send({ status: 'PENDING' });
      },
    );
  };
}
