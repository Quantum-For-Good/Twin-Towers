import type { Pool, PoolClient } from 'pg';

export interface DataSharingRepository {
  get(subjectId: string): Promise<boolean>;
  set(subjectId: string, enabled: boolean): Promise<void>;
}

export async function lockDataSharing(client: PoolClient, subjectId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`data-sharing:${subjectId}`]);
}

export class PostgresDataSharingRepository implements DataSharingRepository {
  constructor(private readonly pool: Pool) {}

  async get(subjectId: string): Promise<boolean> {
    const result = await this.pool.query<{ enabled: boolean }>(
      'SELECT enabled FROM data_sharing WHERE subject_id = $1', [subjectId]
    );
    return result.rows[0]?.enabled === true;
  }

  async set(subjectId: string, enabled: boolean): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockDataSharing(client, subjectId);
      await client.query(
        `INSERT INTO data_sharing (subject_id, enabled) VALUES ($1, $2)
         ON CONFLICT (subject_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [subjectId, enabled]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
