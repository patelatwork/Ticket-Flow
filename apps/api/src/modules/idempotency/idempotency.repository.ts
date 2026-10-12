import type { TxClient } from '../../db/tx.js';

export type ClaimResult =
  | { kind: 'claimed' }
  | { kind: 'existing'; requestHash: string; statusCode: number | null; body: unknown };

/**
 * Claims an idempotency key inside the caller's transaction.
 *
 * If another transaction holds an uncommitted claim on the same key, the INSERT blocks
 * on the primary key until that transaction finishes. If it committed, we get its
 * stored response ('existing'); if it rolled back, our INSERT wins ('claimed'). So
 * concurrent duplicates are serialized by Postgres and never execute twice.
 */
export async function claimKey(tx: TxClient, userId: string, key: string, requestHash: string): Promise<ClaimResult> {
  const inserted = await tx.query(
    `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO NOTHING
     RETURNING 1`,
    [userId, key, requestHash],
  );
  if (inserted.rowCount === 1) return { kind: 'claimed' };

  const { rows } = await tx.query<{ requestHash: string; statusCode: number | null; body: unknown }>(
    `SELECT request_hash AS "requestHash", status_code AS "statusCode", response_body AS body
       FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
    [userId, key],
  );
  const row = rows[0];
  if (!row) throw new Error('idempotency key vanished between INSERT and SELECT');
  return { kind: 'existing', ...row };
}

export async function saveResponse(tx: TxClient, userId: string, key: string, statusCode: number, body: unknown): Promise<void> {
  await tx.query(
    `UPDATE idempotency_keys SET status_code = $3, response_body = $4::jsonb WHERE user_id = $1 AND key = $2`,
    [userId, key, statusCode, JSON.stringify(body)],
  );
}
