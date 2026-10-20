import { withTransaction, type DbClient, type Pool } from '../../db/pool.js';
import { postJournal, type PostedTransaction } from '../../ledger/journal.js';
import { executeIdempotent, type IdempotentResult } from '../../ledger/idempotency.js';
import { enqueueEvent, type LedgerEventType } from '../../ledger/outbox.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { buildPage, type Page } from '../../lib/pagination.js';
import { accountRepository } from '../accounts/account.repository.js';
import { holdRepository, type Hold, type HoldStatus } from './hold.repository.js';
import type { CaptureHoldBody, CreateHoldBody, ListHoldsQuery } from './hold.schemas.js';

export interface HoldResult {
  hold: Hold;
  transactions: PostedTransaction[];
}

export interface HoldService {
  create(body: CreateHoldBody, idempotencyKey: string): Promise<IdempotentResult<HoldResult>>;
  capture(
    holdId: string,
    body: CaptureHoldBody,
    idempotencyKey: string,
  ): Promise<IdempotentResult<HoldResult>>;
  release(holdId: string, idempotencyKey: string): Promise<IdempotentResult<HoldResult>>;
  /** Releases holds past their expiry. Returns how many were expired. */
  expireDue(limit: number): Promise<number>;
  get(id: string): Promise<Hold>;
  list(query: ListHoldsQuery): Promise<Page<Hold>>;
}

/**
 * Holds move money from the wallet into a per-currency "hold suspense" system
 * account. The payer's available balance drops immediately, and every step
 * (authorise, capture, release) is a normal balanced journal entry.
 */
export function createHoldService(pool: Pool, logger: Logger): HoldService {
  async function lockActiveHold(client: DbClient, holdId: string): Promise<Hold> {
    const hold = await holdRepository.findById(client, holdId, { forUpdate: true });
    if (!hold) throw new NotFoundError('Hold', holdId);
    if (hold.status !== 'ACTIVE')
      throw new BusinessRuleError('HOLD_NOT_ACTIVE', `Hold is already ${hold.status}`);
    return hold;
  }

  async function releaseToPayer(
    client: DbClient,
    hold: Hold,
    amount: number,
  ): Promise<PostedTransaction> {
    const suspense = await accountRepository.findSystemAccount(client, 'holds', hold.currency);
    return postJournal(client, {
      type: 'HOLD_RELEASE',
      currency: hold.currency,
      amount,
      sourceAccountId: suspense.id,
      destinationAccountId: hold.accountId,
      legs: [
        { accountId: suspense.id, amount: -amount },
        { accountId: hold.accountId, amount },
      ],
      parentTransactionId: hold.holdTransactionId,
      description: `Release of hold ${hold.id}`,
    });
  }

  async function finish(
    client: DbClient,
    hold: Hold,
    status: HoldStatus,
    eventType: LedgerEventType,
    capturedAmount = 0,
  ): Promise<Hold> {
    const updated = await holdRepository.markFinished(client, hold.id, status, capturedAmount);
    await enqueueEvent(client, {
      aggregateType: 'hold',
      aggregateId: hold.id,
      eventType,
      payload: updated,
    });
    return updated;
  }

  const idempotent = (
    scope: string,
    key: string,
    payload: unknown,
    statusCode: number,
    op: (client: DbClient) => Promise<HoldResult>,
  ) =>
    executeIdempotent(
      pool,
      { scope, key, payload },
      async (client) => ({ statusCode, body: await op(client) }),
      logger,
    );

  async function get(id: string): Promise<Hold> {
    const hold = await holdRepository.findById(pool, id);
    if (!hold) throw new NotFoundError('Hold', id);
    return hold;
  }

  return {
    get,

    create: (body, key) =>
      idempotent('hold', key, body, 201, async (client) => {
        const wallet = await accountRepository.findById(client, body.accountId);
        if (!wallet || wallet.kind !== 'WALLET') throw new NotFoundError('Wallet', body.accountId);
        const suspense = await accountRepository.findSystemAccount(
          client,
          'holds',
          wallet.currency,
        );

        const transaction = await postJournal(client, {
          type: 'HOLD',
          currency: wallet.currency,
          amount: body.amount,
          sourceAccountId: wallet.id,
          destinationAccountId: suspense.id,
          legs: [
            { accountId: wallet.id, amount: -body.amount },
            { accountId: suspense.id, amount: body.amount },
          ],
          description: body.description ?? 'Authorisation hold',
        });
        const hold = await holdRepository.insert(client, {
          accountId: wallet.id,
          holdTransactionId: transaction.id,
          currency: wallet.currency,
          amount: body.amount,
          description: body.description,
          expiresInSeconds: body.expiresInSeconds,
        });
        await enqueueEvent(client, {
          aggregateType: 'hold',
          aggregateId: hold.id,
          eventType: 'hold.created',
          payload: hold,
        });
        return { hold, transactions: [transaction] };
      }),

    capture: (holdId, body, key) =>
      idempotent(`capture:${holdId}`, key, body, 200, async (client) => {
        const hold = await lockActiveHold(client, holdId);
        if (hold.expiresAt <= new Date())
          throw new BusinessRuleError('HOLD_EXPIRED', 'Hold has expired');

        const captureAmount = body.amount ?? hold.amount;
        if (captureAmount > hold.amount) {
          throw new BusinessRuleError(
            'CAPTURE_EXCEEDS_HOLD',
            `At most ${hold.amount} can be captured`,
          );
        }
        const destination = await accountRepository.findById(client, body.destinationAccountId);
        if (!destination || destination.kind !== 'WALLET') {
          throw new NotFoundError('Wallet', body.destinationAccountId);
        }
        const suspense = await accountRepository.findSystemAccount(client, 'holds', hold.currency);

        const transactions = [
          await postJournal(client, {
            type: 'HOLD_CAPTURE',
            currency: hold.currency,
            amount: captureAmount,
            // Source is the original payer, so a later refund returns money to them.
            sourceAccountId: hold.accountId,
            destinationAccountId: destination.id,
            legs: [
              { accountId: suspense.id, amount: -captureAmount },
              { accountId: destination.id, amount: captureAmount },
            ],
            parentTransactionId: hold.holdTransactionId,
            description: `Capture of hold ${hold.id}`,
          }),
        ];
        const remainder = hold.amount - captureAmount;
        if (remainder > 0) transactions.push(await releaseToPayer(client, hold, remainder));

        return {
          hold: await finish(client, hold, 'CAPTURED', 'hold.captured', captureAmount),
          transactions,
        };
      }),

    release: (holdId, key) =>
      idempotent(`release:${holdId}`, key, { holdId }, 200, async (client) => {
        const hold = await lockActiveHold(client, holdId);
        const transaction = await releaseToPayer(client, hold, hold.amount);
        return {
          hold: await finish(client, hold, 'RELEASED', 'hold.released'),
          transactions: [transaction],
        };
      }),

    expireDue: (limit) =>
      withTransaction(
        pool,
        async (client) => {
          const expired = await holdRepository.lockExpired(client, limit);
          for (const hold of expired) {
            await releaseToPayer(client, hold, hold.amount);
            await finish(client, hold, 'EXPIRED', 'hold.expired');
          }
          return expired.length;
        },
        { logger },
      ),

    async list(query) {
      const { items, total } = await holdRepository.findMany(pool, query);
      return buildPage(items, total, query);
    },
  };
}
