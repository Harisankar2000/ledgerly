import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ReconciliationService } from './reconciliation.service.js';

const tags = ['Reconciliation'];

export function reconciliationRoutes(service: ReconciliationService): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/reconciliation/runs',
      { schema: { tags, summary: 'Run all ledger integrity checks and store the report' } },
      async (_request, reply) => reply.code(201).send(await service.run()),
    );

    app.get(
      '/reconciliation/runs',
      { schema: { tags, summary: 'Recent reconciliation reports' } },
      async () => ({
        items: await service.listRuns(),
      }),
    );

    app.get(
      '/overview',
      { schema: { tags: ['Dashboard'], summary: 'Headline numbers for the dashboard' } },
      async () => service.overview(),
    );
  };
}
