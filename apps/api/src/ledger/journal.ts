import type { DbClient } from '../db/pool.js';
import { BusinessRuleError, NotFoundError } from '../lib/errors.js';
import type { Currency } from '../lib/money.js';
import { enqueueEvent } from './outbox.js';

export const TRANSACTION_TYPES = [
  'DEPOSIT',
  'WITHDRAWAL',
  'TRANSFER',
  'REFUND',
  'HOLD',
  'HOLD_CAPTURE',
  'HOLD_RELEASE',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/** One line of a journal entry. Positive credits the account, negative debits it. */
export interface JournalLeg {
  accountId: string;
  amount: number;
}

export interface JournalInput {
  type: TransactionType;
  currency: Currency;
  /** Gross amount moved (positive). */
  amount: number;
  sourceAccountId: string;
  destinationAccountId: string;
  legs: JournalLeg[];
  parentTransactionId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface Entry {
  id: number;
  accountId: string;
  amount: number;
  balanceAfter: number;
  createdAt: Date;
}

export interface Transaction {
  id: string;
  type: TransactionType;
  currency: Currency;
  amount: number;
  refundedAmount: number;
  sourceAccountId: string;
  destinationAccountId: string;
  parentTransactionId: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface PostedTransaction extends Transaction {
  entries: Entry[];
}

export const TRANSACTION_COLUMNS = `
  id, type, currency, amount, refunded_amount AS "refundedAmount",
  source_account_id AS "sourceAccountId", destination_account_id AS "destinationAccountId",
  parent_transaction_id AS "parentTransactionId", description, metadata, created_at AS "createdAt"`;

interface LockedAccount {
  id: string;
  currency: string;
  balance: number;
  allowNegative: boolean;
  status: string;
}

/**
 * Pure double-entry check, run before touching the database.
 * The deferred trigger in the schema enforces the same rule at COMMIT.
 */
export function assertBalancedLegs(legs: readonly JournalLeg[]): void {
  if (legs.length < 2) throw new Error('A journal entry needs at least two legs');
  if (legs.some((leg) => !Number.isSafeInteger(leg.amount) || leg.amount === 0)) {
    throw new Error('Journal legs must be non-zero integers');
  }
  const total = legs.reduce((sum, leg) => sum + leg.amount, 0);
  if (total !== 0) throw new Error(`Journal legs must sum to zero (got ${total})`);
}

/** Net change per account, e.g. two legs on the same account collapse into one delta. */
export function netChangeByAccount(legs: readonly JournalLeg[]): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const leg of legs) deltas.set(leg.accountId, (deltas.get(leg.accountId) ?? 0) + leg.amount);
  return deltas;
}

/**
 * Locks the rows in a deterministic (id) order. Two concurrent transfers
 * A→B and B→A therefore lock in the same order and cannot deadlock.
 */
async function lockAccounts(
  client: DbClient,
  accountIds: string[],
): Promise<Map<string, LockedAccount>> {
  const { rows } = await client.query<LockedAccount>(
    `SELECT id, currency, balance, allow_negative AS "allowNegative", status
       FROM accounts
      WHERE id = ANY($1::uuid[])
      ORDER BY id
        FOR UPDATE`,
    [accountIds],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The single write path for money. Every operation (deposit, transfer, hold,
 * capture, refund…) is expressed as balanced legs and posted here, so the
 * locking, balance checks, audit trail and event publication live in one place.
 * Must be called inside a transaction.
 */
export async function postJournal(
  client: DbClient,
  input: JournalInput,
): Promise<PostedTransaction> {
  assertBalancedLegs(input.legs);

  const deltas = netChangeByAccount(input.legs);
  const accounts = await lockAccounts(client, [...deltas.keys()].sort());

  for (const [accountId, delta] of deltas) {
    const account = accounts.get(accountId);
    if (!account) throw new NotFoundError('Account', accountId);
    if (account.currency !== input.currency) {
      throw new BusinessRuleError(
        'CURRENCY_MISMATCH',
        `Account ${accountId} holds ${account.currency}, not ${input.currency}`,
      );
    }
    if (account.status !== 'ACTIVE') {
      throw new BusinessRuleError('ACCOUNT_FROZEN', `Account ${accountId} is frozen`);
    }
    if (!account.allowNegative && account.balance + delta < 0) {
      throw new BusinessRuleError(
        'INSUFFICIENT_FUNDS',
        `Insufficient funds in account ${accountId}`,
        {
          accountId,
          available: account.balance,
          required: -delta,
        },
      );
    }
  }

  const {
    rows: [transaction],
  } = await client.query<Transaction>(
    `INSERT INTO transactions
       (type, currency, amount, source_account_id, destination_account_id,
        parent_transaction_id, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${TRANSACTION_COLUMNS}`,
    [
      input.type,
      input.currency,
      input.amount,
      input.sourceAccountId,
      input.destinationAccountId,
      input.parentTransactionId ?? null,
      input.description ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (!transaction) throw new Error('Failed to insert transaction');

  // Running balance per leg gives every entry an auditable balance_after.
  const running = new Map([...accounts].map(([id, account]) => [id, account.balance]));
  const balanceAfter = input.legs.map((leg) => {
    const next = (running.get(leg.accountId) ?? 0) + leg.amount;
    running.set(leg.accountId, next);
    return next;
  });

  const { rows: entries } = await client.query<Entry>(
    `INSERT INTO entries (transaction_id, account_id, amount, balance_after)
     SELECT $1, account_id, amount, balance_after
       FROM unnest($2::uuid[], $3::bigint[], $4::bigint[]) AS leg(account_id, amount, balance_after)
     RETURNING id, account_id AS "accountId", amount, balance_after AS "balanceAfter", created_at AS "createdAt"`,
    [
      transaction.id,
      input.legs.map((leg) => leg.accountId),
      input.legs.map((leg) => leg.amount),
      balanceAfter,
    ],
  );

  const changedIds = [...deltas.keys()];
  await client.query(
    `UPDATE accounts AS a
        SET balance = v.balance, updated_at = now()
       FROM unnest($1::uuid[], $2::bigint[]) AS v(id, balance)
      WHERE a.id = v.id`,
    [changedIds, changedIds.map((id) => running.get(id))],
  );

  const posted: PostedTransaction = { ...transaction, entries };
  await enqueueEvent(client, {
    aggregateType: 'transaction',
    aggregateId: transaction.id,
    eventType: 'transaction.posted',
    payload: posted,
  });

  return posted;
}
