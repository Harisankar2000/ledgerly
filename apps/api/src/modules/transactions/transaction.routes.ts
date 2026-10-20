import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { IdempotentResult } from '../../ledger/idempotency.js';
import type { TransactionService } from './transaction.service.js';
import {
  depositBodySchema,
  idempotencyHeadersSchema,
  listTransactionsQuerySchema,
  refundBodySchema,
  transactionParamsSchema,
  transferBodySchema,
  withdrawalBodySchema,
} from './transaction.schemas.js';

const tags = ['Money movement'];

/** Replayed responses carry `Idempotent-Replayed: true`, like Stripe. */
export function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>) {
  return reply
    .code(result.statusCode)
    .header('idempotent-replayed', String(result.replayed))
    .send(result.body);
}

export function transactionRoutes(service: TransactionService): FastifyPluginAsyncZod {
  return async (app) => {
    const headers = idempotencyHeadersSchema;

    app.post(
      '/deposits',
      {
        schema: {
          tags,
          summary: 'Top up a wallet from the settlement account',
          headers,
          body: depositBodySchema,
        },
      },
      async (request, reply) =>
        sendIdempotent(
          reply,
          await service.deposit(request.body, request.headers['idempotency-key']),
        ),
    );

    app.post(
      '/withdrawals',
      {
        schema: {
          tags,
          summary: 'Pay out from a wallet to the settlement account',
          headers,
          body: withdrawalBodySchema,
        },
      },
      async (request, reply) =>
        sendIdempotent(
          reply,
          await service.withdraw(request.body, request.headers['idempotency-key']),
        ),
    );

    app.post(
      '/transfers',
      {
        schema: {
          tags,
          summary: 'Move money between two wallets',
          headers,
          body: transferBodySchema,
        },
      },
      async (request, reply) =>
        sendIdempotent(
          reply,
          await service.transfer(request.body, request.headers['idempotency-key']),
        ),
    );

    app.post(
      '/transactions/:transactionId/refunds',
      {
        schema: {
          tags,
          summary: 'Refund a transfer, capture or deposit (full or partial)',
          headers,
          params: transactionParamsSchema,
          body: refundBodySchema,
        },
      },
      async (request, reply) =>
        sendIdempotent(
          reply,
          await service.refund(
            request.params.transactionId,
            request.body,
            request.headers['idempotency-key'],
          ),
        ),
    );

    app.get(
      '/transactions',
      {
        schema: {
          tags: ['Transactions'],
          summary: 'List transactions',
          querystring: listTransactionsQuerySchema,
        },
      },
      async (request) => service.list(request.query),
    );

    app.get(
      '/transactions/:transactionId',
      {
        schema: {
          tags: ['Transactions'],
          summary: 'Get a transaction with its journal entries and refunds',
          params: transactionParamsSchema,
        },
      },
      async (request) => service.get(request.params.transactionId),
    );
  };
}
