import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type ConsentAction = 'grant' | 'deny' | 'revoke';
export type ConsentDecision = {
  permissionId: string;
  requestId: string;
  expectedEventSequence?: number;
  subjectId: string;
  deviceId?: string;
  studyId?: string;
  scope?: Record<string, boolean>;
  priceCents?: number;
  expiresAt?: string;
  action: ConsentAction;
  policyVersion: string;
  purposeVersion: string;
  purpose: string;
};
export type ConsentEvent = ConsentDecision & { id: string; occurredAt: string; eventSequence?: number };
export type CurrentConsent = {
  // `id` is retained as a permission-id compatibility alias for older adapters.
  id?: string;
  decisionId?: string;
  decisionVersion?: string;
  subjectId: string;
  purpose: string;
  policyVersion: string;
  purposeVersion: string;
  state: 'granted' | 'revoked';
  expiresAt?: string;
};
export interface ConsentRepository {
  recordDecision(input: ConsentDecision): Promise<ConsentEvent>;
  getCurrent(permissionId: string): Promise<CurrentConsent | null>;
  getHistory(permissionId: string, subjectId: string): Promise<ConsentEvent[]>;
  getLatestForSubject?(subjectId: string): Promise<CurrentConsent | null>;
}

export function isValidGrantExpiry(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  const now = Date.now();
  return expiry > now && expiry <= now + 24 * 60 * 60 * 1000;
}

function sameScope(left: Record<string, boolean> | null, right?: Record<string, boolean>): boolean {
  if (left === null) return right === undefined;
  if (right === undefined) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export class PostgresConsentRepository implements ConsentRepository {
  constructor(private readonly pool: Pool) {}

  async recordDecision(input: ConsentDecision): Promise<ConsentEvent> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock both the globally unique idempotency key and the permission stream.
      // Sorting gives every transaction the same lock order and avoids deadlocks.
      const lockKeys = [`permission:${input.permissionId}`, `request:${input.requestId}`].sort();
      for (const lockKey of lockKeys) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      }
      const duplicate = await client.query<{ id: string; subject_id: string; permission_id: string; device_id: string | null; study_id: string | null; purpose: string; scope: Record<string, boolean> | null; price_cents: number | null; expires_at: Date | string | null; action: ConsentAction; policy_version: string; purpose_version: string; expected_event_sequence: number | null; event_sequence: number | string; occurred_at: Date | string }>(
        'SELECT id, subject_id, permission_id, device_id, study_id, purpose, scope, price_cents, expires_at, action, policy_version, purpose_version, expected_event_sequence, event_sequence, occurred_at FROM consent_events WHERE request_id = $1',
        [input.requestId]
      );
      if (duplicate.rows[0]) {
        const row = duplicate.rows[0];
        if (row.subject_id !== input.subjectId || row.permission_id !== input.permissionId || row.device_id !== (input.deviceId ?? null) || row.study_id !== (input.studyId ?? null) ||
          !sameScope(row.scope, input.scope) || (row.price_cents ?? undefined) !== input.priceCents ||
          (row.expires_at === null ? undefined : new Date(row.expires_at).getTime()) !== (input.expiresAt === undefined ? undefined : Date.parse(input.expiresAt)) ||
          row.action !== input.action || row.policy_version !== input.policyVersion || row.purpose_version !== input.purposeVersion || row.purpose !== input.purpose ||
          (row.expected_event_sequence === null ? undefined : Number(row.expected_event_sequence)) !== input.expectedEventSequence) {
          const error = new Error('idempotency_key_reused_with_different_request');
          (error as Error & { code?: string }).code = 'IDEMPOTENCY_CONFLICT';
          throw error;
        }
        await client.query('COMMIT');
        return { ...input, id: row.id, eventSequence: Number(row.event_sequence), occurredAt: new Date(row.occurred_at).toISOString() };
      }
      if (input.action === 'grant' && !isValidGrantExpiry(input.expiresAt)) {
        const error = new Error('grant_expiry_must_be_within_24_hours');
        (error as Error & { code?: string }).code = 'CONSENT_EXPIRY_INVALID';
        throw error;
      }
      const prior = await client.query<{ subject_id: string }>(
        'SELECT subject_id FROM consent_events WHERE permission_id = $1 ORDER BY event_sequence DESC LIMIT 1',
        [input.permissionId]
      );
      if (prior.rows[0] && prior.rows[0].subject_id !== input.subjectId) {
        const error = new Error('permission_owned_by_another_subject');
        (error as Error & { code?: string }).code = 'CONSENT_OWNER_MISMATCH';
        throw error;
      }
      const countResult = await client.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM consent_events WHERE permission_id = $1', [input.permissionId]
      );
      const currentSequence = countResult.rows[0]?.count ?? 0;
      if (input.expectedEventSequence !== undefined && input.expectedEventSequence !== currentSequence) {
        const error = new Error('stale_consent_decision');
        (error as Error & { code?: string }).code = 'CONSENT_STALE_DECISION';
        throw error;
      }
      const id = randomUUID();
      const result = await client.query<{ occurred_at: Date | string; event_sequence: number | string; expires_at: Date | string | null }>(
        `INSERT INTO consent_events
          (id, request_id, subject_id, permission_id, device_id, study_id, action, policy_version, purpose_version, purpose,
           scope, price_cents, expires_at, expected_event_sequence, event_sequence, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING occurred_at, event_sequence, expires_at`,
        [id, input.requestId, input.subjectId, input.permissionId, input.deviceId ?? null, input.studyId ?? null, input.action,
          input.policyVersion, input.purposeVersion, input.purpose, input.scope ? JSON.stringify(input.scope) : null,
          input.priceCents ?? null, input.expiresAt ?? null, input.expectedEventSequence ?? null, currentSequence + 1, id]
      );
      const saved = result.rows[0];
      if (!saved) throw new Error('consent_event_insert_returned_no_row');
      await client.query('COMMIT');
      return { ...input, id, eventSequence: Number(saved.event_sequence), occurredAt: new Date(saved.occurred_at).toISOString(), expiresAt: saved.expires_at ? new Date(saved.expires_at).toISOString() : undefined };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCurrent(permissionId: string): Promise<CurrentConsent | null> {
    const result = await this.pool.query<{
      id: string; subject_id: string; action: ConsentAction; policy_version: string;
      purpose_version: string; purpose: string; event_sequence: number | string; occurred_at: Date | string; expires_at: Date | string | null;
    }>(
      'SELECT id, subject_id, action, policy_version, purpose_version, purpose, event_sequence, occurred_at, expires_at FROM consent_events WHERE permission_id = $1 ORDER BY event_sequence DESC LIMIT 1',
      [permissionId]
    );
    const row = result.rows[0];
    if (!row) return null;
    // Purpose is persisted with each event; legacy rows are explicitly non-authorizing.
    return {
      id: permissionId, decisionId: row.id, decisionVersion: String(row.event_sequence),
      subjectId: row.subject_id, purpose: row.purpose,
      policyVersion: row.policy_version, purposeVersion: row.purpose_version,
      state: row.action === 'grant' && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now()) ? 'granted' : 'revoked',
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined
    };
  }

  async getLatestForSubject(subjectId: string): Promise<CurrentConsent | null> {
    const result = await this.pool.query<{
      permission_id: string; id: string; subject_id: string; action: ConsentAction; policy_version: string;
      purpose_version: string; purpose: string; event_sequence: number | string; occurred_at: Date | string; expires_at: Date | string | null;
    }>(
      `WITH current_events AS (
         SELECT DISTINCT ON (permission_id) permission_id, id, subject_id, action, policy_version,
                purpose_version, purpose, event_sequence, occurred_at, expires_at
           FROM consent_events
          WHERE subject_id = $1
          ORDER BY permission_id, event_sequence DESC
       )
       SELECT permission_id, id, subject_id, action, policy_version, purpose_version, purpose,
              event_sequence, occurred_at, expires_at
         FROM current_events
        WHERE action = 'grant' AND expires_at > now()
        ORDER BY occurred_at DESC
        LIMIT 1`,
      [subjectId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.permission_id, decisionId: row.id, decisionVersion: String(row.event_sequence),
      subjectId: row.subject_id, purpose: row.purpose, policyVersion: row.policy_version,
      purposeVersion: row.purpose_version,
      state: row.action === 'grant' && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now()) ? 'granted' : 'revoked',
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined
    };
  }

  async getHistory(permissionId: string, subjectId: string): Promise<ConsentEvent[]> {
    const result = await this.pool.query<{
      id: string; request_id: string; subject_id: string; device_id: string | null; study_id: string | null;
      scope: Record<string, boolean> | null; price_cents: number | null; action: ConsentAction; policy_version: string;
      purpose_version: string; purpose: string; expected_event_sequence: number | null; event_sequence: number | string; occurred_at: Date | string; expires_at: Date | string | null;
    }>(
      'SELECT id, request_id, subject_id, device_id, study_id, scope, price_cents, action, policy_version, purpose_version, purpose, expected_event_sequence, event_sequence, occurred_at, expires_at FROM consent_events WHERE permission_id = $1 AND subject_id = $2 ORDER BY event_sequence ASC',
      [permissionId, subjectId]
    );
    return result.rows.map(row => ({
      id: row.id, permissionId, requestId: row.request_id, subjectId: row.subject_id,
      deviceId: row.device_id ?? undefined, studyId: row.study_id ?? undefined,
      scope: row.scope ?? undefined, priceCents: row.price_cents ?? undefined, action: row.action,
      policyVersion: row.policy_version, purposeVersion: row.purpose_version,
      purpose: row.purpose, expectedEventSequence: row.expected_event_sequence === null ? undefined : Number(row.expected_event_sequence), eventSequence: Number(row.event_sequence), occurredAt: new Date(row.occurred_at).toISOString(), expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined
    }));
  }
}
