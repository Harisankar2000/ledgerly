import type { Queryable } from '../../db/pool.js';
import { WhereBuilder } from '../../db/sql.js';
import type { Entry } from '../../ledger/journal.js';
import { toSkipTake, type PaginationQuery } from '../../lib/pagination.js';
import type { Currency } from '../../lib/money.js';

export interface Account {
  id: string;
  kind: 'WALLET' | 'SYSTEM';
  code: string | null;
  ownerRef: string | null;
  name: string;
  currency: Currency;
  balance: number;
  status: 'ACTIVE' | 'FROZEN';
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface StatementEntry extends Entry {
  transactionId: string;
  transactionType: string;
  description: string | null;
}

export interface AccountFilters extends PaginationQuery {
  kind?: 'WALLET' | 'SYSTEM';
  currency?: Currency;
  ownerRef?: string;
  search?: string;
}

const ACCOUNT_COLUMNS = `
  id, kind, code, owner_ref AS "ownerRef", name, currency, balance, status, metadata,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export interface NewWallet {
  name: string;
  ownerRef?: string;
  currency: Currency;
  metadata: Record<string, unknown>;
}

export const accountRepository = {
  async insertWallet(db: Queryable, wallet: NewWallet): Promise<Account> {
    const { rows } = await db.query<Account>(
      `INSERT INTO accounts (kind, name, owner_ref, currency, metadata)
       VALUES ('WALLET', $1, $2, $3, $4)
       RETURNING ${ACCOUNT_COLUMNS}`,
      [wallet.name, wallet.ownerRef ?? null, wallet.currency, JSON.stringify(wallet.metadata)],
    );
    return rows[0] as Account;
  },

  async findById(db: Queryable, id: string): Promise<Account | null> {
    const { rows } = await db.query<Account>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  },

  async findSystemAccount(
    db: Queryable,
    purpose: 'settlement' | 'holds',
    currency: Currency,
  ): Promise<Account> {
    const { rows } = await db.query<Account>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE code = $1`,
      [`${purpose}:${currency}`],
    );
    if (!rows[0])
      throw new Error(`System account ${purpose}:${currency} is missing; run migrations`);
    return rows[0];
  },

  async findMany(
    db: Queryable,
    filters: AccountFilters,
  ): Promise<{ items: Account[]; total: number }> {
    const where = new WhereBuilder()
      .addIf(filters.kind, 'kind = ?', filters.kind)
      .addIf(filters.currency, 'currency = ?', filters.currency)
      .addIf(filters.ownerRef, 'owner_ref = ?', filters.ownerRef)
      .addIf(filters.search, 'name ILIKE ?', `%${filters.search}%`);
    const countParams = [...where.params];
    const { skip, take } = toSkipTake(filters);
    const page = `LIMIT ${where.param(take)} OFFSET ${where.param(skip)}`;

    const [items, count] = await Promise.all([
      db.query<Account>(
        `SELECT ${ACCOUNT_COLUMNS} FROM accounts ${where.sql}
          ORDER BY kind DESC, created_at DESC ${page}`,
        where.params,
      ),
      db.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM accounts ${where.sql}`,
        countParams,
      ),
    ]);
    return { items: items.rows, total: count.rows[0]?.total ?? 0 };
  },

  async updateStatus(
    db: Queryable,
    id: string,
    status: Account['status'],
  ): Promise<Account | null> {
    const { rows } = await db.query<Account>(
      `UPDATE accounts SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
      [id, status],
    );
    return rows[0] ?? null;
  },

  async findStatement(
    db: Queryable,
    accountId: string,
    page: PaginationQuery,
  ): Promise<{ items: StatementEntry[]; total: number }> {
    const { skip, take } = toSkipTake(page);
    const [items, count] = await Promise.all([
      db.query<StatementEntry>(
        `SELECT e.id, e.account_id AS "accountId", e.amount, e.balance_after AS "balanceAfter",
                e.created_at AS "createdAt", e.transaction_id AS "transactionId",
                t.type AS "transactionType", t.description
           FROM entries e
           JOIN transactions t ON t.id = e.transaction_id
          WHERE e.account_id = $1
          ORDER BY e.id DESC
          LIMIT $2 OFFSET $3`,
        [accountId, take, skip],
      ),
      db.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM entries WHERE account_id = $1',
        [accountId],
      ),
    ]);
    return { items: items.rows, total: count.rows[0]?.total ?? 0 };
  },
};
