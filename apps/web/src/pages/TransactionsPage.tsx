import { useState } from 'react';
import { useTransactions } from '../api/hooks';
import type { TransactionType } from '../api/types';
import { TransactionPanel } from '../components/TransactionPanel';
import {
  Badge,
  Card,
  ErrorAlert,
  Loading,
  PageHeader,
  Pagination,
  Table,
  inputClass,
} from '../components/ui';
import { useAccountNames } from '../lib/useAccountNames';
import { formatDateTime, formatMoney } from '../lib/money';

const TYPES: TransactionType[] = [
  'DEPOSIT',
  'WITHDRAWAL',
  'TRANSFER',
  'REFUND',
  'HOLD',
  'HOLD_CAPTURE',
  'HOLD_RELEASE',
];

export function TransactionsPage() {
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading, error } = useTransactions({ type: type || undefined, page });
  const names = useAccountNames();

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Every money movement is one transaction with balanced debit and credit entries. Click a row to see its journal."
      />
      <Card
        title={`${data?.total ?? 0} transactions`}
        actions={
          <select
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(1);
            }}
            className={`${inputClass} w-48`}
            aria-label="Filter by type"
          >
            <option value="">All types</option>
            {TYPES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        }
      >
        <ErrorAlert error={error} />
        {isLoading ? (
          <Loading />
        ) : (
          <>
            <Table
              rows={data?.items ?? []}
              rowKey={(row) => row.id}
              onRowClick={(row) => setSelected(row.id)}
              columns={[
                {
                  header: 'When',
                  cell: (row) => (
                    <span className="text-slate-500">{formatDateTime(row.createdAt)}</span>
                  ),
                },
                { header: 'Type', cell: (row) => <Badge tone="violet">{row.type}</Badge> },
                { header: 'From', cell: (row) => names(row.sourceAccountId) },
                { header: 'To', cell: (row) => names(row.destinationAccountId) },
                {
                  header: 'Description',
                  cell: (row) => <span className="text-slate-600">{row.description ?? '—'}</span>,
                },
                {
                  header: 'Amount',
                  align: 'right',
                  cell: (row) => (
                    <div>
                      <p className="font-medium">{formatMoney(row.amount, row.currency)}</p>
                      {row.refundedAmount > 0 && (
                        <p className="text-xs text-amber-700">
                          {formatMoney(row.refundedAmount, row.currency)} refunded
                        </p>
                      )}
                    </div>
                  ),
                },
              ]}
            />
            <Pagination page={page} totalPages={data?.totalPages ?? 1} onChange={setPage} />
          </>
        )}
      </Card>
      <TransactionPanel transactionId={selected} onClose={() => setSelected(null)} />
    </>
  );
}
