import type { Queryable } from '../../db/pool.js';
import { WhereBuilder } from '../../db/sql.js';
import { toSkipTake } from '../../lib/pagination.js';
import type { Currency } from '../../lib/money.js';
import type { ListHoldsQuery } from './hold.schemas.js';

export type HoldStatus = 'ACTIVE' | 'CAPTURED' | 'RELEASED' | 'EXPIRED';

export interface Hold {
  id: string;
  accountId: string;
  holdTransactionId: string;
  currency: Currency;
  amount: number;
  capturedAmount: number;
  status: HoldStatus;
  description: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const HOLD_COLUMNS = `
  id, account_id AS "accountId", hold_transaction_id AS "holdTransactionId", currency, amount,
  captured_amount AS "capturedAmount", status, description, expires_at AS "expiresAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export interface NewHold {
  accountId: string;
  holdTransactionId: string;
  currency: Currency;
  amount: number;
  description?: string;
  expiresInSeconds: number;
}

export const holdRepository = {
  async insert(db: Queryable, hold: NewHold): Promise<Hold> {
    const { rows } = await db.query<Hold>(
      `INSERT INTO holds (account_id, hold_transaction_id, currency, amount, description, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
       RETURNING ${HOLD_COLUMNS}`,
      [
        hold.accountId,
        hold.holdTransactionId,
        hold.currency,
        hold.amount,
        hold.description ?? null,
        hold.expiresInSeconds,
      ],
    );
    return rows[0] as Hold;
  },

  async findById(db: Queryable, id: string, { forUpdate = false } = {}): Promise<Hold | null> {
    const { rows } = await db.query<Hold>(
      `SELECT ${HOLD_COLUMNS} FROM holds WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ?? null;
  },

  async markFinished(
    db: Queryable,
    id: string,
    status: HoldStatus,
    capturedAmount = 0,
  ): Promise<Hold> {
    const { rows } = await db.query<Hold>(
      `UPDATE holds SET status = $2, captured_amount = $3, updated_at = now()
        WHERE id = $1 RETURNING ${HOLD_COLUMNS}`,
      [id, status, capturedAmount],
    );
    return rows[0] as Hold;
  },

  /** Claims expired holds; SKIP LOCKED lets several sweepers run without double-releasing. */
  async lockExpired(db: Queryable, limit: number): Promise<Hold[]> {
    const { rows } = await db.query<Hold>(
      `SELECT ${HOLD_COLUMNS} FROM holds
        WHERE status = 'ACTIVE' AND expires_at <= now()
        ORDER BY expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows;
  },

  async findMany(db: Queryable, query: ListHoldsQuery): Promise<{ items: Hold[]; total: number }> {
    const where = new WhereBuilder()
      .addIf(query.status, 'status = ?', query.status)
      .addIf(query.accountId, 'account_id = ?', query.accountId);
    const countParams = [...where.params];
    const { skip, take } = toSkipTake(query);
    const page = `LIMIT ${where.param(take)} OFFSET ${where.param(skip)}`;

    const [items, count] = await Promise.all([
      db.query<Hold>(
        `SELECT ${HOLD_COLUMNS} FROM holds ${where.sql} ORDER BY created_at DESC ${page}`,
        where.params,
      ),
      db.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM holds ${where.sql}`,
        countParams,
      ),
    ]);
    return { items: items.rows, total: count.rows[0]?.total ?? 0 };
  },
};
