import { z } from 'zod';
import { currencySchema } from '../../lib/money.js';
import { paginationQuerySchema } from '../../lib/pagination.js';

export const accountParamsSchema = z.object({ accountId: z.uuid() });

export const createWalletBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  ownerRef: z.string().trim().min(1).max(120).optional(),
  currency: currencySchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const listAccountsQuerySchema = paginationQuerySchema.extend({
  kind: z.enum(['WALLET', 'SYSTEM']).optional(),
  currency: currencySchema.optional(),
  ownerRef: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(120).optional(),
});

export const updateAccountStatusBodySchema = z.object({
  status: z.enum(['ACTIVE', 'FROZEN']),
});

export type CreateWalletBody = z.infer<typeof createWalletBodySchema>;
