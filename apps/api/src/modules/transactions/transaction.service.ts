import type { DbClient, Pool } from '../../db/pool.js';
import { postJournal, type PostedTransaction, type TransactionType } from '../../ledger/journal.js';
import { executeIdempotent, type IdempotentResult } from '../../ledger/idempotency.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { buildPage, type Page } from '../../lib/pagination.js';
import { accountRepository } from '../accounts/account.repository.js';
import type { Transaction } from '../../ledger/journal.js';
import { transactionRepository, type TransactionDetail } from './transaction.repository.js';
import type {
  DepositBody,
  ListTransactionsQuery,
  RefundBody,
  TransferBody,
} from './transaction.schemas.js';

/** Only these represent a payer → payee movement that can be reversed. */
const REFUNDABLE_TYPES: readonly TransactionType[] = ['TRANSFER', 'HOLD_CAPTURE', 'DEPOSIT'];

export type MoneyResult = IdempotentResult<PostedTransaction>;

export interface TransactionService {
  deposit(body: DepositBody, idempotencyKey: string): Promise<MoneyResult>;
  withdraw(body: DepositBody, idempotencyKey: string): Promise<MoneyResult>;
  transfer(body: TransferBody, idempotencyKey: string): Promise<MoneyResult>;
  refund(transactionId: string, body: RefundBody, idempotencyKey: string): Promise<MoneyResult>;
  get(id: string): Promise<TransactionDetail>;
  list(query: ListTransactionsQuery): Promise<Page<Transaction>>;
}

async function getWallet(client: DbClient, accountId: string) {
  const account = await accountRepository.findById(client, accountId);
  if (!account) throw new NotFoundError('Account', accountId);
  if (account.kind !== 'WALLET') {
    throw new BusinessRuleError(
      'NOT_A_WALLET',
      'Money can only be moved directly in or out of wallets',
    );
  }
  return account;
}

export function createTransactionService(pool: Pool, logger: Logger): TransactionService {
  /** Wraps a ledger operation in an idempotent DB transaction returning 201. */
  const run = (
    scope: string,
    key: string,
    payload: unknown,
    op: (client: DbClient) => Promise<PostedTransaction>,
  ) =>
    executeIdempotent(
      pool,
      { scope, key, payload },
      async (client) => ({ statusCode: 201, body: await op(client) }),
      logger,
    );

  return {
    deposit: (body, key) =>
      run('deposit', key, body, async (client) => {
        const wallet = await getWallet(client, body.accountId);
        const settlement = await accountRepository.findSystemAccount(
          client,
          'settlement',
          wallet.currency,
        );
        return postJournal(client, {
          type: 'DEPOSIT',
          currency: wallet.currency,
          amount: body.amount,
          sourceAccountId: settlement.id,
          destinationAccountId: wallet.id,
          legs: [
            { accountId: settlement.id, amount: -body.amount },
            { accountId: wallet.id, amount: body.amount },
          ],
          description: body.description ?? 'Wallet top-up',
          metadata: body.metadata,
        });
      }),

    withdraw: (body, key) =>
      run('withdrawal', key, body, async (client) => {
        const wallet = await getWallet(client, body.accountId);
        const settlement = await accountRepository.findSystemAccount(
          client,
          'settlement',
          wallet.currency,
        );
        return postJournal(client, {
          type: 'WITHDRAWAL',
          currency: wallet.currency,
          amount: body.amount,
          sourceAccountId: wallet.id,
          destinationAccountId: settlement.id,
          legs: [
            { accountId: wallet.id, amount: -body.amount },
            { accountId: settlement.id, amount: body.amount },
          ],
          description: body.description ?? 'Withdrawal to bank',
          metadata: body.metadata,
        });
      }),

    transfer: (body, key) =>
      run('transfer', key, body, async (client) => {
        const source = await getWallet(client, body.sourceAccountId);
        const destination = await getWallet(client, body.destinationAccountId);
        if (source.currency !== destination.currency) {
          throw new BusinessRuleError(
            'CURRENCY_MISMATCH',
            'Cross-currency transfers are not supported',
          );
        }
        return postJournal(client, {
          type: 'TRANSFER',
          currency: source.currency,
          amount: body.amount,
          sourceAccountId: source.id,
          destinationAccountId: destination.id,
          legs: [
            { accountId: source.id, amount: -body.amount },
            { accountId: destination.id, amount: body.amount },
          ],
          description: body.description,
          metadata: body.metadata,
        });
      }),

    refund: (transactionId, body, key) =>
      run(`refund:${transactionId}`, key, body, async (client) => {
        // Row lock: two concurrent partial refunds cannot both pass the limit check.
        const original = await transactionRepository.findById(client, transactionId, {
          forUpdate: true,
        });
        if (!original) throw new NotFoundError('Transaction', transactionId);
        if (!REFUNDABLE_TYPES.includes(original.type)) {
          throw new BusinessRuleError(
            'NOT_REFUNDABLE',
            `${original.type} transactions cannot be refunded`,
          );
        }

        const remaining = original.amount - original.refundedAmount;
        const amount = body.amount ?? remaining;
        if (remaining === 0)
          throw new BusinessRuleError('ALREADY_REFUNDED', 'Transaction is fully refunded');
        if (amount > remaining) {
          throw new BusinessRuleError(
            'REFUND_EXCEEDS_REMAINING',
            `At most ${remaining} can still be refunded`,
            {
              remaining,
            },
          );
        }

        await transactionRepository.addRefundedAmount(client, original.id, amount);
        return postJournal(client, {
          type: 'REFUND',
          currency: original.currency,
          amount,
          sourceAccountId: original.destinationAccountId,
          destinationAccountId: original.sourceAccountId,
          legs: [
            { accountId: original.destinationAccountId, amount: -amount },
            { accountId: original.sourceAccountId, amount },
          ],
          parentTransactionId: original.id,
          description: body.reason ?? `Refund of ${original.id}`,
        });
      }),

    async get(id) {
      const detail = await transactionRepository.findDetail(pool, id);
      if (!detail) throw new NotFoundError('Transaction', id);
      return detail;
    },

    async list(query) {
      const { items, total } = await transactionRepository.findMany(pool, query);
      return buildPage(items, total, query);
    },
  };
}
