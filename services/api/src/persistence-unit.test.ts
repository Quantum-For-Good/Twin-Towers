import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresConsentRepository } from './consent-repository.js';
import { PostgresDataSharingRepository } from './data-sharing-repository.js';

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
      if (sql.includes('INSERT INTO consent_events')) return { rows: [{ occurred_at: new Date('2026-01-01T00:00:00Z'), event_sequence: values[9] }] };
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
    assert.equal(calls.find(call => call.sql.includes('INSERT INTO consent_events'))?.values[9], 3);
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
