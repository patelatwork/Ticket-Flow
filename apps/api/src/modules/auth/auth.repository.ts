import type { Queryable, TxClient } from '../../db/tx.js';
import type { Role } from './tokens.js';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: Date;
}

const USER_COLUMNS = 'id, email, password_hash AS "passwordHash", role, created_at AS "createdAt"';

export async function findUserByEmail(db: Queryable, email: string): Promise<UserRecord | undefined> {
  const { rows } = await db.query<UserRecord>(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [email]);
  return rows[0];
}

export async function findUserById(db: Queryable, id: string): Promise<UserRecord | undefined> {
  const { rows } = await db.query<UserRecord>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0];
}

/** Returns undefined when the email is already registered. */
export async function insertUser(
  db: Queryable,
  user: { email: string; passwordHash: string; role: Role },
): Promise<UserRecord | undefined> {
  const { rows } = await db.query<UserRecord>(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING
     RETURNING ${USER_COLUMNS}`,
    [user.email, user.passwordHash, user.role],
  );
  return rows[0];
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  role: Role;
}

export async function insertRefreshToken(
  db: Queryable,
  token: { userId: string; familyId: string; tokenHash: string; expiresAt: Date },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [token.userId, token.familyId, token.tokenHash, token.expiresAt],
  );
  const row = rows[0];
  if (!row) throw new Error('insertRefreshToken returned no row');
  return row.id;
}

/** Locks the token row so concurrent refreshes of the same token serialize. */
export async function lockRefreshTokenByHash(tx: TxClient, tokenHash: string): Promise<RefreshTokenRecord | undefined> {
  const { rows } = await tx.query<RefreshTokenRecord>(
    `SELECT rt.id, rt.user_id AS "userId", rt.family_id AS "familyId", rt.expires_at AS "expiresAt",
            rt.revoked_at AS "revokedAt", u.role
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1
      FOR UPDATE OF rt`,
    [tokenHash],
  );
  return rows[0];
}

export async function markRefreshTokenRotated(tx: TxClient, id: string, replacedBy: string): Promise<void> {
  await tx.query(`UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`, [id, replacedBy]);
}

export async function revokeRefreshTokenFamily(db: Queryable, familyId: string): Promise<void> {
  await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [familyId]);
}
