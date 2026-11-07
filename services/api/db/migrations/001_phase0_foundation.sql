CREATE TABLE devices (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  environment text NOT NULL CHECK (environment IN ('staging', 'production')),
  issuer text,
  did text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_events (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  subject_id uuid NOT NULL,
  permission_id uuid NOT NULL,
  device_id uuid REFERENCES devices(id),
  study_id text,
  purpose text NOT NULL,
  scope jsonb,
  price_cents integer CHECK (price_cents >= 0),
  policy_version text NOT NULL,
  purpose_version text NOT NULL,
  action text NOT NULL CHECK (action IN ('grant', 'deny', 'revoke')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  expected_event_sequence integer CHECK (expected_event_sequence >= 0),
  event_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  correlation_id uuid NOT NULL,
  CHECK (scope IS NULL OR jsonb_typeof(scope) = 'object'),
  CHECK (expires_at IS NULL OR expires_at > occurred_at)
);
CREATE INDEX consent_events_permission_sequence_idx ON consent_events (permission_id, event_sequence DESC);

CREATE TABLE data_sharing (
  subject_id uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE metadata_batches (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id),
  schema_version text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  observation_count integer NOT NULL CHECK (observation_count BETWEEN 1 AND 250)
);
CREATE TABLE metadata_observations (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES metadata_batches(id),
  consent_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  source_app text,
  attribution text NOT NULL CHECK (attribution IN ('verified', 'best_effort', 'unknown')),
  destination_host text NOT NULL CHECK (destination_host !~ '[/?:#]'),
  protocol text NOT NULL,
  bytes_bucket text NOT NULL,
  classification text NOT NULL,
  consent_purpose text NOT NULL
);

CREATE FUNCTION reject_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table % cannot be modified', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER consent_events_append_only BEFORE UPDATE OR DELETE ON consent_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER consent_events_no_truncate BEFORE TRUNCATE ON consent_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER metadata_batches_append_only BEFORE UPDATE OR DELETE ON metadata_batches
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER metadata_batches_no_truncate BEFORE TRUNCATE ON metadata_batches
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER metadata_observations_append_only BEFORE UPDATE OR DELETE ON metadata_observations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER metadata_observations_no_truncate BEFORE TRUNCATE ON metadata_observations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
