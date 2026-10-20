/**
 * Ledger correctness under concurrency, against a real PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiClient,
  createTestContext,
  resetDatabase,
  type ApiClient,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let api: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  api = apiClient(ctx.app);
});
afterAll(() => ctx.close());
beforeEach(() => resetDatabase(ctx.container.pool));

describe('money movement', () => {
  it('deposits, transfers and withdraws with a balanced journal', async () => {
    const asha = await api.createWallet('Asha');
    const rahul = await api.createWallet('Rahul');

    await api.deposit(asha, 10_000);
    const transfer = await api.transfer(asha, rahul, 2_500);
    await api.call('POST', '/withdrawals', { accountId: rahul, amount: 500 });

    expect(transfer.status).toBe(201);
    expect(await api.balance(asha)).toBe(7_500);
    expect(await api.balance(rahul)).toBe(2_000);

    const detail = await api.call<{
      entries: Array<{ accountId: string; amount: number; balanceAfter: number }>;
    }>('GET', `/transactions/${transfer.body.id}`);
    expect(detail.body.entries).toEqual([
      expect.objectContaining({ accountId: asha, amount: -2_500, balanceAfter: 7_500 }),
      expect.objectContaining({ accountId: rahul, amount: 2_500, balanceAfter: 2_500 }),
    ]);
    expect((await api.reconcile()).status).toBe('BALANCED');
  });

  it('rejects overdrafts with INSUFFICIENT_FUNDS and leaves balances untouched', async () => {
    const asha = await api.createWallet('Asha');
    const rahul = await api.createWallet('Rahul');
    await api.deposit(asha, 1_000);

    const result = await api.transfer(asha, rahul, 1_001);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      error: { code: 'INSUFFICIENT_FUNDS', details: { available: 1_000, required: 1_001 } },
    });
    expect(await api.balance(asha)).toBe(1_000);
  });

  it('rejects cross-currency transfers and frozen accounts', async () => {
    const inr = await api.createWallet('INR wallet', 'INR');
    const usd = await api.createWallet('USD wallet', 'USD');
    const other = await api.createWallet('Other');
    await api.deposit(inr, 1_000);

    expect((await api.transfer(inr, usd, 100)).body).toMatchObject({
      error: { code: 'CURRENCY_MISMATCH' },
    });

    await api.call('PATCH', `/accounts/${inr}/status`, { status: 'FROZEN' });
    expect((await api.transfer(inr, other, 100)).body).toMatchObject({
      error: { code: 'ACCOUNT_FROZEN' },
    });
  });
});

describe('concurrency', () => {
  it('never overdraws when 50 transfers race for the same balance', async () => {
    const payer = await api.createWallet('Payer');
    const payee = await api.createWallet('Payee');
    await api.deposit(payer, 1_000);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => api.transfer(payer, payee, 100)),
    );

    const succeeded = results.filter((result) => result.status === 201);
    const rejected = results.filter((result) => result.body.error?.code === 'INSUFFICIENT_FUNDS');
    expect(succeeded).toHaveLength(10);
    expect(rejected).toHaveLength(40);
    expect(await api.balance(payer)).toBe(0);
    expect(await api.balance(payee)).toBe(1_000);
    expect((await api.reconcile()).status).toBe('BALANCED');
  });

  it('does not deadlock on opposite-direction transfers (A→B and B→A at once)', async () => {
    const a = await api.createWallet('A');
    const b = await api.createWallet('B');
    await api.deposit(a, 100_000);
    await api.deposit(b, 100_000);

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0 ? api.transfer(a, b, 10) : api.transfer(b, a, 7),
      ),
    );

    expect(results.every((result) => result.status === 201)).toBe(true);
    expect(await api.balance(a)).toBe(100_000 - 20 * 10 + 20 * 7);
    expect(await api.balance(b)).toBe(100_000 + 20 * 10 - 20 * 7);
    expect((await api.reconcile()).status).toBe('BALANCED');
  });
});

describe('idempotency', () => {
  it('executes concurrent duplicates once and replays the stored response', async () => {
    const payer = await api.createWallet('Payer');
    const payee = await api.createWallet('Payee');
    await api.deposit(payer, 10_000);
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => api.transfer(payer, payee, 1_000, key)),
    );

    expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
    expect(results.every((result) => result.status === 201)).toBe(true);
    expect(
      results.filter((result) => result.headers['idempotent-replayed'] === 'false'),
    ).toHaveLength(1);
    expect(await api.balance(payer)).toBe(9_000);
  });

  it('rejects reuse of a key with a different body', async () => {
    const payer = await api.createWallet('Payer');
    const payee = await api.createWallet('Payee');
    await api.deposit(payer, 10_000);
    const key = randomUUID();

    await api.transfer(payer, payee, 100, key);
    const reused = await api.transfer(payer, payee, 200, key);

    expect(reused.status).toBe(422);
    expect(reused.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('lets a client retry with the same key after a business error', async () => {
    const payer = await api.createWallet('Payer');
    const payee = await api.createWallet('Payee');
    const key = randomUUID();

    expect((await api.transfer(payer, payee, 500, key)).status).toBe(422);
    await api.deposit(payer, 500);
    expect((await api.transfer(payer, payee, 500, key)).status).toBe(201);
  });

  it('requires an Idempotency-Key on money-moving requests', async () => {
    const wallet = await api.createWallet('Asha');
    const result = await api.call('POST', '/deposits', { accountId: wallet, amount: 100 }, null);

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('refunds', () => {
  it('supports partial refunds up to the original amount, then rejects', async () => {
    const customer = await api.createWallet('Customer');
    const merchant = await api.createWallet('Merchant');
    await api.deposit(customer, 5_000);
    const payment = await api.transfer(customer, merchant, 3_000);

    const first = await api.call('POST', `/transactions/${payment.body.id}/refunds`, {
      amount: 1_000,
    });
    const rest = await api.call('POST', `/transactions/${payment.body.id}/refunds`, {});
    const extra = await api.call('POST', `/transactions/${payment.body.id}/refunds`, { amount: 1 });

    expect(first.status).toBe(201);
    expect(rest.body).toMatchObject({ type: 'REFUND', amount: 2_000 });
    expect(extra.body).toMatchObject({ error: { code: 'ALREADY_REFUNDED' } });
    expect(await api.balance(customer)).toBe(5_000);
    expect(await api.balance(merchant)).toBe(0);
  });

  it('serialises concurrent refunds so the total never exceeds the payment', async () => {
    const customer = await api.createWallet('Customer');
    const merchant = await api.createWallet('Merchant');
    await api.deposit(customer, 1_000);
    const payment = await api.transfer(customer, merchant, 1_000);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        api.call('POST', `/transactions/${payment.body.id}/refunds`, { amount: 300 }),
      ),
    );

    expect(results.filter((result) => result.status === 201)).toHaveLength(3);
    expect(await api.balance(customer)).toBe(900);
    expect((await api.reconcile()).status).toBe('BALANCED');
  });
});

describe('holds', () => {
  it('reserves funds, captures part of them and releases the rest', async () => {
    const customer = await api.createWallet('Customer');
    const merchant = await api.createWallet('Merchant');
    await api.deposit(customer, 10_000);

    const created = await api.call<{ hold: { id: string } }>('POST', '/holds', {
      accountId: customer,
      amount: 4_000,
    });
    expect(await api.balance(customer)).toBe(6_000);

    const captured = await api.call<{
      hold: { status: string; capturedAmount: number };
      transactions: unknown[];
    }>('POST', `/holds/${created.body.hold.id}/capture`, {
      destinationAccountId: merchant,
      amount: 3_000,
    });

    expect(captured.body.hold).toMatchObject({ status: 'CAPTURED', capturedAmount: 3_000 });
    expect(captured.body.transactions).toHaveLength(2);
    expect(await api.balance(customer)).toBe(7_000);
    expect(await api.balance(merchant)).toBe(3_000);
    expect((await api.reconcile()).status).toBe('BALANCED');
  });

  it('releases a hold and refuses to capture it afterwards', async () => {
    const customer = await api.createWallet('Customer');
    const merchant = await api.createWallet('Merchant');
    await api.deposit(customer, 1_000);
    const created = await api.call<{ hold: { id: string } }>('POST', '/holds', {
      accountId: customer,
      amount: 1_000,
    });

    await api.call('POST', `/holds/${created.body.hold.id}/release`);
    const capture = await api.call('POST', `/holds/${created.body.hold.id}/capture`, {
      destinationAccountId: merchant,
    });

    expect(await api.balance(customer)).toBe(1_000);
    expect(capture.body).toMatchObject({ error: { code: 'HOLD_NOT_ACTIVE' } });
  });

  it('expires holds past their deadline and returns the money', async () => {
    const customer = await api.createWallet('Customer');
    await api.deposit(customer, 1_000);
    const created = await api.call<{ hold: { id: string } }>('POST', '/holds', {
      accountId: customer,
      amount: 600,
    });
    await ctx.container.pool.query(`UPDATE holds SET expires_at = now() - interval '1 second'`);

    expect(await ctx.container.holds.expireDue(10)).toBe(1);
    expect(await api.balance(customer)).toBe(1_000);
    expect((await api.call('GET', `/holds/${created.body.hold.id}`)).body).toMatchObject({
      status: 'EXPIRED',
    });
    expect((await api.reconcile()).status).toBe('BALANCED');
  });
});

describe('database guarantees', () => {
  it('rejects an unbalanced journal at COMMIT via the deferred trigger', async () => {
    const wallet = await api.createWallet('Asha');
    const client = await ctx.container.pool.connect();
    try {
      await client.query('BEGIN');
      const {
        rows: [txn],
      } = await client.query<{ id: string }>(
        `INSERT INTO transactions (type, currency, amount, source_account_id, destination_account_id)
         VALUES ('DEPOSIT', 'INR', 100, $1, $1) RETURNING id`,
        [wallet],
      );
      await client.query(
        `INSERT INTO entries (transaction_id, account_id, amount, balance_after) VALUES ($1, $2, 100, 100)`,
        [txn?.id, wallet],
      );
      await expect(client.query('COMMIT')).rejects.toThrow('unbalanced');
    } finally {
      client.release();
    }
  });

  it('keeps entries append-only and blocks negative wallet balances', async () => {
    const wallet = await api.createWallet('Asha');
    await api.deposit(wallet, 100);

    await expect(ctx.container.pool.query('UPDATE entries SET amount = 1')).rejects.toThrow(
      'append-only',
    );
    await expect(ctx.container.pool.query('DELETE FROM entries')).rejects.toThrow('append-only');
    await expect(
      ctx.container.pool.query('UPDATE accounts SET balance = -1 WHERE id = $1', [wallet]),
    ).rejects.toThrow('accounts_no_overdraft');
  });

  it('detects a tampered balance in reconciliation', async () => {
    const wallet = await api.createWallet('Asha');
    await api.deposit(wallet, 100);
    await ctx.container.pool.query('UPDATE accounts SET balance = 999 WHERE id = $1', [wallet]);

    const report = await api.reconcile();

    expect(report.status).toBe('MISMATCH');
    expect(
      report.report.checks.filter((check) => !check.passed).map((check) => check.name),
    ).toEqual(['balances_match_entries', 'currency_zero_sum']);
  });
});

describe('API contract', () => {
  it('requires an API key', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/accounts' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects fractional amounts', async () => {
    const wallet = await api.createWallet('Asha');
    const result = await api.call('POST', '/deposits', { accountId: wallet, amount: 10.5 });
    expect(result.status).toBe(400);
  });

  it('writes outbox events in the same transaction as ledger changes', async () => {
    const wallet = await api.createWallet('Asha');
    await api.deposit(wallet, 100);

    const { rows } = await ctx.container.pool.query<{ eventType: string }>(
      `SELECT event_type AS "eventType" FROM outbox_events ORDER BY id`,
    );
    expect(rows.map((row) => row.eventType)).toEqual(['account.created', 'transaction.posted']);
  });
});
