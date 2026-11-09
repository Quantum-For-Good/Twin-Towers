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

The integration test only accepts a disposable URL with host `127.0.0.1`, port
`5433`, database `kicks_disposable_test`, and no URL query parameters. The
current test reads `KICKS_DISPOSABLE_DATABASE_URL`; the follow-up naming uses
`KICKS_TEST_DATABASE_URL`. During that transition, set both names to the same
disposable URL. Never use `KICKS_DATABASE_URL` for this test. The test creates
and removes uniquely named schemas, verifies migrated tables and migration
history, and checks that a failed migration rolls its schema changes back.

The `quality` workflow starts an isolated PostgreSQL service for the test,
publishes it only on runner port `5433`, and fails early if either test variable
is missing. Locally, run
`npm run test --workspace @kicks/api` with the disposable variable(s) set;
without one, the integration test is skipped, not passed.

For the approved Windows D: drive disposable run, follow
[`DISPOSABLE_POSTGRES_WINDOWS.md`](DISPOSABLE_POSTGRES_WINDOWS.md). It creates
a fresh, loopback-only cluster and database; it must not connect to, stop, or
modify the existing PostgreSQL instance or port `5432`. The actual Windows
execution remains outside this run. Until it passes there, that operational
validation remains outstanding.
