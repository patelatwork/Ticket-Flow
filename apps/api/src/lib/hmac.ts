import { createHmac, timingSafeEqual } from 'node:crypto';

export function hmacSha256(secret: string, data: string | Buffer, encoding: 'hex' | 'base64url' = 'hex'): string {
  return createHmac('sha256', secret).update(data).digest(encoding);
}

/** Constant-time string comparison that is also safe for different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
