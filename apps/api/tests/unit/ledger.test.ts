import { describe, expect, it } from 'vitest';
import { WhereBuilder } from '../../src/db/sql.js';
import { hashRequest, stableStringify } from '../../src/ledger/idempotency.js';
import { assertBalancedLegs, netChangeByAccount } from '../../src/ledger/journal.js';
import { formatMinor } from '../../src/lib/money.js';
import { toEnvelope, toMessage } from '../../src/workers/outbox-relay.js';

describe('assertBalancedLegs', () => {
  it('accepts legs that sum to zero', () => {
    expect(() =>
      assertBalancedLegs([
        { accountId: 'a', amount: -500 },
        { accountId: 'b', amount: 300 },
        { accountId: 'c', amount: 200 },
      ]),
    ).not.toThrow();
  });

  it('rejects unbalanced, single-leg, zero and fractional legs', () => {
    expect(() =>
      assertBalancedLegs([
        { accountId: 'a', amount: -1 },
        { accountId: 'b', amount: 2 },
      ]),
    ).toThrow('sum to zero');
    expect(() => assertBalancedLegs([{ accountId: 'a', amount: 0 }])).toThrow('at least two legs');
    expect(() =>
      assertBalancedLegs([
        { accountId: 'a', amount: 0 },
        { accountId: 'b', amount: 0 },
      ]),
    ).toThrow('non-zero integers');
    expect(() =>
      assertBalancedLegs([
        { accountId: 'a', amount: 0.5 },
        { accountId: 'b', amount: -0.5 },
      ]),
    ).toThrow('non-zero integers');
  });
});

describe('netChangeByAccount', () => {
  it('collapses multiple legs on the same account', () => {
    const deltas = netChangeByAccount([
      { accountId: 'a', amount: -500 },
      { accountId: 'b', amount: 500 },
      { accountId: 'a', amount: 200 },
      { accountId: 'b', amount: -200 },
    ]);
    expect(Object.fromEntries(deltas)).toEqual({ a: -300, b: 300 });
  });
});

describe('request hashing', () => {
  it('is independent of key order and ignores undefined values', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(hashRequest({ amount: 100, accountId: 'x' })).toBe(
      hashRequest({ accountId: 'x', amount: 100 }),
    );
    expect(hashRequest({ amount: 100 })).not.toBe(hashRequest({ amount: 101 }));
  });
});

describe('WhereBuilder', () => {
  it('binds every value as a numbered placeholder and skips empty filters', () => {
    const where = new WhereBuilder()
      .addIf('INR', 'currency = ?', 'INR')
      .addIf(undefined, 'type = ?', 'X')
      .add('(source = ? OR destination = ?)', 'a1', 'a1');
    const limit = where.param(20);

    expect(where.sql).toBe('WHERE currency = $1 AND (source = $2 OR destination = $3)');
    expect(limit).toBe('$4');
    expect(where.params).toEqual(['INR', 'a1', 'a1', 20]);
  });

  it('produces no WHERE clause without conditions', () => {
    expect(new WhereBuilder().sql).toBe('');
  });
});

describe('formatMinor', () => {
  it('formats minor units without floating point surprises in the input', () => {
    expect(formatMinor(123456, 'INR')).toBe('₹1,234.56');
    expect(formatMinor(5, 'USD')).toBe('$0.05');
  });
});

describe('outbox message mapping', () => {
  const row = {
    id: 7,
    eventId: 'evt-1',
    aggregateType: 'transaction',
    aggregateId: 'txn-1',
    eventType: 'transaction.posted',
    payload: { amount: 100 },
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('keys messages by aggregate id and wraps the payload in an envelope', () => {
    const message = toMessage(row);

    expect(message.key).toBe('txn-1');
    expect(message.headers).toEqual({ 'event-id': 'evt-1', 'event-type': 'transaction.posted' });
    expect(JSON.parse(message.value)).toEqual(toEnvelope(row));
    expect(toEnvelope(row)).toMatchObject({
      id: 'evt-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      data: { amount: 100 },
    });
  });
});
