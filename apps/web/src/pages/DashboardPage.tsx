import { useState } from 'react';
import { Link } from 'react-router';
import { useOverview, useReconciliationRuns, useTransactions } from '../api/hooks';
import { TransferDialog } from '../components/forms';
import { TransactionPanel } from '../components/TransactionPanel';
import {
  Badge,
  Button,
  Card,
  ErrorAlert,
  Loading,
  PageHeader,
  StatCard,
  StatusBadge,
  Table,
} from '../components/ui';
import { useAccountNames } from '../lib/useAccountNames';
import { formatDateTime, formatMoney } from '../lib/money';

export function DashboardPage() {
  const overview = useOverview();
  const recent = useTransactions({ page: 1 });
  const reconciliation = useReconciliationRuns();
  const names = useAccountNames();
  const [selected, setSelected] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  const inr = overview.data?.wallets.find((row) => row.currency === 'INR');
  const usd = overview.data?.wallets.find((row) => row.currency === 'USD');
  const volume = overview.data?.last24h.filter((row) => row.currency === 'INR') ?? [];
  const totalCount = volume.reduce((sum, row) => sum + row.count, 0);
  const deliveries = overview.data?.webhookDeliveries ?? {};
  const lastRun = reconciliation.data?.items[0];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Live view of the ledger. Every number here is derived from immutable journal entries."
        actions={<Button onClick={() => setTransferOpen(true)}>Send money</Button>}
      />
      <ErrorAlert error={overview.error} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Wallet balances (INR)"
          value={formatMoney(inr?.balance ?? 0, 'INR')}
          hint={`${inr?.wallets ?? 0} wallets`}
        />
        <StatCard
          label="Wallet balances (USD)"
          value={formatMoney(usd?.balance ?? 0, 'USD')}
          hint={`${usd?.wallets ?? 0} wallets`}
        />
        <StatCard
          label="Active holds"
          value={overview.data?.activeHolds.active ?? 0}
          hint={`${formatMoney(overview.data?.activeHolds.amount ?? 0, 'INR')} reserved`}
        />
        <StatCard
          label="Webhooks delivered"
          value={deliveries.SUCCEEDED ?? 0}
          hint={`${deliveries.PENDING ?? 0} pending · ${deliveries.FAILED ?? 0} failed`}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Recent transactions"
          actions={
            <Link
              to="/transactions"
              className="text-sm font-medium text-indigo-600 hover:underline"
            >
              View all
            </Link>
          }
        >
          {recent.isLoading ? (
            <Loading />
          ) : (
            <Table
              rows={recent.data?.items.slice(0, 8) ?? []}
              rowKey={(row) => row.id}
              onRowClick={(row) => setSelected(row.id)}
              columns={[
                { header: 'Type', cell: (row) => <Badge tone="violet">{row.type}</Badge> },
                {
                  header: 'From → To',
                  cell: (row) =>
                    `${names(row.sourceAccountId)} → ${names(row.destinationAccountId)}`,
                },
                {
                  header: 'Amount',
                  align: 'right',
                  cell: (row) => formatMoney(row.amount, row.currency),
                },
                {
                  header: 'When',
                  cell: (row) => (
                    <span className="text-slate-500">{formatDateTime(row.createdAt)}</span>
                  ),
                },
              ]}
            />
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Last 24 hours (INR)">
            {volume.length === 0 ? (
              <p className="text-sm text-slate-500">No activity yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {volume.map((row) => (
                  <li key={row.type} className="flex justify-between">
                    <span className="text-slate-600">
                      {row.type} <span className="text-slate-400">×{row.count}</span>
                    </span>
                    <span className="tabular-nums">{formatMoney(row.volume, 'INR')}</span>
                  </li>
                ))}
                <li className="flex justify-between border-t border-slate-100 pt-2 font-medium">
                  <span>Transactions</span>
                  <span>{totalCount}</span>
                </li>
              </ul>
            )}
          </Card>

          <Card
            title="Ledger integrity"
            actions={
              <Link
                to="/reconciliation"
                className="text-sm font-medium text-indigo-600 hover:underline"
              >
                Details
              </Link>
            }
          >
            {lastRun ? (
              <div className="flex items-center justify-between text-sm">
                <StatusBadge status={lastRun.status} />
                <span className="text-slate-500">{formatDateTime(lastRun.createdAt)}</span>
              </div>
            ) : (
              <p className="text-sm text-slate-500">No reconciliation run yet.</p>
            )}
          </Card>
        </div>
      </div>

      <TransactionPanel transactionId={selected} onClose={() => setSelected(null)} />
      <TransferDialog open={transferOpen} onClose={() => setTransferOpen(false)} />
    </>
  );
}
