import { z } from 'zod';
import { amountSchema } from '../../lib/money.js';
import { paginationQuerySchema } from '../../lib/pagination.js';

export const HOLD_STATUSES = ['ACTIVE', 'CAPTURED', 'RELEASED', 'EXPIRED'] as const;
const MAX_HOLD_SECONDS = 30 * 24 * 3600;

export const createHoldBodySchema = z.object({
  accountId: z.uuid(),
  amount: amountSchema,
  expiresInSeconds: z.number().int().min(1).max(MAX_HOLD_SECONDS).default(3_600),
  description: z.string().trim().min(1).max(280).optional(),
});

export const captureHoldBodySchema = z.object({
  destinationAccountId: z.uuid(),
  /** Omit to capture the full amount. Any remainder is released to the payer. */
  amount: amountSchema.optional(),
});

export const holdParamsSchema = z.object({ holdId: z.uuid() });

export const listHoldsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(HOLD_STATUSES).optional(),
  accountId: z.uuid().optional(),
});

export type CreateHoldBody = z.infer<typeof createHoldBodySchema>;
export type CaptureHoldBody = z.infer<typeof captureHoldBodySchema>;
export type ListHoldsQuery = z.infer<typeof listHoldsQuerySchema>;
