import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { AppError } from '../../lib/errors.js';
import { getObjectStorage } from '../../lib/storage.js';
import { jobId } from '../../queues/definitions.js';
import { addToOutbox } from '../../queues/outbox.js';
import type { AuthUser } from '../auth/tokens.js';
import { listBookingSeatIds, lockBooking } from '../bookings/bookings.repository.js';
import { renderTicketPdf } from './pdf.js';
import { signQrToken, verifyQrToken } from './qr.js';
import * as repo from './tickets.repository.js';

export interface TicketDto {
  id: string;
  bookingId: string;
  eventId: string;
  eventTitle: string;
  venue: string;
  startsAt: string;
  seatLabel: string;
  tier: string;
  pricePaise: number;
  /** Shown as a QR code in the app as an alternative to the PDF. */
  qrToken: string;
  ready: boolean;
  usedAt: string | null;
  valid: boolean;
}

function toTicketDto(t: repo.TicketDetailsRow): TicketDto {
  return {
    id: t.id,
    bookingId: t.bookingId,
    eventId: t.eventId,
    eventTitle: t.eventTitle,
    venue: t.venue,
    startsAt: t.startsAt.toISOString(),
    seatLabel: t.seatLabel,
    tier: t.tier,
    pricePaise: t.pricePaise,
    qrToken: t.qrToken,
    ready: t.pdfKey !== null,
    usedAt: t.usedAt?.toISOString() ?? null,
    valid: t.bookingStatus === 'PAID',
  };
}

export type GenerateTicketsResult = { result: 'noop'; reason: string } | { result: 'generated'; created: number; rendered: number };

/**
 * `generate-tickets` job handler. Idempotent at every step, so any crash or retry
 * resumes where it stopped:
 *  1. tx: insert one ticket per seat (ON CONFLICT DO NOTHING on (booking, seat))
 *  2. render + upload each PDF still missing a key (PUT overwrites; key is deterministic)
 *  3. tx: outbox the notification (the handler dedupes by key, so repeats are harmless)
 */
export async function generateTickets(bookingId: string): Promise<GenerateTicketsResult> {
  const created = await withTransaction(async (tx) => {
    const booking = await lockBooking(tx, bookingId);
    if (booking?.status !== 'PAID') return undefined;
    const seatIds = await listBookingSeatIds(tx, bookingId);
    const tickets = seatIds.map((seatId) => {
      const id = randomUUID();
      return { id, seatId, qrToken: signQrToken(id) };
    });
    return repo.insertTickets(tx, bookingId, tickets);
  });
  if (created === undefined) return { result: 'noop', reason: 'booking is not PAID' };

  const storage = getObjectStorage();
  const tickets = await repo.listTicketDetailsForBooking(pool, bookingId);
  let rendered = 0;
  for (const t of tickets) {
    if (t.pdfKey) continue;
    const pdf = await renderTicketPdf({
      ticketId: t.id,
      qrToken: t.qrToken,
      eventTitle: t.eventTitle,
      venue: t.venue,
      startsAt: t.startsAt,
      seatLabel: t.seatLabel,
      tier: t.tier,
      pricePaise: t.pricePaise,
      attendeeEmail: t.attendeeEmail,
    });
    const key = `tickets/${bookingId}/${t.id}.pdf`;
    await storage.put(key, pdf, 'application/pdf');
    await repo.setTicketPdfKey(pool, t.id, key);
    rendered++;
  }

  await withTransaction(async (tx) => {
    await addToOutbox(tx, 'send-notification', { kind: 'tickets-ready', bookingId }, { jobId: jobId('notify', 'tickets', bookingId) });
  });
  return { result: 'generated', created, rendered };
}

export async function listMyTickets(user: AuthUser, bookingId?: string): Promise<TicketDto[]> {
  const rows = await repo.listTicketDetailsForUser(pool, user.id, bookingId);
  return rows.map(toTicketDto);
}

/** Owner-only, short-lived presigned URL straight to object storage. */
export async function getTicketDownload(user: AuthUser, ticketId: string): Promise<{ url: string; expiresAt: string }> {
  const ticket = await repo.findTicketDetails(pool, ticketId);
  if (ticket?.userId !== user.id) throw AppError.notFound('Ticket');
  if (ticket.bookingStatus !== 'PAID') throw AppError.conflict('TICKET_VOID', `Booking is ${ticket.bookingStatus}`);
  if (!ticket.pdfKey) throw AppError.conflict('TICKET_NOT_READY', 'The ticket PDF is still being generated');
  const ttl = env.TICKET_URL_TTL_SECONDS;
  const url = await getObjectStorage().presignGet(ticket.pdfKey, ttl, `ticket-${ticket.seatLabel}.pdf`);
  return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
}

export interface VerifyResult {
  ticket: { id: string; eventTitle: string; seatLabel: string; tier: string; usedAt: string };
}

/**
 * Gate check-in. The token's HMAC is checked first (forgeries never reach the DB); the
 * single conditional UPDATE then makes admission exactly-once under any concurrency.
 * Failures are diagnosed afterwards, read-only.
 */
export async function verifyTicket(user: AuthUser, qrToken: string): Promise<VerifyResult> {
  const ticketId = verifyQrToken(qrToken);
  if (!ticketId) throw AppError.unprocessable('INVALID_TICKET', 'QR code is not a valid TicketFlow ticket');

  const admitted = await repo.markTicketUsed(pool, { ticketId, qrToken, scannerId: user.id, isAdmin: user.role === 'admin' });
  const ticket = await repo.findTicketDetails(pool, ticketId);
  if (!ticket || ticket.qrToken !== qrToken) throw AppError.notFound('Ticket');
  if (admitted) {
    return {
      ticket: { id: ticket.id, eventTitle: ticket.eventTitle, seatLabel: ticket.seatLabel, tier: ticket.tier, usedAt: admitted.usedAt.toISOString() },
    };
  }
  if (user.role !== 'admin' && ticket.organizerId !== user.id) throw AppError.forbidden('This ticket is for another organizer’s event');
  if (ticket.bookingStatus !== 'PAID') throw AppError.conflict('TICKET_VOID', `Booking is ${ticket.bookingStatus}`);
  throw AppError.conflict('TICKET_ALREADY_USED', 'Ticket was already used', { usedAt: ticket.usedAt?.toISOString() ?? null });
}
