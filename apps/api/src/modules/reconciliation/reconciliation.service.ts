import type { Pool, Queryable } from '../../db/pool.js';

export interface ReconciliationCheck {
  name: string;
  description: string;
  passed: boolean;
  discrepancies: unknown[];
}

export interface ReconciliationReport {
  status: 'BALANCED' | 'MISMATCH';
  generatedAt: string;
  checks: ReconciliationCheck[];
  totals: Array<{
    currency: string;
    walletBalance: number;
    settlementBalance: number;
    heldAmount: number;
  }>;
  outbox: { unpublished: number; oldestUnpublishedSeconds: number | null };
}

export interface ReconciliationRun {
  id: string;
  status: ReconciliationReport['status'];
  report: ReconciliationReport;
  createdAt: Date;
}

interface CheckDefinition {
  name: string;
  description: string;
  /** Returns the offending rows; an empty result means the check passed. */
  sql: string;
}

/**
 * Each check is an independent SQL query that should return zero rows.
 * Several of them are also enforced by constraints, but reconciliation proves
 * the invariants hold on the data itself, which is what auditors ask for.
 */
const CHECKS: CheckDefinition[] = [
  {
    name: 'journal_balanced',
    description: 'Every transaction’s entries sum to zero (double-entry)',
    sql: `SELECT transaction_id AS "transactionId", SUM(amount)::bigint AS total
            FROM entries GROUP BY transaction_id HAVING SUM(amount) <> 0 LIMIT 50`,
  },
  {
    name: 'balances_match_entries',
    description: 'Each cached account balance equals the sum of its ledger entries',
    sql: `SELECT a.id AS "accountId", a.balance, COALESCE(SUM(e.amount), 0)::bigint AS "ledgerBalance"
            FROM accounts a LEFT JOIN entries e ON e.account_id = a.id
           GROUP BY a.id HAVING a.balance <> COALESCE(SUM(e.amount), 0) LIMIT 50`,
  },
  {
    name: 'currency_zero_sum',
    description: 'All balances in a currency sum to zero (money is never created or destroyed)',
    sql: `SELECT currency, SUM(balance)::bigint AS total FROM accounts GROUP BY currency HAVING SUM(balance) <> 0`,
  },
  {
    name: 'holds_match_suspense',
    description: 'Hold suspense balance equals the total of active holds',
    sql: `SELECT a.currency, a.balance AS "suspenseBalance", COALESCE(h.active, 0)::bigint AS "activeHolds"
            FROM accounts a
            LEFT JOIN (SELECT currency, SUM(amount) AS active FROM holds WHERE status = 'ACTIVE' GROUP BY currency) h
              ON h.currency = a.currency
           WHERE a.code LIKE 'holds:%' AND a.balance <> COALESCE(h.active, 0)`,
  },
  {
    name: 'refunds_match_parent',
    description: 'Refunded amount on each transaction equals the sum of its refunds',
    sql: `SELECT t.id AS "transactionId", t.refunded_amount AS "refundedAmount",
                 COALESCE(SUM(r.amount), 0)::bigint AS "refundTotal"
            FROM transactions t
            LEFT JOIN transactions r ON r.parent_transaction_id = t.id AND r.type = 'REFUND'
           GROUP BY t.id HAVING t.refunded_amount <> COALESCE(SUM(r.amount), 0) LIMIT 50`,
  },
];

/** Sequential on purpose: a single pg client runs one query at a time. */
async function runChecks(db: Queryable): Promise<ReconciliationCheck[]> {
  const results: ReconciliationCheck[] = [];
  for (const { name, description, sql } of CHECKS) {
    const { rows } = await db.query(sql);
    results.push({ name, description, passed: rows.length === 0, discrepancies: rows });
  }
  return results;
}

export function createReconciliationService(pool: Pool) {
  return {
    async buildReport(): Promise<ReconciliationReport> {
      // REPEATABLE READ gives every check the same snapshot, so concurrent
      // transfers cannot produce a false mismatch between two queries.
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const checks = await runChecks(client);
        const totals = await client.query<ReconciliationReport['totals'][number]>(
          `SELECT currency,
                    COALESCE(SUM(balance) FILTER (WHERE kind = 'WALLET'), 0)::bigint AS "walletBalance",
                    COALESCE(SUM(balance) FILTER (WHERE code LIKE 'settlement:%'), 0)::bigint AS "settlementBalance",
                    COALESCE(SUM(balance) FILTER (WHERE code LIKE 'holds:%'), 0)::bigint AS "heldAmount"
               FROM accounts GROUP BY currency ORDER BY currency`,
        );
        const outbox = await client.query<ReconciliationReport['outbox']>(
          `SELECT count(*)::int AS unpublished,
                  EXTRACT(EPOCH FROM now() - min(created_at))::int AS "oldestUnpublishedSeconds"
             FROM outbox_events WHERE published_at IS NULL`,
        );
        await client.query('COMMIT');

        return {
          status: checks.every((check) => check.passed) ? 'BALANCED' : 'MISMATCH',
          generatedAt: new Date().toISOString(),
          checks,
          totals: totals.rows,
          outbox: outbox.rows[0] ?? { unpublished: 0, oldestUnpublishedSeconds: null },
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async run(): Promise<ReconciliationRun> {
      const report = await this.buildReport();
      const { rows } = await pool.query<ReconciliationRun>(
        `INSERT INTO reconciliation_runs (status, report) VALUES ($1, $2)
         RETURNING id, status, report, created_at AS "createdAt"`,
        [report.status, JSON.stringify(report)],
      );
      return rows[0] as ReconciliationRun;
    },

    async listRuns(limit = 20): Promise<ReconciliationRun[]> {
      const { rows } = await pool.query<ReconciliationRun>(
        `SELECT id, status, report, created_at AS "createdAt"
           FROM reconciliation_runs ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return rows;
    },

    /** Headline numbers for the dashboard. */
    async overview() {
      const [wallets, volume, holds, webhooks] = await Promise.all([
        pool.query<{ currency: string; wallets: number; balance: number }>(
          `SELECT currency, count(*)::int AS wallets, COALESCE(SUM(balance), 0)::bigint AS balance
             FROM accounts WHERE kind = 'WALLET' GROUP BY currency ORDER BY currency`,
        ),
        pool.query<{ type: string; currency: string; count: number; volume: number }>(
          `SELECT type, currency, count(*)::int AS count, SUM(amount)::bigint AS volume
             FROM transactions WHERE created_at > now() - interval '24 hours'
            GROUP BY type, currency ORDER BY type`,
        ),
        pool.query<{ active: number; amount: number }>(
          `SELECT count(*)::int AS active, COALESCE(SUM(amount), 0)::bigint AS amount
             FROM holds WHERE status = 'ACTIVE'`,
        ),
        pool.query<{ status: string; count: number }>(
          `SELECT status, count(*)::int AS count FROM webhook_deliveries GROUP BY status`,
        ),
      ]);
      return {
        wallets: wallets.rows,
        last24h: volume.rows,
        activeHolds: holds.rows[0] ?? { active: 0, amount: 0 },
        webhookDeliveries: Object.fromEntries(webhooks.rows.map((row) => [row.status, row.count])),
      };
    },
  };
}

export type ReconciliationService = ReturnType<typeof createReconciliationService>;
