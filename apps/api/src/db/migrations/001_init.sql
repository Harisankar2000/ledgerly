-- Ledgerly schema. Amounts are integers in minor units (paise, cents): never floats.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text        NOT NULL CHECK (kind IN ('WALLET', 'SYSTEM')),
  -- Stable identifier for system accounts, e.g. 'settlement:INR'.
  code            text UNIQUE,
  owner_ref       text,
  name            text        NOT NULL,
  currency        char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance         bigint      NOT NULL DEFAULT 0,
  allow_negative  boolean     NOT NULL DEFAULT false,
  status          text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN')),
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Last line of defence: even a buggy code path cannot overdraw a wallet.
  CONSTRAINT accounts_no_overdraft CHECK (allow_negative OR balance >= 0)
);

CREATE INDEX accounts_owner_ref_idx ON accounts (owner_ref) WHERE owner_ref IS NOT NULL;
CREATE INDEX accounts_created_at_idx ON accounts (created_at DESC);

-- ---------------------------------------------------------------------------
-- Transactions (journal headers) and entries (journal lines)
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type                  text        NOT NULL CHECK (type IN (
                          'DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'REFUND',
                          'HOLD', 'HOLD_CAPTURE', 'HOLD_RELEASE')),
  currency              char(3)     NOT NULL,
  -- Gross amount moved, always positive. Entries carry the signed legs.
  amount                bigint      NOT NULL CHECK (amount > 0),
  refunded_amount       bigint      NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  -- Business view of the movement (who paid whom); refunds reverse this direction.
  source_account_id     uuid        NOT NULL REFERENCES accounts (id),
  destination_account_id uuid       NOT NULL REFERENCES accounts (id),
  parent_transaction_id uuid REFERENCES transactions (id),
  description           text,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transactions_refund_limit CHECK (refunded_amount <= amount)
);

CREATE INDEX transactions_created_at_idx ON transactions (created_at DESC);
CREATE INDEX transactions_source_idx ON transactions (source_account_id, created_at DESC);
CREATE INDEX transactions_destination_idx ON transactions (destination_account_id, created_at DESC);
CREATE INDEX transactions_parent_idx ON transactions (parent_transaction_id)
  WHERE parent_transaction_id IS NOT NULL;

CREATE TABLE entries (
  id              bigserial PRIMARY KEY,
  transaction_id  uuid        NOT NULL REFERENCES transactions (id),
  account_id      uuid        NOT NULL REFERENCES accounts (id),
  -- Signed: positive increases the account balance, negative decreases it.
  amount          bigint      NOT NULL CHECK (amount <> 0),
  balance_after   bigint      NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entries_account_idx ON entries (account_id, id DESC);
CREATE INDEX entries_transaction_idx ON entries (transaction_id);

-- Entries are an immutable audit trail: corrections are new transactions, never edits.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER entries_append_only
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Double-entry invariant: the legs of every transaction sum to zero.
-- Deferred to COMMIT so all legs can be inserted first.
CREATE FUNCTION assert_transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  total bigint;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO total FROM entries WHERE transaction_id = NEW.transaction_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'transaction % is unbalanced (sum = %)', NEW.transaction_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();

-- ---------------------------------------------------------------------------
-- Holds (authorisations)
-- ---------------------------------------------------------------------------
CREATE TABLE holds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid        NOT NULL REFERENCES accounts (id),
  hold_transaction_id uuid       NOT NULL REFERENCES transactions (id),
  currency           char(3)     NOT NULL,
  amount             bigint      NOT NULL CHECK (amount > 0),
  captured_amount    bigint      NOT NULL DEFAULT 0,
  status             text        NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE', 'CAPTURED', 'RELEASED', 'EXPIRED')),
  description        text,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holds_capture_limit CHECK (captured_amount BETWEEN 0 AND amount)
);

CREATE INDEX holds_account_idx ON holds (account_id, created_at DESC);
CREATE INDEX holds_expiry_idx ON holds (expires_at) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Idempotency keys: stored in the same transaction as the money movement
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  scope           text        NOT NULL,
  key             text        NOT NULL,
  request_hash    text        NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- ---------------------------------------------------------------------------
-- Transactional outbox: events are committed atomically with ledger changes
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id             bigserial PRIMARY KEY,
  event_id       uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  aggregate_type text        NOT NULL,
  aggregate_id   text        NOT NULL,
  event_type     text        NOT NULL,
  payload        jsonb       NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);

CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- Webhooks
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_endpoints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url         text        NOT NULL,
  secret      text        NOT NULL,
  event_types text[]      NOT NULL DEFAULT ARRAY['*'],
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id      uuid        NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  event_id         uuid        NOT NULL,
  event_type       text        NOT NULL,
  payload          jsonb       NOT NULL,
  status           text        NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  attempts         integer     NOT NULL DEFAULT 0,
  response_status  integer,
  last_error       text,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Kafka is at-least-once; this makes the consumer idempotent.
  UNIQUE (endpoint_id, event_id)
);

CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at)
  WHERE status = 'PENDING';
CREATE INDEX webhook_deliveries_created_idx ON webhook_deliveries (created_at DESC);

-- ---------------------------------------------------------------------------
-- Reconciliation history
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text        NOT NULL CHECK (status IN ('BALANCED', 'MISMATCH')),
  report      jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- System accounts: funding source/sink and hold suspense per currency
-- ---------------------------------------------------------------------------
INSERT INTO accounts (kind, code, name, currency, allow_negative)
SELECT 'SYSTEM', kind || ':' || currency, name || ' (' || currency || ')', currency, allow_negative
FROM (VALUES ('settlement', 'Settlement', true), ('holds', 'Hold suspense', false)) AS k(kind, name, allow_negative)
CROSS JOIN (VALUES ('INR'), ('USD')) AS c(currency);
