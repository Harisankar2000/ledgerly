import { useState } from 'react';
import { useHolds, useReleaseHold } from '../api/hooks';
import type { Hold, HoldStatus } from '../api/types';
import { CaptureHoldDialog, CreateHoldDialog } from '../components/forms';
import {
  Button,
  Card,
  ErrorAlert,
  Loading,
  PageHeader,
  Pagination,
  StatusBadge,
  Table,
} from '../components/ui';
import { useAccountNames } from '../lib/useAccountNames';
import { formatDateTime, formatMoney } from '../lib/money';

const FILTERS: Array<HoldStatus | ''> = ['', 'ACTIVE', 'CAPTURED', 'RELEASED', 'EXPIRED'];

export function HoldsPage() {
  const [status, setStatus] = useState<HoldStatus | ''>('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [capturing, setCapturing] = useState<Hold | null>(null);
  const { data, isLoading, error } = useHolds({ status: status || undefined, page });
  const release = useReleaseHold();
  const names = useAccountNames();

  return (
    <>
      <PageHeader
        title="Holds"
        description="Authorise now, settle later — like a card pre-auth or a cab fare estimate. Held money leaves the wallet's balance immediately."
        actions={<Button onClick={() => setCreating(true)}>New hold</Button>}
      />
      <Card
        title={
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((value) => (
              <button
                key={value || 'ALL'}
                type="button"
                onClick={() => {
                  setStatus(value);
                  setPage(1);
                }}
                className={`rounded-md px-2.5 py-1 text-sm ${status === value ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                {value || 'All'}
              </button>
            ))}
          </div>
        }
      >
        <ErrorAlert error={error ?? release.error} />
        {isLoading ? (
          <Loading />
        ) : (
          <>
            <Table
              rows={data?.items ?? []}
              rowKey={(row) => row.id}
              columns={[
                { header: 'Wallet', cell: (row) => names(row.accountId) },
                {
                  header: 'Description',
                  cell: (row) => <span className="text-slate-600">{row.description ?? '—'}</span>,
                },
                { header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
                {
                  header: 'Expires',
                  cell: (row) => (
                    <span className="text-slate-500">
                      {row.status === 'ACTIVE' ? formatDateTime(row.expiresAt) : '—'}
                    </span>
                  ),
                },
                {
                  header: 'Amount',
                  align: 'right',
                  cell: (row) => (
                    <div>
                      <p className="font-medium">{formatMoney(row.amount, row.currency)}</p>
                      {row.capturedAmount > 0 && (
                        <p className="text-xs text-emerald-700">
                          {formatMoney(row.capturedAmount, row.currency)} captured
                        </p>
                      )}
                    </div>
                  ),
                },
                {
                  header: 'Actions',
                  align: 'right',
                  cell: (row) =>
                    row.status === 'ACTIVE' ? (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" onClick={() => setCapturing(row)}>
                          Capture
                        </Button>
                        <Button
                          variant="ghost"
                          loading={release.isPending && release.variables?.body.holdId === row.id}
                          onClick={() =>
                            release.mutate({
                              body: { holdId: row.id },
                              idempotencyKey: crypto.randomUUID(),
                            })
                          }
                        >
                          Release
                        </Button>
                      </div>
                    ) : null,
                },
              ]}
            />
            <Pagination page={page} totalPages={data?.totalPages ?? 1} onChange={setPage} />
          </>
        )}
      </Card>
      <CreateHoldDialog open={creating} onClose={() => setCreating(false)} />
      <CaptureHoldDialog key={capturing?.id} hold={capturing} onClose={() => setCapturing(null)} />
    </>
  );
}
