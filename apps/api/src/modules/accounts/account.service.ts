import { withTransaction, type Pool } from '../../db/pool.js';
import { enqueueEvent } from '../../ledger/outbox.js';
import { NotFoundError } from '../../lib/errors.js';
import { buildPage, type Page, type PaginationQuery } from '../../lib/pagination.js';
import {
  accountRepository,
  type Account,
  type AccountFilters,
  type StatementEntry,
} from './account.repository.js';
import type { CreateWalletBody } from './account.schemas.js';

export interface AccountService {
  createWallet(body: CreateWalletBody): Promise<Account>;
  get(id: string): Promise<Account>;
  list(filters: AccountFilters): Promise<Page<Account>>;
  statement(id: string, page: PaginationQuery): Promise<Page<StatementEntry>>;
  setStatus(id: string, status: Account['status']): Promise<Account>;
}

export function createAccountService(pool: Pool): AccountService {
  async function get(id: string): Promise<Account> {
    const account = await accountRepository.findById(pool, id);
    if (!account) throw new NotFoundError('Account', id);
    return account;
  }

  return {
    get,

    createWallet: (body) =>
      withTransaction(pool, async (client) => {
        const account = await accountRepository.insertWallet(client, body);
        await enqueueEvent(client, {
          aggregateType: 'account',
          aggregateId: account.id,
          eventType: 'account.created',
          payload: account,
        });
        return account;
      }),

    async list(filters) {
      const { items, total } = await accountRepository.findMany(pool, filters);
      return buildPage(items, total, filters);
    },

    async statement(id, page) {
      await get(id);
      const { items, total } = await accountRepository.findStatement(pool, id, page);
      return buildPage(items, total, page);
    },

    setStatus: (id, status) =>
      withTransaction(pool, async (client) => {
        const account = await accountRepository.updateStatus(client, id, status);
        if (!account) throw new NotFoundError('Account', id);
        await enqueueEvent(client, {
          aggregateType: 'account',
          aggregateId: id,
          eventType: 'account.status_changed',
          payload: { id, status },
        });
        return account;
      }),
  };
}
