import { useReconciliationRuns, useRunReconciliation } from '../api/hooks';
import {
  Button,
  Card,
  ErrorAlert,
  Loading,
  PageHeader,
  StatusBadge,
  Table,
} from '../components/ui';
import { formatDateTime, formatMoney } from '../lib/money';

export function ReconciliationPage() {
  const runs = useReconciliationRuns();
  const run = useRunReconciliation();
  const latest = runs.data?.items[0];

  return (
    <>
      <PageHeader
        title="Reconciliation"
        description="Independent SQL checks over the whole ledger, run on one consistent snapshot. Auditors ask for exactly this."
        actions={
          <Button loading={run.isPending} onClick={() => run.mutate()}>
            Run reconciliation
          </Button>
        }
      />
      <ErrorAlert error={runs.error ?? run.error} />
      {runs.isLoading && <Loading />}

      {latest && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card
            className="lg:col-span-2"
            title="Latest report"
            actions={
              <div className="flex items-center gap-3 text-sm text-slate-500">
                {formatDateTime(latest.createdAt)} <StatusBadge status={latest.status} />
              </div>
            }
          >
            <ul className="divide-y divide-slate-100">
              {latest.report.checks.map((check) => (
                <li key={check.name} className="flex items-start gap-3 py-3">
                  <span
                    aria-hidden
                    className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs text-white ${
                      check.passed ? 'bg-emerald-500' : 'bg-rose-500'
                    }`}
                  >
                    {check.passed ? '✓' : '!'}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{check.description}</p>
                    <p className="font-mono text-xs text-slate-400">{check.name}</p>
                    {!check.passed && (
                      <pre className="mt-2 overflow-x-auto rounded bg-rose-50 p-2 text-xs text-rose-800">
                        {JSON.stringify(check.discrepancies, null, 2)}
                      </pre>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <div className="space-y-6">
            <Card title="Balances by currency">
              <div className="space-y-4">
                {latest.report.totals.map((row) => (
                  <dl key={row.currency} className="space-y-1 text-sm">
                    <dt className="font-semibold">{row.currency}</dt>
                    <dd className="flex justify-between text-slate-600">
                      Wallets{' '}
                      <span className="tabular-nums">
                        {formatMoney(row.walletBalance, row.currency)}
                      </span>
                    </dd>
                    <dd className="flex justify-between text-slate-600">
                      Held{' '}
                      <span className="tabular-nums">
                        {formatMoney(row.heldAmount, row.currency)}
                      </span>
                    </dd>
                    <dd className="flex justify-between text-slate-600">
                      Settlement{' '}
                      <span className="tabular-nums">
                        {formatMoney(row.settlementBalance, row.currency)}
                      </span>
                    </dd>
                  </dl>
                ))}
                <p className="text-xs text-slate-500">
                  Settlement is negative by design: it is the outside world's side of every top-up,
                  so the three lines always sum to zero.
                </p>
              </div>
            </Card>
            <Card title="Event outbox">
              <p className="text-sm text-slate-600">
                {latest.report.outbox.unpublished} unpublished event(s)
                {latest.report.outbox.oldestUnpublishedSeconds !== null &&
                  `, oldest ${latest.report.outbox.oldestUnpublishedSeconds}s`}
              </p>
            </Card>
          </div>
        </div>
      )}

      {!latest && !runs.isLoading && (
        <Card>
          <p className="text-sm text-slate-500">No reports yet. Run the first reconciliation.</p>
        </Card>
      )}

      {runs.data && runs.data.items.length > 1 && (
        <Card title="History" className="mt-6">
          <Table
            rows={runs.data.items}
            rowKey={(row) => row.id}
            columns={[
              { header: 'Run at', cell: (row) => formatDateTime(row.createdAt) },
              { header: 'Result', cell: (row) => <StatusBadge status={row.status} /> },
              {
                header: 'Checks passed',
                align: 'right',
                cell: (row) =>
                  `${row.report.checks.filter((check) => check.passed).length} / ${row.report.checks.length}`,
              },
            ]}
          />
        </Card>
      )}
    </>
  );
}
