import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAccount, useSetAccountStatus, useStatement } from '../api/hooks';
import { DepositWithdrawDialog, TransferDialog } from '../components/forms';
import { TransactionPanel } from '../components/TransactionPanel';
import {
  Badge,
  Button,
  Card,
  ErrorAlert,
  Loading,
  Mono,
  PageHeader,
  Pagination,
  StatusBadge,
  Table,
} from '../components/ui';
import { formatDateTime, formatMoney, formatSigned } from '../lib/money';

export function WalletDetailPage() {
  const { accountId = '' } = useParams();
  const account = useAccount(accountId);
  const [page, setPage] = useState(1);
  const statement = useStatement(accountId, page);
  const setStatus = useSetAccountStatus();
  const [moneyMode, setMoneyMode] = useState<'deposit' | 'withdraw' | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  if (account.isLoading) return <Loading />;
  if (account.error || !account.data)
    return <ErrorAlert error={account.error ?? new Error('Wallet not found')} />;
  const wallet = account.data;
  const isWallet = wallet.kind === 'WALLET';
  const frozen = wallet.status === 'FROZEN';

  return (
    <>
      <Link to="/wallets" className="text-sm text-indigo-600 hover:underline">
        ← Wallets
      </Link>
      <div className="mt-3">
        <PageHeader
          title={wallet.name}
          description={wallet.ownerRef ?? wallet.code ?? undefined}
          actions={
            isWallet && (
              <>
                <Button disabled={frozen} onClick={() => setMoneyMode('deposit')}>
                  Add money
                </Button>
                <Button variant="secondary" disabled={frozen} onClick={() => setTransferOpen(true)}>
                  Send
                </Button>
                <Button
                  variant="secondary"
                  disabled={frozen}
                  onClick={() => setMoneyMode('withdraw')}
                >
                  Withdraw
                </Button>
                <Button
                  variant={frozen ? 'secondary' : 'danger'}
                  loading={setStatus.isPending}
                  onClick={() =>
                    setStatus.mutate({ id: wallet.id, status: frozen ? 'ACTIVE' : 'FROZEN' })
                  }
                >
                  {frozen ? 'Unfreeze' : 'Freeze'}
                </Button>
              </>
            )
          }
        />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-6 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 p-6 text-white shadow-sm">
        <div>
          <p className="text-sm text-indigo-100">Available balance</p>
          <p className="mt-1 text-4xl font-semibold tabular-nums">
            {formatMoney(wallet.balance, wallet.currency)}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge tone="slate">{wallet.currency}</Badge>
          <StatusBadge status={wallet.status} />
        </div>
      </div>

      <ErrorAlert error={setStatus.error} />
      <Card title="Statement" actions={<Mono>{wallet.id}</Mono>}>
        {statement.isLoading ? (
          <Loading />
        ) : (
          <>
            <Table
              rows={statement.data?.items ?? []}
              rowKey={(row) => row.id}
              onRowClick={(row) => setSelected(row.transactionId)}
              empty="No entries yet. Add money to get started."
              columns={[
                {
                  header: 'When',
                  cell: (row) => (
                    <span className="text-slate-500">{formatDateTime(row.createdAt)}</span>
                  ),
                },
                {
                  header: 'Type',
                  cell: (row) => <Badge tone="violet">{row.transactionType}</Badge>,
                },
                { header: 'Description', cell: (row) => row.description ?? '—' },
                {
                  header: 'Amount',
                  align: 'right',
                  cell: (row) => (
                    <span className={row.amount < 0 ? 'text-rose-600' : 'text-emerald-600'}>
                      {formatSigned(row.amount, wallet.currency)}
                    </span>
                  ),
                },
                {
                  header: 'Balance',
                  align: 'right',
                  cell: (row) => formatMoney(row.balanceAfter, wallet.currency),
                },
              ]}
            />
            <Pagination
              page={page}
              totalPages={statement.data?.totalPages ?? 1}
              onChange={setPage}
            />
          </>
        )}
      </Card>

      <DepositWithdrawDialog mode={moneyMode} account={wallet} onClose={() => setMoneyMode(null)} />
      <TransferDialog
        key={wallet.id}
        open={transferOpen}
        source={wallet}
        onClose={() => setTransferOpen(false)}
      />
      <TransactionPanel transactionId={selected} onClose={() => setSelected(null)} />
    </>
  );
}
