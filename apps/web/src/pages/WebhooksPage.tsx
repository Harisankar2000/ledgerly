import { useState } from 'react';
import {
  useCreateWebhookEndpoint,
  useDeleteWebhookEndpoint,
  useRedeliver,
  useWebhookDeliveries,
  useWebhookEndpoints,
} from '../api/hooks';
import type { WebhookEndpoint } from '../api/types';
import {
  Badge,
  Button,
  Card,
  ErrorAlert,
  Field,
  Loading,
  Mono,
  PageHeader,
  Pagination,
  StatusBadge,
  Table,
  inputClass,
} from '../components/ui';
import { formatDateTime } from '../lib/money';

function EndpointForm() {
  const [url, setUrl] = useState('http://webhook-sink:4000/webhooks');
  const [created, setCreated] = useState<WebhookEndpoint | null>(null);
  const create = useCreateWebhookEndpoint();

  return (
    <form
      className="max-w-2xl space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate({ url, eventTypes: ['*'] }, { onSuccess: setCreated });
      }}
    >
      <Field label="Endpoint URL" hint="Receives every ledger event, signed with HMAC-SHA256.">
        <div className="flex gap-2">
          <input
            type="url"
            required
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className={inputClass}
          />
          <Button type="submit" loading={create.isPending}>
            Add
          </Button>
        </div>
      </Field>
      <ErrorAlert error={create.error} />
      {created && (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
          Signing secret (shown once):{' '}
          <code className="break-all font-mono text-xs">{created.secret}</code>
        </div>
      )}
    </form>
  );
}

export function WebhooksPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const endpoints = useWebhookEndpoints();
  const deliveries = useWebhookDeliveries({ status: status || undefined, page });
  const remove = useDeleteWebhookEndpoint();
  const redeliver = useRedeliver();

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Ledger events flow: Postgres outbox → Kafka → dispatcher → your endpoint. Failed deliveries retry with exponential backoff. This page refreshes live."
      />
      <div className="space-y-6">
        <Card title="Endpoints">
          <EndpointForm />
          <ul className="mt-5 grid gap-3 md:grid-cols-2">
            {endpoints.isLoading && <Loading />}
            {endpoints.data?.items.map((endpoint) => (
              <li key={endpoint.id} className="rounded-lg p-3 ring-1 ring-slate-200">
                <p className="break-all text-sm font-medium">{endpoint.url}</p>
                <div className="mt-2 flex items-center justify-between">
                  <div className="flex gap-1">
                    {endpoint.eventTypes.map((type) => (
                      <Badge key={type}>{type === '*' ? 'all events' : type}</Badge>
                    ))}
                  </div>
                  <Button variant="ghost" onClick={() => remove.mutate(endpoint.id)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card
          title="Deliveries"
          actions={
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
              className={`${inputClass} w-40`}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <option>PENDING</option>
              <option>SUCCEEDED</option>
              <option>FAILED</option>
            </select>
          }
        >
          <ErrorAlert error={deliveries.error ?? redeliver.error} />
          {deliveries.isLoading ? (
            <Loading />
          ) : (
            <>
              <Table
                rows={deliveries.data?.items ?? []}
                rowKey={(row) => row.id}
                empty="No deliveries yet. Add an endpoint, then move some money."
                columns={[
                  {
                    header: 'Event',
                    cell: (row) => (
                      <div>
                        <p className="font-medium">{row.eventType}</p>
                        <Mono>{row.eventId.slice(0, 8)}</Mono>
                      </div>
                    ),
                  },
                  { header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
                  { header: 'Attempts', align: 'right', cell: (row) => row.attempts },
                  {
                    header: 'Response',
                    cell: (row) => (
                      <span
                        className={row.lastError ? 'text-rose-600' : 'text-slate-600'}
                        title={row.lastError ?? undefined}
                      >
                        {row.responseStatus ?? (row.lastError ? 'error' : '—')}
                      </span>
                    ),
                  },
                  {
                    header: 'Next / delivered',
                    cell: (row) => (
                      <span className="text-slate-500">
                        {row.deliveredAt
                          ? formatDateTime(row.deliveredAt)
                          : row.status === 'PENDING'
                            ? `retry ${formatDateTime(row.nextAttemptAt)}`
                            : '—'}
                      </span>
                    ),
                  },
                  {
                    header: '',
                    align: 'right',
                    cell: (row) =>
                      row.status !== 'PENDING' && (
                        <Button variant="ghost" onClick={() => redeliver.mutate(row.id)}>
                          Redeliver
                        </Button>
                      ),
                  },
                ]}
              />
              <Pagination
                page={page}
                totalPages={deliveries.data?.totalPages ?? 1}
                onChange={setPage}
              />
            </>
          )}
        </Card>
      </div>
    </>
  );
}
