import { z } from 'zod';

export const ListTicketsQuerySchema = z.object({ bookingId: z.uuid().optional() });
export const TicketIdParamsSchema = z.object({ id: z.uuid() });
export const VerifyTicketBodySchema = z.object({ qrToken: z.string().min(10).max(200) });
