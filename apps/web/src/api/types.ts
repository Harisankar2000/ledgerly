/** Mirrors the API's JSON responses. Amounts are integers in minor units. */

export type Currency = 'INR' | 'USD';

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Account {
  id: string;
  kind: 'WALLET' | 'SYSTEM';
  code: string | null;
  ownerRef: string | null;
  name: string;
  currency: Currency;
  balance: number;
  status: 'ACTIVE' | 'FROZEN';
  createdAt: string;
}

export type TransactionType =
  'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'REFUND' | 'HOLD' | 'HOLD_CAPTURE' | 'HOLD_RELEASE';

export interface Entry {
  id: number;
  accountId: string;
  amount: number;
  balanceAfter: number;
  createdAt: string;
}

export interface StatementEntry extends Entry {
  transactionId: string;
  transactionType: TransactionType;
  description: string | null;
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
  createdAt: string;
}

export interface TransactionDetail extends Transaction {
  entries: Entry[];
  refunds: Transaction[];
}

export type HoldStatus = 'ACTIVE' | 'CAPTURED' | 'RELEASED' | 'EXPIRED';

export interface Hold {
  id: string;
  accountId: string;
  currency: Currency;
  amount: number;
  capturedAmount: number;
  status: HoldStatus;
  description: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  eventTypes: string[];
  isActive: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string;
  deliveredAt: string | null;
  createdAt: string;
}

export interface ReconciliationCheck {
  name: string;
  description: string;
  passed: boolean;
  discrepancies: unknown[];
}

export interface ReconciliationRun {
  id: string;
  status: 'BALANCED' | 'MISMATCH';
  createdAt: string;
  report: {
    checks: ReconciliationCheck[];
    totals: Array<{
      currency: Currency;
      walletBalance: number;
      settlementBalance: number;
      heldAmount: number;
    }>;
    outbox: { unpublished: number; oldestUnpublishedSeconds: number | null };
  };
}

export interface Overview {
  wallets: Array<{ currency: Currency; wallets: number; balance: number }>;
  last24h: Array<{ type: TransactionType; currency: Currency; count: number; volume: number }>;
  activeHolds: { active: number; amount: number };
  webhookDeliveries: Partial<Record<'PENDING' | 'SUCCEEDED' | 'FAILED', number>>;
}
