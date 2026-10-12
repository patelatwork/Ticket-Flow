import { z } from 'zod';

export const MAX_SEATS_PER_BOOKING = 10;

export const CreateBookingBodySchema = z.object({
  eventId: z.uuid(),
  seatIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_SEATS_PER_BOOKING)
    .refine((ids) => new Set(ids).size === ids.length, 'seatIds must not contain duplicates'),
});
export type CreateBookingBody = z.infer<typeof CreateBookingBodySchema>;

/** Printable ASCII without spaces; clients typically send a UUID. */
export const IdempotencyKeySchema = z
  .string({ error: 'Idempotency-Key header is required' })
  .regex(/^[\x21-\x7E]{8,255}$/, 'Idempotency-Key must be 8-255 printable ASCII characters');

export const BookingIdParamsSchema = z.object({ id: z.uuid() });
