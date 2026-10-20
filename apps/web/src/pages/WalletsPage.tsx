import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAccounts } from '../api/hooks';
import { CreateWalletDialog } from '../components/forms';
import {
  Badge,
  Button,
  Card,
  ErrorAlert,
  Loading,
  PageHeader,
  StatusBadge,
  Table,
  inputClass,
} from '../components/ui';
import { formatDateTime, formatMoney } from '../lib/money';

export function WalletsPage() {
  const [kind, setKind] = useState<'WALLET' | 'SYSTEM'>('WALLET');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error } = useAccounts({ kind, search: search.trim() || undefined });

  return (
    <>
      <PageHeader
        title="Wallets"
        description="Customer and merchant wallets. System accounts (settlement and hold suspense) are the other side of every entry."
        actions={<Button onClick={() => setCreating(true)}>New wallet</Button>}
      />
      <Card
        title={
          <div className="flex gap-1">
            {(['WALLET', 'SYSTEM'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setKind(value)}
                className={`rounded-md px-2.5 py-1 text-sm ${kind === value ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                {value === 'WALLET' ? 'Wallets' : 'System accounts'}
              </button>
            ))}
          </div>
        }
        actions={
          <input
            type="search"
            placeholder="Search by name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={`${inputClass} w-56`}
          />
        }
      >
        <ErrorAlert error={error} />
        {isLoading ? (
          <Loading />
        ) : (
          <Table
            rows={data?.items ?? []}
            rowKey={(row) => row.id}
            onRowClick={(row) => navigate(`/wallets/${row.id}`)}
            columns={[
              {
                header: 'Name',
                cell: (row) => (
                  <div>
                    <p className="font-medium text-slate-900">{row.name}</p>
                    <p className="text-xs text-slate-500">{row.ownerRef ?? row.code ?? '—'}</p>
                  </div>
                ),
              },
              { header: 'Currency', cell: (row) => <Badge>{row.currency}</Badge> },
              { header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
              {
                header: 'Created',
                cell: (row) => (
                  <span className="text-slate-500">{formatDateTime(row.createdAt)}</span>
                ),
              },
              {
                header: 'Balance',
                align: 'right',
                cell: (row) => (
                  <span
                    className={row.balance < 0 ? 'text-rose-600' : 'font-medium text-slate-900'}
                  >
                    {formatMoney(row.balance, row.currency)}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Card>
      <CreateWalletDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
