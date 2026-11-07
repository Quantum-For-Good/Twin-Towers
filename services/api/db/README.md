# Phase 0 persistence foundation (incomplete)

The API uses the migration runner and PostgreSQL repositories at startup when
`KICKS_DATABASE_URL` is configured. Production refuses to start without that
dedicated setting. Without it, local development uses in-memory stores.
`001_phase0_foundation.sql` is a starting point for a new empty database, not an
upgrade or data-migration path; do not apply it to an existing database. The
older `schema.sql` is not a migration.

The foundation preserves compatibility with the current device, consent and
metadata repositories. Nullable study fields are not an authorization contract:
study scope, expiry, ownership, data-sharing persistence and the chain-independent
eligibility oracle must be implemented and verified before enabling real grants.
Data-sharing routes use the PostgreSQL repository, and metadata ingestion checks
the sharing state under the same subject lock used by updates. Turning sharing
off stops local collectors through the configured stop hook; native queued-data
purge and 15-second authority polling still need end-to-end verification.
The existing evidence provider still requires chain proof; this work does not
change that behavior.

The integration test only accepts `KICKS_DISPOSABLE_DATABASE_URL` with host
`127.0.0.1`, port `5433`, database `kicks_disposable_test`, and no URL query
parameters. Provision that disposable database separately on the designated
D: drive using the approved runbook; never point tests at an existing database.
The test creates and removes a uniquely named schema within that database. Run
`npm run test --workspace @kicks/api` with the variable set. Without it, the
integration test is explicitly skipped, not passed.

The approved D: drive runbook and an existing migration runner are not present
in this checkout. Until the integration test is run on the designated disposable
database, the SQL migration and restart guarantees remain unverified.
