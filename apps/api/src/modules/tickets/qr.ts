import { z } from 'zod';
import { env } from '../../config/env.js';
import { hmacSha256, safeEqual } from '../../lib/hmac.js';

const VERSION = 't1';
const TicketIdSchema = z.uuid();

/**
 * QR payload: `t1.<ticketId>.<hmac>`. The HMAC (keyed by TICKET_QR_SECRET) lets a scanner
 * reject forged codes before touching the database. Single use is enforced in the
 * database, not by the token. The token is also stored (unique) so lookups are by exact
 * match.
 */
export function signQrToken(ticketId: string, secret: string = env.TICKET_QR_SECRET): string {
  const body = `${VERSION}.${ticketId}`;
  return `${body}.${hmacSha256(secret, body, 'base64url')}`;
}

/** Returns the ticket id if the token is well-formed and authentic, else undefined. */
export function verifyQrToken(token: string, secret: string = env.TICKET_QR_SECRET): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [version, ticketId, signature] = parts as [string, string, string];
  if (version !== VERSION || !TicketIdSchema.safeParse(ticketId).success) return undefined;
  return safeEqual(signature, hmacSha256(secret, `${version}.${ticketId}`, 'base64url')) ? ticketId : undefined;
}
