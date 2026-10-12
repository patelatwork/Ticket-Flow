import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

export const ROLES = ['attendee', 'organizer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface AuthUser {
  id: string;
  role: Role;
}

const ISSUER = 'ticketflow';

const AccessClaimsSchema = z.object({
  sub: z.uuid(),
  role: z.enum(ROLES),
  typ: z.literal('access'),
});

export function signAccessToken(user: AuthUser): string {
  return jwt.sign({ role: user.role, typ: 'access' }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: user.id,
    issuer: ISSUER,
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AuthUser {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    throw AppError.unauthorized(expired ? 'Access token expired' : 'Invalid access token', expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN');
  }
  const claims = AccessClaimsSchema.safeParse(decoded);
  if (!claims.success) throw AppError.unauthorized('Invalid access token', 'INVALID_TOKEN');
  return { id: claims.data.sub, role: claims.data.role };
}
