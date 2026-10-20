import type { Queryable } from '../../db/pool.js';
import { WhereBuilder } from '../../db/sql.js';
import { TRANSACTION_COLUMNS, type Entry, type Transaction } from '../../ledger/journal.js';
import { toSkipTake } from '../../lib/pagination.js';
import type { ListTransactionsQuery } from './transaction.schemas.js';

export interface TransactionDetail extends Transaction {
  entries: Entry[];
  refunds: Transaction[];
}

export const transactionRepository = {
  /** `forUpdate` serialises concurrent refunds of the same transaction. */
  async findById(
    db: Queryable,
    id: string,
    { forUpdate = false } = {},
  ): Promise<Transaction | null> {
    const { rows } = await db.query<Transaction>(
      `SELECT ${TRANSACTION_COLUMNS} FROM transactions WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ?? null;
  },

  async findDetail(db: Queryable, id: string): Promise<TransactionDetail | null> {
    const transaction = await transactionRepository.findById(db, id);
    if (!transaction) return null;

    const entries = await db.query<Entry>(
      `SELECT id, account_id AS "accountId", amount, balance_after AS "balanceAfter", created_at AS "createdAt"
           FROM entries WHERE transaction_id = $1 ORDER BY id`,
      [id],
    );
    const refunds = await db.query<Transaction>(
      `SELECT ${TRANSACTION_COLUMNS} FROM transactions
          WHERE parent_transaction_id = $1 AND type = 'REFUND' ORDER BY created_at`,
      [id],
    );
    return { ...transaction, entries: entries.rows, refunds: refunds.rows };
  },

  async findMany(
    db: Queryable,
    query: ListTransactionsQuery,
  ): Promise<{ items: Transaction[]; total: number }> {
    const where = new WhereBuilder()
      .addIf(query.type, 'type = ?', query.type)
      .addIf(
        query.accountId,
        '(source_account_id = ? OR destination_account_id = ?)',
        query.accountId,
        query.accountId,
      );
    const countParams = [...where.params];
    const { skip, take } = toSkipTake(query);
    const page = `LIMIT ${where.param(take)} OFFSET ${where.param(skip)}`;

    const [items, count] = await Promise.all([
      db.query<Transaction>(
        `SELECT ${TRANSACTION_COLUMNS} FROM transactions ${where.sql} ORDER BY created_at DESC ${page}`,
        where.params,
      ),
      db.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM transactions ${where.sql}`,
        countParams,
      ),
    ]);
    return { items: items.rows, total: count.rows[0]?.total ?? 0 };
  },

  async addRefundedAmount(db: Queryable, id: string, amount: number): Promise<void> {
    await db.query('UPDATE transactions SET refunded_amount = refunded_amount + $2 WHERE id = $1', [
      id,
      amount,
    ]);
  },
};
