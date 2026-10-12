import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import * as repo from './auth.repository.js';
import type { LoginBody, RegisterBody } from './auth.schemas.js';
import { signAccessToken, type AuthUser, type Role } from './tokens.js';

export interface PublicUser {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface Session {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

function toPublicUser(user: repo.UserRecord): PublicUser {
  return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt.toISOString() };
}

async function issueSession(db: Queryable, user: AuthUser, familyId: string): Promise<{ session: Session; tokenId: string }> {
  const refreshToken = randomToken();
  const refreshTokenExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const tokenId = await repo.insertRefreshToken(db, {
    userId: user.id,
    familyId,
    tokenHash: sha256Hex(refreshToken),
    expiresAt: refreshTokenExpiresAt,
  });
  return {
    tokenId,
    session: {
      accessToken: signAccessToken(user),
      accessTokenExpiresIn: env.JWT_ACCESS_TTL_SECONDS,
      refreshToken,
      refreshTokenExpiresAt,
    },
  };
}

export async function register(input: RegisterBody): Promise<{ user: PublicUser; session: Session }> {
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
  return withTransaction(async (tx) => {
    const user = await repo.insertUser(tx, { email: input.email, passwordHash, role: input.role });
    if (!user) throw AppError.conflict('EMAIL_TAKEN', 'An account with this email already exists');
    const { session } = await issueSession(tx, user, randomUUID());
    return { user: toPublicUser(user), session };
  });
}

// Compared against when the email is unknown so login timing does not reveal which emails exist.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash('timing-equalizer', env.BCRYPT_ROUNDS);
  return dummyHash;
}

export async function login(input: LoginBody): Promise<{ user: PublicUser; session: Session }> {
  const user = await repo.findUserByEmail(pool, input.email);
  const ok = await bcrypt.compare(input.password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !ok) throw AppError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  const { session } = await issueSession(pool, user, randomUUID());
  return { user: toPublicUser(user), session };
}

type RefreshOutcome = { ok: true; session: Session } | { ok: false; reason: 'unknown' | 'expired' | 'reused' };

/**
 * Rotates a refresh token. Presenting an already-rotated token is treated as theft:
 * the whole token family is revoked, logging out every session derived from that login.
 */
export async function refresh(rawToken: string | undefined): Promise<Session> {
  if (!rawToken) throw AppError.unauthorized('Missing refresh token', 'INVALID_REFRESH_TOKEN');

  // The transaction commits even on failure so a family revocation is persisted.
  const outcome = await withTransaction(async (tx): Promise<RefreshOutcome> => {
    const token = await repo.lockRefreshTokenByHash(tx, sha256Hex(rawToken));
    if (!token) return { ok: false, reason: 'unknown' };
    if (token.revokedAt) {
      await repo.revokeRefreshTokenFamily(tx, token.familyId);
      return { ok: false, reason: 'reused' };
    }
    if (token.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

    const { session, tokenId } = await issueSession(tx, { id: token.userId, role: token.role }, token.familyId);
    await repo.markRefreshTokenRotated(tx, token.id, tokenId);
    return { ok: true, session };
  });

  if (!outcome.ok) {
    if (outcome.reason === 'reused') logger.warn('refresh token reuse detected; token family revoked');
    throw AppError.unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  }
  return outcome.session;
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  await withTransaction(async (tx) => {
    const token = await repo.lockRefreshTokenByHash(tx, sha256Hex(rawToken));
    if (token) await repo.revokeRefreshTokenFamily(tx, token.familyId);
  });
}

export async function getProfile(userId: string): Promise<PublicUser> {
  const user = await repo.findUserById(pool, userId);
  if (!user) throw AppError.notFound('User');
  return toPublicUser(user);
}
