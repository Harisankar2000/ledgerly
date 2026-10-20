import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Ledgerly API',
        description:
          'Double-entry payment ledger and wallet service. Amounts are integers in minor units (paise/cents). Money-moving POSTs require an Idempotency-Key header.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: { apiKey: { type: 'apiKey', name: 'x-api-key', in: 'header' } },
      },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, { routePrefix: '/docs' });
}
