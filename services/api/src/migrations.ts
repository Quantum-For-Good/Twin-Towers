import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export type Migration = { name: string; sql: string; checksum: string };
export interface MigrationClient {
  query(sql: string, values?: string[]): Promise<{ rows: { name: string; checksum: string }[] }>;
}

export async function runMigrations(pool: Pool): Promise<void> {
  const directory = fileURLToPath(new URL('../db/migrations/', import.meta.url));
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('no_database_migrations_found');
  const migrations = await Promise.all(files.map(async name => {
    const sql = await readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  const client = await pool.connect();
  try {
    await applyMigrations(client, migrations);
  } finally {
    client.release();
  }
}

export async function applyMigrations(client: MigrationClient, migrations: Migration[]): Promise<void> {
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('kicks_schema_migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const result = await client.query('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(result.rows.map(row => [row.name, row.checksum]));
    for (const [name, checksum] of applied) {
      if (!migrations.some(migration => migration.name === name && migration.checksum === checksum)) {
        throw new Error(`database_migration_missing_or_modified:${name}`);
      }
    }
    let unappliedSeen = false;
    for (const migration of migrations) {
      if (!applied.has(migration.name)) unappliedSeen = true;
      else if (unappliedSeen) throw new Error(`database_migration_out_of_order:${migration.name}`);
    }
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
