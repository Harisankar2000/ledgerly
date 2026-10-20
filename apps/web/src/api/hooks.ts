/**
 * All server state goes through TanStack Query: components call a hook,
 * get `data / isLoading / error`, and mutations invalidate what they change.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import type {
  Account,
  Hold,
  Overview,
  Page,
  ReconciliationRun,
  StatementEntry,
  Transaction,
  TransactionDetail,
  WebhookDelivery,
  WebhookEndpoint,
} from './types';

/** Data that background workers change (webhooks, outbox) refreshes on its own. */
const LIVE_REFRESH_MS = 3_000;

export const queryKeys = {
  overview: ['overview'] as const,
  accounts: (filters: object) => ['accounts', filters] as const,
  account: (id: string) => ['accounts', id] as const,
  statement: (id: string, page: number) => ['accounts', id, 'entries', page] as const,
  transactions: (filters: object) => ['transactions', filters] as const,
  transaction: (id: string) => ['transactions', id] as const,
  holds: (filters: object) => ['holds', filters] as const,
  webhookEndpoints: ['webhook-endpoints'] as const,
  webhookDeliveries: (filters: object) => ['webhook-deliveries', filters] as const,
  reconciliationRuns: ['reconciliation-runs'] as const,
};

// ---- Queries ----------------------------------------------------------------

export const useOverview = () =>
  useQuery({
    queryKey: queryKeys.overview,
    queryFn: () => request<Overview>('/overview'),
    refetchInterval: LIVE_REFRESH_MS,
  });

export interface AccountFilters {
  kind?: 'WALLET' | 'SYSTEM';
  currency?: string;
  search?: string;
  page?: number;
}

export const useAccounts = (filters: AccountFilters = {}) =>
  useQuery({
    queryKey: queryKeys.accounts(filters),
    queryFn: () => request<Page<Account>>('/accounts', { query: { pageSize: 50, ...filters } }),
    placeholderData: keepPreviousData,
  });

export const useAccount = (id: string) =>
  useQuery({ queryKey: queryKeys.account(id), queryFn: () => request<Account>(`/accounts/${id}`) });

export const useStatement = (id: string, page: number) =>
  useQuery({
    queryKey: queryKeys.statement(id, page),
    queryFn: () =>
      request<Page<StatementEntry>>(`/accounts/${id}/entries`, { query: { page, pageSize: 15 } }),
    placeholderData: keepPreviousData,
  });

export interface TransactionFilters {
  type?: string;
  accountId?: string;
  page?: number;
}

export const useTransactions = (filters: TransactionFilters = {}) =>
  useQuery({
    queryKey: queryKeys.transactions(filters),
    queryFn: () =>
      request<Page<Transaction>>('/transactions', { query: { pageSize: 15, ...filters } }),
    placeholderData: keepPreviousData,
  });

export const useTransaction = (id: string | null) =>
  useQuery({
    queryKey: queryKeys.transaction(id ?? ''),
    queryFn: () => request<TransactionDetail>(`/transactions/${id}`),
    enabled: id !== null,
  });

export const useHolds = (filters: { status?: string; page?: number } = {}) =>
  useQuery({
    queryKey: queryKeys.holds(filters),
    queryFn: () => request<Page<Hold>>('/holds', { query: { pageSize: 15, ...filters } }),
    placeholderData: keepPreviousData,
    refetchInterval: LIVE_REFRESH_MS,
  });

export const useWebhookEndpoints = () =>
  useQuery({
    queryKey: queryKeys.webhookEndpoints,
    queryFn: () => request<{ items: WebhookEndpoint[] }>('/webhook-endpoints'),
  });

export const useWebhookDeliveries = (filters: { status?: string; page?: number } = {}) =>
  useQuery({
    queryKey: queryKeys.webhookDeliveries(filters),
    queryFn: () =>
      request<Page<WebhookDelivery>>('/webhook-deliveries', {
        query: { pageSize: 15, ...filters },
      }),
    placeholderData: keepPreviousData,
    refetchInterval: LIVE_REFRESH_MS,
  });

export const useReconciliationRuns = () =>
  useQuery({
    queryKey: queryKeys.reconciliationRuns,
    queryFn: () => request<{ items: ReconciliationRun[] }>('/reconciliation/runs'),
  });

// ---- Mutations ----------------------------------------------------------------

/** Money changes ripple through balances, statements, holds and the dashboard. */
function useInvalidateLedger() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      ['accounts', 'transactions', 'holds', 'overview'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
}

interface MoneyCall<TBody> {
  body: TBody;
  idempotencyKey: string;
}

function useMoneyMutation<TBody, TResult = Transaction>(path: string | ((body: TBody) => string)) {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: MoneyCall<TBody>) =>
      request<TResult>(typeof path === 'function' ? path(body) : path, {
        method: 'POST',
        body,
        idempotencyKey,
      }),
    onSuccess: invalidate,
  });
}

export const useDeposit = () =>
  useMoneyMutation<{ accountId: string; amount: number; description?: string }>('/deposits');

export const useWithdraw = () =>
  useMoneyMutation<{ accountId: string; amount: number; description?: string }>('/withdrawals');

export const useTransfer = () =>
  useMoneyMutation<{
    sourceAccountId: string;
    destinationAccountId: string;
    amount: number;
    description?: string;
  }>('/transfers');

export const useRefund = () =>
  useMoneyMutation<{ transactionId: string; amount?: number; reason?: string }>(
    (body) => `/transactions/${body.transactionId}/refunds`,
  );

export const useCreateHold = () =>
  useMoneyMutation<
    { accountId: string; amount: number; expiresInSeconds: number; description?: string },
    { hold: Hold }
  >('/holds');

export const useCaptureHold = () =>
  useMoneyMutation<
    { holdId: string; destinationAccountId: string; amount?: number },
    { hold: Hold }
  >((body) => `/holds/${body.holdId}/capture`);

export const useReleaseHold = () =>
  useMoneyMutation<{ holdId: string }, { hold: Hold }>((body) => `/holds/${body.holdId}/release`);

export function useCreateWallet() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (body: { name: string; currency: string; ownerRef?: string }) =>
      request<Account>('/accounts', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useSetAccountStatus() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'FROZEN' }) =>
      request<Account>(`/accounts/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: invalidate,
  });
}

export function useCreateWebhookEndpoint() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { url: string; eventTypes: string[] }) =>
      request<WebhookEndpoint>('/webhook-endpoints', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.webhookEndpoints }),
  });
}

export function useDeleteWebhookEndpoint() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<void>(`/webhook-endpoints/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.webhookEndpoints }),
  });
}

export function useRedeliver() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request(`/webhook-deliveries/${id}/redeliver`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] }),
  });
}

export function useRunReconciliation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => request<ReconciliationRun>('/reconciliation/runs', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.reconciliationRuns }),
  });
}
