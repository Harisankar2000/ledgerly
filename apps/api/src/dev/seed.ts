/**
 * Seeds demo data: wallets, deposits, payments, a refund, holds and a webhook
 * endpoint pointing at the demo sink. Safe to run more than once.
 */
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { createContainer } from '../container.js';
import { runMigrations } from '../db/migrate.js';
import { createLogger } from '../lib/logger.js';
import { generateWebhookSecret } from '../workers/webhook-signature.js';
import { webhookRepository } from '../modules/webhooks/webhook.repository.js';

const env = loadEnv();
const logger = createLogger({ name: 'seed', level: 'warn', pretty: false });
const container = createContainer(env, logger);
const { accounts, transactions, holds } = container;
const key = () => randomUUID();
const rupees = (value: number) => value * 100;

try {
  await runMigrations(container.pool);

  const wallet = (name: string, ownerRef: string, currency: 'INR' | 'USD' = 'INR') =>
    accounts.createWallet({ name, ownerRef, currency, metadata: { seeded: true } });

  const asha = await wallet('Asha Verma', 'user_asha');
  const rahul = await wallet('Rahul Mehta', 'user_rahul');
  const priya = await wallet('Priya Nair', 'user_priya');
  const chaiPoint = await wallet('Chai Point (merchant)', 'merchant_chaipoint');
  const bookStore = await wallet('Sapna Book Store (merchant)', 'merchant_sapna');
  const john = await wallet('John Carter', 'user_john', 'USD');

  await transactions.deposit(
    { accountId: asha.id, amount: rupees(25_000), description: 'UPI top-up', metadata: {} },
    key(),
  );
  await transactions.deposit(
    { accountId: rahul.id, amount: rupees(8_000), description: 'Card top-up', metadata: {} },
    key(),
  );
  await transactions.deposit(
    {
      accountId: priya.id,
      amount: rupees(12_500),
      description: 'Net banking top-up',
      metadata: {},
    },
    key(),
  );
  await transactions.deposit(
    { accountId: john.id, amount: 50_000, description: 'ACH top-up', metadata: {} },
    key(),
  );

  const pay = (from: string, to: string, amount: number, description: string) =>
    transactions.transfer(
      { sourceAccountId: from, destinationAccountId: to, amount, description, metadata: {} },
      key(),
    );

  await pay(asha.id, chaiPoint.id, rupees(240), 'Masala chai x4');
  await pay(rahul.id, chaiPoint.id, rupees(180), 'Ginger chai + samosa');
  const books = await pay(priya.id, bookStore.id, rupees(1_850), 'Books order #1042');
  await pay(asha.id, rahul.id, rupees(2_000), 'Dinner split');
  await transactions.refund(
    books.body.id,
    { amount: rupees(450), reason: 'One book out of stock' },
    key(),
  );
  await transactions.withdraw(
    {
      accountId: chaiPoint.id,
      amount: rupees(300),
      description: 'Settlement to bank',
      metadata: {},
    },
    key(),
  );

  const cabHold = await holds.create(
    {
      accountId: rahul.id,
      amount: rupees(600),
      expiresInSeconds: 3_600,
      description: 'Cab ride pre-auth',
    },
    key(),
  );
  await holds.capture(
    cabHold.body.hold.id,
    { destinationAccountId: chaiPoint.id, amount: rupees(420) },
    key(),
  );
  await holds.create(
    {
      accountId: asha.id,
      amount: rupees(1_500),
      expiresInSeconds: 7_200,
      description: 'Hotel booking pre-auth',
    },
    key(),
  );

  const sinkUrl = process.env.SEED_WEBHOOK_URL ?? 'http://localhost:4000/webhooks';
  await webhookRepository.insertEndpoint(container.pool, {
    url: sinkUrl,
    secret: generateWebhookSecret(),
    eventTypes: ['*'],
  });

  process.stdout.write(
    `Seeded 6 wallets, payments, a refund, holds and a webhook endpoint (${sinkUrl})\n`,
  );
} finally {
  await container.dispose();
}
