import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigrations, type Migration, type MigrationClient } from './migrations.js';

const migrations: Migration[] = [
  { name: '001_first.sql', sql: 'first migration', checksum: 'a' },
  { name: '002_second.sql', sql: 'second migration', checksum: 'b' }
];

function clientWith(rows: { name: string; checksum: string }[], failOn?: string) {
  const calls: string[] = [];
  const client: MigrationClient = {
    async query(sql) {
      calls.push(sql);
      if (sql === failOn) throw new Error('test failure');
      return { rows: sql === 'SELECT name, checksum FROM schema_migrations' ? rows : [] };
    }
  };
  return { client, calls };
}

test('migration runner locks, applies only pending migrations and commits', async () => {
  const { client, calls } = clientWith([{ name: '001_first.sql', checksum: 'a' }]);
  await applyMigrations(client, migrations);
  assert.equal(calls[0], 'BEGIN');
  assert.ok(calls.some(call => call.includes('pg_advisory_xact_lock')));
  assert.ok(!calls.includes('first migration'));
  assert.ok(calls.includes('second migration'));
  assert.equal(calls.at(-1), 'COMMIT');
});

test('migration runner rejects changed and out-of-order history', async () => {
  for (const rows of [
    [{ name: '001_first.sql', checksum: 'changed' }],
    [{ name: '002_second.sql', checksum: 'b' }],
    [{ name: '003_unknown.sql', checksum: 'c' }]
  ]) {
    const { client, calls } = clientWith(rows);
    await assert.rejects(applyMigrations(client, migrations), /database_migration_/);
    assert.equal(calls.at(-1), 'ROLLBACK');
    assert.ok(!calls.includes('first migration'));
  }
});

test('migration runner rolls back a failing migration', async () => {
  const { client, calls } = clientWith([], 'second migration');
  await assert.rejects(applyMigrations(client, migrations), /test failure/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(!calls.includes('COMMIT'));
});
