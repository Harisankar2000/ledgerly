import { useState } from 'react';
import { useAccountNames } from '../lib/useAccountNames';
import { useTransaction } from '../api/hooks';
import type { Transaction } from '../api/types';
import { formatDateTime, formatMoney, formatSigned } from '../lib/money';
import { RefundDialog } from './forms';
import { Badge, Button, ErrorAlert, Loading, Modal, Mono, Table } from './ui';

const REFUNDABLE = new Set(['TRANSFER', 'HOLD_CAPTURE', 'DEPOSIT']);

/** Shows the double-entry view of one transaction: who was debited, who was credited. */
export function TransactionPanel({
  transactionId,
  onClose,
}: {
  transactionId: string | null;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useTransaction(transactionId);
  const names = useAccountNames();
  const [refunding, setRefunding] = useState<Transaction | null>(null);

  const refundable = data && REFUNDABLE.has(data.type) && data.refundedAmount < data.amount;

  return (
    <>
      <Modal
        open={transactionId !== null && refunding === null}
        title="Transaction"
        onClose={onClose}
      >
        {isLoading && <Loading />}
        <ErrorAlert error={error} />
        {data && (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-2xl font-semibold tabular-nums">
                  {formatMoney(data.amount, data.currency)}
                </p>
                <p className="mt-1 text-sm text-slate-500">{data.description ?? '—'}</p>
              </div>
              <Badge tone="violet">{data.type}</Badge>
            </div>

            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-slate-500">From</dt>
                <dd className="font-medium">{names(data.sourceAccountId)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">To</dt>
                <dd className="font-medium">{names(data.destinationAccountId)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Created</dt>
                <dd>{formatDateTime(data.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Refunded</dt>
                <dd className="tabular-nums">{formatMoney(data.refundedAmount, data.currency)}</dd>
              </div>
            </dl>

            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Journal entries (sum = 0)
              </h3>
              <Table
                rows={data.entries}
                rowKey={(entry) => entry.id}
                columns={[
                  { header: 'Account', cell: (entry) => names(entry.accountId) },
                  {
                    header: 'Amount',
                    align: 'right',
                    cell: (entry) => (
                      <span className={entry.amount < 0 ? 'text-rose-600' : 'text-emerald-600'}>
                        {formatSigned(entry.amount, data.currency)}
                      </span>
                    ),
                  },
                  {
                    header: 'Balance after',
                    align: 'right',
                    cell: (entry) => formatMoney(entry.balanceAfter, data.currency),
                  },
                ]}
              />
            </div>

            {data.refunds.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Refunds
                </h3>
                <ul className="space-y-1 text-sm">
                  {data.refunds.map((refund) => (
                    <li key={refund.id} className="flex justify-between">
                      <span className="text-slate-600">{refund.description}</span>
                      <span className="tabular-nums">
                        {formatMoney(refund.amount, refund.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center justify-between">
              <Mono>{data.id}</Mono>
              {refundable && (
                <Button variant="secondary" onClick={() => setRefunding(data)}>
                  Refund
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
      <RefundDialog transaction={refunding} onClose={() => setRefunding(null)} />
    </>
  );
}
