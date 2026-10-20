import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { idempotencyHeadersSchema } from '../transactions/transaction.schemas.js';
import { sendIdempotent } from '../transactions/transaction.routes.js';
import type { HoldService } from './hold.service.js';
import {
  captureHoldBodySchema,
  createHoldBodySchema,
  holdParamsSchema,
  listHoldsQuerySchema,
} from './hold.schemas.js';

const tags = ['Holds'];

export function holdRoutes(service: HoldService): FastifyPluginAsyncZod {
  return async (app) => {
    const headers = idempotencyHeadersSchema;

    app.post(
      '/holds',
      {
        schema: {
          tags,
          summary: 'Authorise (reserve) funds in a wallet',
          headers,
          body: createHoldBodySchema,
        },
      },
      async (request, reply) =>
        sendIdempotent(
          reply,
          await service.create(request.body, request.headers['idempotency-key']),
        ),
    );

    app.post(
      '/holds/:holdId/capture',
      {
        schema: {
          tags,
          summary: 'Capture a hold (fully or partially) to a destination wallet',
          headers,
          params: holdParamsSchema,
          body: captureHoldBodySchema,
        },
      },
      async (request, reply) =>
        sendIdempotent(
          reply,
          await service.capture(
            request.params.holdId,
            request.body,
            request.headers['idempotency-key'],
          ),
        ),
    );

    app.post(
      '/holds/:holdId/release',
      {
        schema: {
          tags,
          summary: 'Release a hold back to the payer',
          headers,
          params: holdParamsSchema,
        },
      },
      async (request, reply) =>
        sendIdempotent(
          reply,
          await service.release(request.params.holdId, request.headers['idempotency-key']),
        ),
    );

    app.get(
      '/holds',
      { schema: { tags, summary: 'List holds', querystring: listHoldsQuerySchema } },
      async (request) => service.list(request.query),
    );

    app.get(
      '/holds/:holdId',
      { schema: { tags, summary: 'Get a hold', params: holdParamsSchema } },
      async (request) => service.get(request.params.holdId),
    );
  };
}
