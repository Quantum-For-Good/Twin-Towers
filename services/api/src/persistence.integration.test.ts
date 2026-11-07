import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresConsentRepository } from './consent-repository.js';
import { PostgresDeviceRepository } from './device-repository.js';
import { PostgresMetadataRepository, type MetadataBatch } from './metadata-repository.js';
import { runMigrations } from './migrations.js';
import { assertDisposableDatabaseUrl } from './disposable-test-database.js';

const databaseUrl = process.env.KICKS_DISPOSABLE_DATABASE_URL;

test('disposable database guard rejects other endpoints and connection overrides', () => {
  assert.doesNotThrow(() => assertDisposableDatabaseUrl('postgresql://test:test@127.0.0.1:5433/kicks_disposable_test'));
  for (const url of [
    'postgresql://test@127.0.0.1:5432/kicks_disposable_test',
    'postgresql://test@127.0.0.1:5433/other',
    'postgresql://test@localhost:5433/kicks_disposable_test',
    'postgresql://test@127.0.0.1:5433/kicks_disposable_test?host=remote'
  ]) assert.throws(() => assertDisposableDatabaseUrl(url));
});

test('disposable PostgreSQL retains consent, retries, revocation and batch replay across restarts', { skip: !databaseUrl && 'KICKS_DISPOSABLE_DATABASE_URL not set' }, async () => {
  assert.ok(databaseUrl);
  assertDisposableDatabaseUrl(databaseUrl);

  const schema = `kicks_test_${randomBytes(12).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool: pg.Pool | undefined;
  let schemaCreated = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const newPool = () => new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    pool = newPool();
    await runMigrations(pool);
    await runMigrations(pool);
    const device = { id: randomUUID(), subjectId: randomUUID(), tokenHash: randomBytes(32).toString('hex'), revoked: false };
    const decision = {
      permissionId: randomUUID(), requestId: randomUUID(), expectedEventSequence: 0,
      subjectId: device.subjectId, action: 'grant' as const, policyVersion: '1',
      purposeVersion: '1', purpose: 'Detect unexpected data destinations'
    };
    await new PostgresDeviceRepository(pool).create(device, 'staging');
    const repository = new PostgresConsentRepository(pool);
    const grant = await repository.recordDecision(decision);
    assert.equal((await repository.recordDecision(decision)).id, grant.id);
    await assert.rejects(repository.recordDecision({ ...decision, expectedEventSequence: 1 }), /idempotency_key_reused/);
    await assert.rejects(pool.query('UPDATE consent_events SET purpose = $1 WHERE id = $2', ['other', grant.id]), /append-only/);
    await assert.rejects(pool.query('TRUNCATE consent_events'), /append-only/);

    await pool.end();
    pool = newPool();
    assert.equal((await new PostgresDeviceRepository(pool).findActiveByTokenHash(device.tokenHash))?.id, device.id);
    assert.equal((await new PostgresConsentRepository(pool).getCurrent(decision.permissionId))?.state, 'granted');
    const batch: MetadataBatch = {
      batchId: randomUUID(), schemaVersion: '2026-08-01', observations: [{
        eventId: randomUUID(), occurredAt: new Date().toISOString(), sourceApp: null, attribution: 'unknown',
        destinationHost: 'example.com', protocol: 'dns', bytesBucket: '0-1KB', classification: 'unknown',
        consentId: decision.permissionId, consentPurpose: decision.purpose
      }]
    };
    const metadata = new PostgresMetadataRepository(pool);
    assert.equal((await metadata.ingestBatch(device, batch)).accepted, 1);
    await assert.rejects(metadata.ingestBatch(device, batch), /batch_or_observation_replay/);
    await new PostgresConsentRepository(pool).recordDecision({ ...decision, requestId: randomUUID(), action: 'revoke', expectedEventSequence: 1 });
    await assert.rejects(metadata.ingestBatch(device, { ...batch, batchId: randomUUID() }), /active_purpose_consent_required/);
    await pool.end();
    pool = newPool();
    assert.equal((await new PostgresConsentRepository(pool).getCurrent(decision.permissionId))?.state, 'revoked');
    assert.equal((await new PostgresConsentRepository(pool).getHistory(decision.permissionId, device.subjectId)).length, 2);
    assert.equal(await new PostgresDeviceRepository(pool).revokeByTokenHash(device.tokenHash), true);
    assert.equal(await new PostgresDeviceRepository(pool).findActiveByTokenHash(device.tokenHash), null);
  } finally {
    if (pool) await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
