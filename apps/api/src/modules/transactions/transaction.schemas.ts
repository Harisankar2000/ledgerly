import { z } from 'zod';
import { TRANSACTION_TYPES } from '../../ledger/journal.js';
import { amountSchema } from '../../lib/money.js';
import { paginationQuerySchema } from '../../lib/pagination.js';

const descriptionSchema = z.string().trim().min(1).max(280).optional();
const metadataSchema = z.record(z.string(), z.unknown()).default({});

export const idempotencyHeadersSchema = z.object({
  'idempotency-key': z.string().trim().min(8, 'Use a unique key of at least 8 characters').max(200),
});

export const depositBodySchema = z.object({
  accountId: z.uuid(),
  amount: amountSchema,
  description: descriptionSchema,
  metadata: metadataSchema,
});

export const withdrawalBodySchema = depositBodySchema;

export const transferBodySchema = z
  .object({
    sourceAccountId: z.uuid(),
    destinationAccountId: z.uuid(),
    amount: amountSchema,
    description: descriptionSchema,
    metadata: metadataSchema,
  })
  .refine((body) => body.sourceAccountId !== body.destinationAccountId, {
    message: 'Source and destination must differ',
    path: ['destinationAccountId'],
  });

export const refundBodySchema = z
  .object({
    /** Omit for a full refund of the remaining amount. */
    amount: amountSchema.optional(),
    reason: descriptionSchema,
  })
  .prefault({});

export const transactionParamsSchema = z.object({ transactionId: z.uuid() });

export const listTransactionsQuerySchema = paginationQuerySchema.extend({
  type: z.enum(TRANSACTION_TYPES).optional(),
  accountId: z.uuid().optional(),
});

export type DepositBody = z.infer<typeof depositBodySchema>;
export type TransferBody = z.infer<typeof transferBodySchema>;
export type RefundBody = z.infer<typeof refundBodySchema>;
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;
