import type { Pool } from 'pg';
import type { DeviceRecord } from './device-repository.js';

export type BarrierDecision = {
  eventId: string;
  occurredAt: string;
  destinationHost: string;
  decision: 'allow' | 'block';
  reason: string | null;
  consentId: string | null;
};
export type BarrierDecisionBatch = {
  batchId: string;
  schemaVersion: '2026-11-10';
  decisions: BarrierDecision[];
};
export interface BarrierRepository {
  ingestBatch(device: DeviceRecord, batch: BarrierDecisionBatch): Promise<{ batchId: string; accepted: number }>;
}

export class PostgresBarrierRepository implements BarrierRepository {
  constructor(private readonly pool: Pool) {}

  async ingestBatch(device: DeviceRecord, batch: BarrierDecisionBatch): Promise<{ batchId: string; accepted: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const activeDevice = await client.query<{ id: string }>(
        'SELECT id FROM devices WHERE id = $1 AND subject_id = $2 AND revoked_at IS NULL FOR UPDATE',
        [device.id, device.subjectId]
      );
      if (!activeDevice.rows[0]) {
        const error = new Error('device_not_active');
        (error as Error & { code?: string }).code = 'DEVICE_NOT_ACTIVE';
        throw error;
      }

      // The barrier ledger is a historical record of gate decisions, not collected data:
      // a decision made under a consent that is later revoked is still a true record and
      // must still be ingested. So the check here is consent OWNERSHIP (the consent id
      // belongs to this subject), not an active grant. An allow always carries the live
      // grant's id; a block carries the last-known grant's id, or null when no consent
      // ever existed. This route deliberately does NOT go through the collector
      // authorization service: that service requires an active grant, which would reject
      // exactly the historical records the ledger exists to keep.
      const consentIds = [...new Set(batch.decisions.map(item => item.consentId).filter((id): id is string => id !== null))].sort();
      for (const consentId of consentIds) {
        // Share the same permission-stream lock as consent grant/revoke writes.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`permission:${consentId}`]);
      }

      for (const consentId of consentIds) {
        const latest = await client.query<{ subject_id: string }>(
          'SELECT subject_id FROM consent_events WHERE permission_id = $1 ORDER BY event_sequence DESC LIMIT 1',
          [consentId]
        );
        const consent = latest.rows[0];
        if (!consent || consent.subject_id !== device.subjectId) {
          const error = new Error('consent_not_found');
          (error as Error & { code?: string }).code = 'CONSENT_NOT_FOUND';
          throw error;
        }
      }

      await client.query(
        'INSERT INTO barrier_batches (id, device_id, schema_version, decision_count) VALUES ($1, $2, $3, $4)',
        [batch.batchId, device.id, batch.schemaVersion, batch.decisions.length]
      );
      for (const item of batch.decisions) {
        await client.query(
          `INSERT INTO barrier_decisions
            (id, batch_id, consent_id, occurred_at, destination_host, decision, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [item.eventId, batch.batchId, item.consentId, item.occurredAt, item.destinationHost, item.decision, item.reason]
        );
      }
      await client.query('COMMIT');
      return { batchId: batch.batchId, accepted: batch.decisions.length };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((error as { code?: string }).code === '23505') {
        const replay = new Error('batch_or_decision_replay');
        (replay as Error & { code?: string }).code = 'BATCH_REPLAY';
        throw replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
