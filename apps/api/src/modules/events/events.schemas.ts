import { z } from 'zod';

const futureDate = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v))
  .refine((d) => d.getTime() > Date.now(), 'must be in the future');

export const EventIdParamsSchema = z.object({ id: z.uuid() });
export const SeatParamsSchema = z.object({ id: z.uuid(), seatId: z.uuid() });

export const CreateEventBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).default(''),
  venue: z.string().trim().min(1).max(200),
  startsAt: futureDate,
});
export type CreateEventBody = z.infer<typeof CreateEventBodySchema>;

export const UpdateEventBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000),
    venue: z.string().trim().min(1).max(200),
    startsAt: futureDate,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');
export type UpdateEventBody = z.infer<typeof UpdateEventBodySchema>;

export const AddSeatsBodySchema = z.object({
  seats: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(20),
        tier: z.string().trim().min(1).max(40),
        // Integer paise; upper bound of ₹10,00,000 per seat guards against unit mistakes.
        pricePaise: z.number().int().positive().max(100_000_000),
      }),
    )
    .min(1)
    .max(1000)
    .refine((seats) => new Set(seats.map((s) => s.label)).size === seats.length, 'seat labels must be unique'),
});
export type AddSeatsBody = z.infer<typeof AddSeatsBodySchema>;

export const ListEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
export type ListEventsQuery = z.infer<typeof ListEventsQuerySchema>;
