CREATE TABLE consent_events (
  id uuid PRIMARY KEY, subject_id uuid NOT NULL, permission_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('grant','deny','revoke')),
  policy_version text NOT NULL, purpose_version text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(), correlation_id uuid NOT NULL
);
REVOKE UPDATE, DELETE ON consent_events FROM PUBLIC;

CREATE TABLE metadata_batches (
  id uuid PRIMARY KEY, device_id uuid NOT NULL REFERENCES devices(id), schema_version text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), observation_count integer NOT NULL CHECK (observation_count BETWEEN 1 AND 250)
);
CREATE TABLE metadata_observations (
  id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES metadata_batches(id), consent_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL, source_app text, attribution text NOT NULL CHECK (attribution IN ('verified','best_effort','unknown')),
  destination_host text NOT NULL, protocol text NOT NULL, bytes_bucket text NOT NULL, classification text NOT NULL, consent_purpose text NOT NULL,
  CHECK (destination_host !~ '[/?:#]')
);
REVOKE UPDATE, DELETE ON metadata_batches, metadata_observations FROM PUBLIC;

-- Barrier ledger (Gated Fail-Closed Lock). Separate from the metadata batches and from
-- the consent ledger: one row per DNS gate decision. Append-only like the other
-- ledgers. consent_id is nullable by design: an allow always carries the live grant's
-- id, a block carries the last-known grant's id, or null when no consent ever existed.
CREATE TABLE barrier_batches (
  id uuid PRIMARY KEY, device_id uuid NOT NULL REFERENCES devices(id), schema_version text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), decision_count integer NOT NULL CHECK (decision_count BETWEEN 1 AND 250)
);
CREATE TABLE barrier_decisions (
  id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES barrier_batches(id), consent_id uuid,
  occurred_at timestamptz NOT NULL, destination_host text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow','block')),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 64),
  CHECK (destination_host !~ '[/?:#]')
);
REVOKE UPDATE, DELETE ON barrier_batches, barrier_decisions FROM PUBLIC;

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY, transaction_id uuid NOT NULL, account_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0), currency char(3) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(), external_reference text
);
REVOKE UPDATE, DELETE ON ledger_entries FROM PUBLIC;

CREATE TABLE audit_events (
  id uuid PRIMARY KEY, actor_id uuid, action text NOT NULL, target_type text NOT NULL,
  target_id uuid, outcome text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  correlation_id uuid NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
CREATE TABLE devices (
  id uuid PRIMARY KEY, subject_id uuid NOT NULL, token_hash text NOT NULL UNIQUE,
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
