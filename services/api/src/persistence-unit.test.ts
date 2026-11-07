import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresConsentRepository } from './consent-repository.js';
import { PostgresDataSharingRepository } from './data-sharing-repository.js';
import { PostgresMetadataRepository, type MetadataBatch } from './metadata-repository.js';

test('consent repository writes the next permission-specific sequence under its stream lock', async () => {
  const pool = new pg.Pool();
  const calls: { sql: string; values: unknown[] }[] = [];
  let released = false;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes('WHERE request_id')) return { rows: [] };
      if (sql.includes('SELECT subject_id FROM consent_events')) return { rows: [{ subject_id: subjectId }] };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: 2 }] };
      if (sql.includes('INSERT INTO consent_events')) return { rows: [{ occurred_at: new Date('2026-01-01T00:00:00Z'), event_sequence: values[14], expires_at: values[12] }] };
      return { rows: [] };
    },
    release() { released = true; }
  };
  Object.defineProperty(pool, 'connect', { value: async () => client });
  const subjectId = randomUUID();
  const permissionId = randomUUID();
  try {
    const event = await new PostgresConsentRepository(pool).recordDecision({
      permissionId, requestId: randomUUID(), expectedEventSequence: 2, subjectId, action: 'revoke',
      policyVersion: '1', purposeVersion: '1', purpose: 'Detect unexpected data destinations'
    });
    assert.equal(event.eventSequence, 3);
    assert.ok(calls.some(call => call.sql.includes('pg_advisory_xact_lock') && call.values[0] === `permission:${permissionId}`));
    assert.equal(calls.find(call => call.sql.includes('INSERT INTO consent_events'))?.values[14], 3);
    assert.equal(calls.at(-1)?.sql, 'COMMIT');
    assert.equal(released, true);
  } finally { await pool.end(); }
});

test('data-sharing writes use the subject lock and roll back on failure', async () => {
  const pool = new pg.Pool();
  const calls: { sql: string; values: unknown[] }[] = [];
  let released = false;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes('INSERT INTO data_sharing')) throw new Error('test persistence failure');
      return { rows: [] };
    },
    release() { released = true; }
  };
  Object.defineProperty(pool, 'connect', { value: async () => client });
  const subjectId = randomUUID();
  try {
    await assert.rejects(new PostgresDataSharingRepository(pool).set(subjectId, false), /test persistence failure/);
    assert.ok(calls.some(call => call.sql.includes('pg_advisory_xact_lock') && call.values[0] === `data-sharing:${subjectId}`));
    assert.equal(calls.at(-1)?.sql, 'ROLLBACK');
    assert.equal(released, true);
  } finally { await pool.end(); }
});

test('metadata ingestion rejects expired grants before storing a batch', async () => {
  const pool = new pg.Pool();
  const calls: string[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes('FROM devices')) return { rows: [{ id: randomUUID() }] };
      if (sql.includes('FROM data_sharing')) return { rows: [{ enabled: true }] };
      if (sql.includes('FROM consent_events')) return { rows: [{
        subject_id: randomUUID(), action: 'grant', purpose: 'Detect unexpected data destinations',
        expires_at: new Date(Date.now() - 1_000)
      }] };
      return { rows: [] };
    },
    release() {}
  };
  Object.defineProperty(pool, 'connect', { value: async () => client });
  const device = { id: randomUUID(), subjectId: randomUUID(), tokenHash: 'hash', revoked: false };
  const batch: MetadataBatch = {
    batchId: randomUUID(), schemaVersion: '2026-08-01', observations: [{
      eventId: randomUUID(), occurredAt: new Date().toISOString(), sourceApp: null, attribution: 'unknown',
      destinationHost: 'example.com', protocol: 'dns', bytesBucket: '0-1KB', classification: 'unknown',
      consentId: randomUUID(), consentPurpose: 'Detect unexpected data destinations'
    }]
  };
  try {
    await assert.rejects(
      new PostgresMetadataRepository(pool).ingestBatch(device, batch),
      (error: Error & { code?: string }) => error.code === 'ACTIVE_PURPOSE_CONSENT_REQUIRED'
    );
    assert.ok(!calls.some(sql => sql.includes('INSERT INTO metadata_batches')));
  } finally { await pool.end(); }
});
