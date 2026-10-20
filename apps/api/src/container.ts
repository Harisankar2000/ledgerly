import { Redis } from 'ioredis';
import type { Env } from './config/env.js';
import { createPool, type Pool } from './db/pool.js';
import type { Logger } from './lib/logger.js';
import { createAccountService, type AccountService } from './modules/accounts/account.service.js';
import { createHoldService, type HoldService } from './modules/holds/hold.service.js';
import {
  createReconciliationService,
  type ReconciliationService,
} from './modules/reconciliation/reconciliation.service.js';
import {
  createTransactionService,
  type TransactionService,
} from './modules/transactions/transaction.service.js';

export interface Container {
  env: Env;
  logger: Logger;
  pool: Pool;
  redis: Redis;
  accounts: AccountService;
  transactions: TransactionService;
  holds: HoldService;
  reconciliation: ReconciliationService;
  dispose(): Promise<void>;
}

/** Composition root: wires concrete implementations together in one place. */
export function createContainer(env: Env, logger: Logger): Container {
  const pool = createPool(env.DATABASE_URL, env.DATABASE_POOL_SIZE);
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });

  return {
    env,
    logger,
    pool,
    redis,
    accounts: createAccountService(pool),
    transactions: createTransactionService(pool, logger.child({ component: 'transactions' })),
    holds: createHoldService(pool, logger.child({ component: 'holds' })),
    reconciliation: createReconciliationService(pool),
    async dispose() {
      redis.disconnect();
      await pool.end();
    },
  };
}
