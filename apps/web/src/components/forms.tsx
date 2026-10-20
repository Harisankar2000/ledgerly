/**
 * Money-moving dialogs. Each dialog creates one Idempotency-Key when it opens
 * and reuses it for every retry, so a double click or a flaky network can
 * never charge twice. A new key is generated after a successful submission.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  useAccounts,
  useCaptureHold,
  useCreateHold,
  useCreateWallet,
  useDeposit,
  useRefund,
  useTransfer,
  useWithdraw,
} from '../api/hooks';
import type { Account, Currency, Hold, Transaction } from '../api/types';
import { formatMoney, parseToMinor } from '../lib/money';
import { Button, ErrorAlert, Field, Modal, inputClass } from './ui';

function useIdempotencyKey() {
  const [key, setKey] = useState(() => crypto.randomUUID());
  return { key, rotate: () => setKey(crypto.randomUUID()) };
}

function AmountInput({
  value,
  onChange,
  currency,
}: {
  value: string;
  onChange: (value: string) => void;
  currency?: Currency;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-slate-500">
        {currency === 'USD' ? '$' : '₹'}
      </span>
      <input
        inputMode="decimal"
        required
        placeholder="0.00"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClass} pl-7 tabular-nums`}
      />
    </div>
  );
}

function WalletSelect({
  value,
  onChange,
  currency,
  exclude,
  label,
}: {
  value: string;
  onChange: (id: string) => void;
  currency?: Currency;
  exclude?: string;
  label: string;
}) {
  const { data } = useAccounts({ kind: 'WALLET', currency });
  const wallets = (data?.items ?? []).filter((wallet) => wallet.id !== exclude);
  return (
    <Field label={label}>
      <select
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      >
        <option value="">Select a wallet…</option>
        {wallets.map((wallet) => (
          <option key={wallet.id} value={wallet.id}>
            {wallet.name} · {formatMoney(wallet.balance, wallet.currency)}
          </option>
        ))}
      </select>
    </Field>
  );
}

function DialogForm({
  onSubmit,
  error,
  pending,
  submitLabel,
  idempotencyKey,
  children,
}: {
  onSubmit: () => void;
  error: unknown;
  pending: boolean;
  submitLabel: string;
  idempotencyKey?: string;
  children: ReactNode;
}) {
  const handle = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form onSubmit={handle} className="space-y-4">
      {children}
      <ErrorAlert error={error} />
      <div className="flex items-center justify-between gap-3 pt-1">
        {idempotencyKey ? (
          <span
            className="truncate font-mono text-[11px] text-slate-400"
            title="Sent as the Idempotency-Key header"
          >
            key {idempotencyKey.slice(0, 13)}…
          </span>
        ) : (
          <span />
        )}
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

const amountError = new Error('Enter a positive amount with at most two decimals');

export function CreateWalletDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>('INR');
  const mutation = useCreateWallet();

  return (
    <Modal open={open} title="New wallet" onClose={onClose}>
      <DialogForm
        submitLabel="Create wallet"
        pending={mutation.isPending}
        error={mutation.error}
        onSubmit={() =>
          mutation.mutate(
            { name, currency },
            {
              onSuccess: () => {
                setName('');
                onClose();
              },
            },
          )
        }
      >
        <Field label="Name">
          <input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
            placeholder="e.g. Asha Verma"
          />
        </Field>
        <Field label="Currency">
          <select
            value={currency}
            onChange={(event) => setCurrency(event.target.value as Currency)}
            className={inputClass}
          >
            <option value="INR">INR — Indian rupee</option>
            <option value="USD">USD — US dollar</option>
          </select>
        </Field>
      </DialogForm>
    </Modal>
  );
}

export function DepositWithdrawDialog({
  mode,
  account,
  onClose,
}: {
  mode: 'deposit' | 'withdraw' | null;
  account: Account;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState('');
  const { key, rotate } = useIdempotencyKey();
  const deposit = useDeposit();
  const withdraw = useWithdraw();
  const mutation = mode === 'withdraw' ? withdraw : deposit;
  const [localError, setLocalError] = useState<Error | null>(null);

  const submit = () => {
    const minor = parseToMinor(amount);
    if (minor === null) return setLocalError(amountError);
    setLocalError(null);
    mutation.mutate(
      { body: { accountId: account.id, amount: minor }, idempotencyKey: key },
      {
        onSuccess: () => {
          rotate();
          setAmount('');
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={mode !== null}
      title={mode === 'withdraw' ? `Withdraw from ${account.name}` : `Top up ${account.name}`}
      onClose={onClose}
    >
      <DialogForm
        submitLabel={mode === 'withdraw' ? 'Withdraw' : 'Add money'}
        pending={mutation.isPending}
        error={localError ?? mutation.error}
        idempotencyKey={key}
        onSubmit={submit}
      >
        <Field label="Amount" hint={`Available: ${formatMoney(account.balance, account.currency)}`}>
          <AmountInput value={amount} onChange={setAmount} currency={account.currency} />
        </Field>
      </DialogForm>
    </Modal>
  );
}

export function TransferDialog({
  open,
  source,
  onClose,
}: {
  open: boolean;
  source?: Account;
  onClose: () => void;
}) {
  const [sourceId, setSourceId] = useState(source?.id ?? '');
  const [destinationId, setDestinationId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [localError, setLocalError] = useState<Error | null>(null);
  const { key, rotate } = useIdempotencyKey();
  const transfer = useTransfer();
  const { data } = useAccounts({ kind: 'WALLET' });
  const selected = data?.items.find((wallet) => wallet.id === sourceId);

  const submit = () => {
    const minor = parseToMinor(amount);
    if (minor === null) return setLocalError(amountError);
    setLocalError(null);
    transfer.mutate(
      {
        body: {
          sourceAccountId: sourceId,
          destinationAccountId: destinationId,
          amount: minor,
          description: description || undefined,
        },
        idempotencyKey: key,
      },
      {
        onSuccess: () => {
          rotate();
          setAmount('');
          setDescription('');
          onClose();
        },
      },
    );
  };

  return (
    <Modal open={open} title="Send money" onClose={onClose}>
      <DialogForm
        submitLabel="Transfer"
        pending={transfer.isPending}
        error={localError ?? transfer.error}
        idempotencyKey={key}
        onSubmit={submit}
      >
        <WalletSelect label="From" value={sourceId} onChange={setSourceId} />
        <WalletSelect
          label="To"
          value={destinationId}
          onChange={setDestinationId}
          currency={selected?.currency}
          exclude={sourceId}
        />
        <Field label="Amount">
          <AmountInput value={amount} onChange={setAmount} currency={selected?.currency} />
        </Field>
        <Field label="Note (optional)">
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className={inputClass}
            placeholder="Dinner split"
          />
        </Field>
      </DialogForm>
    </Modal>
  );
}

export function CreateHoldDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [description, setDescription] = useState('');
  const [localError, setLocalError] = useState<Error | null>(null);
  const { key, rotate } = useIdempotencyKey();
  const mutation = useCreateHold();

  const submit = () => {
    const minor = parseToMinor(amount);
    if (minor === null) return setLocalError(amountError);
    setLocalError(null);
    mutation.mutate(
      {
        body: {
          accountId,
          amount: minor,
          expiresInSeconds: Number(minutes) * 60,
          description: description || undefined,
        },
        idempotencyKey: key,
      },
      {
        onSuccess: () => {
          rotate();
          setAmount('');
          onClose();
        },
      },
    );
  };

  return (
    <Modal open={open} title="Authorise a hold" onClose={onClose}>
      <DialogForm
        submitLabel="Place hold"
        pending={mutation.isPending}
        error={localError ?? mutation.error}
        idempotencyKey={key}
        onSubmit={submit}
      >
        <WalletSelect label="Wallet" value={accountId} onChange={setAccountId} />
        <Field label="Amount">
          <AmountInput value={amount} onChange={setAmount} />
        </Field>
        <Field
          label="Expires after (minutes)"
          hint="Unused holds are released automatically when they expire."
        >
          <input
            type="number"
            min={1}
            max={43_200}
            required
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Description (optional)">
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className={inputClass}
            placeholder="Hotel booking pre-auth"
          />
        </Field>
      </DialogForm>
    </Modal>
  );
}

export function CaptureHoldDialog({ hold, onClose }: { hold: Hold | null; onClose: () => void }) {
  const [destinationId, setDestinationId] = useState('');
  const [amount, setAmount] = useState('');
  const [localError, setLocalError] = useState<Error | null>(null);
  const { key, rotate } = useIdempotencyKey();
  const mutation = useCaptureHold();
  if (!hold) return null;

  const submit = () => {
    const minor = amount ? parseToMinor(amount) : undefined;
    if (minor === null) return setLocalError(amountError);
    setLocalError(null);
    mutation.mutate(
      {
        body: { holdId: hold.id, destinationAccountId: destinationId, amount: minor },
        idempotencyKey: key,
      },
      {
        onSuccess: () => {
          rotate();
          setAmount('');
          onClose();
        },
      },
    );
  };

  return (
    <Modal open title={`Capture ${formatMoney(hold.amount, hold.currency)} hold`} onClose={onClose}>
      <DialogForm
        submitLabel="Capture"
        pending={mutation.isPending}
        error={localError ?? mutation.error}
        idempotencyKey={key}
        onSubmit={submit}
      >
        <WalletSelect
          label="Pay to"
          value={destinationId}
          onChange={setDestinationId}
          currency={hold.currency}
          exclude={hold.accountId}
        />
        <Field
          label="Amount to capture"
          hint="Leave empty to capture everything. The rest goes back to the payer."
        >
          <AmountInput value={amount} onChange={setAmount} currency={hold.currency} />
        </Field>
      </DialogForm>
    </Modal>
  );
}

export function RefundDialog({
  transaction,
  onClose,
}: {
  transaction: Transaction | null;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<Error | null>(null);
  const { key, rotate } = useIdempotencyKey();
  const mutation = useRefund();
  if (!transaction) return null;
  const remaining = transaction.amount - transaction.refundedAmount;

  const submit = () => {
    const minor = amount ? parseToMinor(amount) : undefined;
    if (minor === null) return setLocalError(amountError);
    setLocalError(null);
    mutation.mutate(
      {
        body: { transactionId: transaction.id, amount: minor, reason: reason || undefined },
        idempotencyKey: key,
      },
      {
        onSuccess: () => {
          rotate();
          setAmount('');
          onClose();
        },
      },
    );
  };

  return (
    <Modal open title="Refund payment" onClose={onClose}>
      <DialogForm
        submitLabel="Refund"
        pending={mutation.isPending}
        error={localError ?? mutation.error}
        idempotencyKey={key}
        onSubmit={submit}
      >
        <Field
          label="Amount"
          hint={`Refundable: ${formatMoney(remaining, transaction.currency)}. Leave empty for a full refund.`}
        >
          <AmountInput value={amount} onChange={setAmount} currency={transaction.currency} />
        </Field>
        <Field label="Reason (optional)">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={inputClass}
            placeholder="Item out of stock"
          />
        </Field>
      </DialogForm>
    </Modal>
  );
}
