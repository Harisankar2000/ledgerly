import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { paginationQuerySchema } from '../../lib/pagination.js';
import type { AccountService } from './account.service.js';
import {
  accountParamsSchema,
  createWalletBodySchema,
  listAccountsQuerySchema,
  updateAccountStatusBodySchema,
} from './account.schemas.js';

const tags = ['Accounts'];

export function accountRoutes(service: AccountService): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/accounts',
      { schema: { tags, summary: 'Create a wallet', body: createWalletBodySchema } },
      async (request, reply) => reply.code(201).send(await service.createWallet(request.body)),
    );

    app.get(
      '/accounts',
      {
        schema: {
          tags,
          summary: 'List wallets and system accounts',
          querystring: listAccountsQuerySchema,
        },
      },
      async (request) => service.list(request.query),
    );

    app.get(
      '/accounts/:accountId',
      { schema: { tags, summary: 'Get an account with its balance', params: accountParamsSchema } },
      async (request) => service.get(request.params.accountId),
    );

    app.get(
      '/accounts/:accountId/entries',
      {
        schema: {
          tags,
          summary: 'Account statement: ledger entries with running balance',
          params: accountParamsSchema,
          querystring: paginationQuerySchema,
        },
      },
      async (request) => service.statement(request.params.accountId, request.query),
    );

    app.patch(
      '/accounts/:accountId/status',
      {
        schema: {
          tags,
          summary: 'Freeze or unfreeze an account',
          params: accountParamsSchema,
          body: updateAccountStatusBodySchema,
        },
      },
      async (request) => service.setStatus(request.params.accountId, request.body.status),
    );
  };
}
