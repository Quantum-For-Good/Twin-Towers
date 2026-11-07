# Phase 0 persistence foundation (incomplete)

The API uses the migration runner and PostgreSQL repositories at startup when
`KICKS_DATABASE_URL` is configured. Production refuses to start without that
dedicated setting. Without it, local development uses in-memory stores.
`001_phase0_foundation.sql` is a starting point for a new empty database, not an
upgrade or data-migration path; do not apply it to an existing database. The
older `schema.sql` is not a migration.

The API persists consent scope and expiry, stores data-sharing independently from
consent, and exposes a chain-independent eligibility decision. Metadata ingestion
rechecks the active device, unexpired purpose consent and sharing state in its
transaction. These guarantees still require the disposable PostgreSQL integration
test before durable behavior is considered verified. Device keypair-signed
enrollment is not implemented; production bootstrap enrollment is disabled.
Turning sharing off stops local collectors through the configured stop hook;
native queued-data purge and 15-second authority polling still need end-to-end
verification. The separate evidence-provider path still requires chain proof.

The integration test only accepts `KICKS_DISPOSABLE_DATABASE_URL` with host
`127.0.0.1`, port `5433`, database `kicks_disposable_test`, and no URL query
parameters. Provision that disposable database separately on the designated
D: drive using the approved runbook; never point tests at an existing database.
The test creates and removes a uniquely named schema within that database. Run
`npm run test --workspace @kicks/api` with the variable set. Without it, the
integration test is explicitly skipped, not passed.

The approved D: drive runbook is not present in this checkout. The migration
runner is implemented in `src/migrations.ts`; until the integration test is run
on the designated disposable database, the SQL migration and restart guarantees
remain unverified.
