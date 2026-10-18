import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { InMemoryObjectStorage, setObjectStorage } from '../src/lib/storage.js';
import { transitionBooking } from '../src/modules/bookings/booking-state.js';
import { LogMailer, sendNotification, setMailer } from '../src/modules/notifications/notifications.service.js';
import { generateDailySalesReport } from '../src/modules/reports/reports.service.js';
import { signQrToken, verifyQrToken } from '../src/modules/tickets/qr.js';
import { generateTickets } from '../src/modules/tickets/tickets.service.js';
import { bookSeats, createPublishedEvent, createUser, outboxRows, useTestServer, type TestUser } from './helpers.js';

const { url } = useTestServer();

let storage: InMemoryObjectStorage;
let mailer: LogMailer;

beforeEach(() => {
  storage = new InMemoryObjectStorage();
  setObjectStorage(storage);
  mailer = new LogMailer();
  setMailer(mailer);
});

async function paidBooking(seats = 2): Promise<{ bookingId: string; buyer: TestUser; organizer: TestUser; eventId: string }> {
  const organizer = await createUser('organizer');
  const { eventId, seatIds } = await createPublishedEvent(seats, organizer);
  const buyer = await createUser();
  const bookingId = await bookSeats(url(), buyer, eventId, seatIds);
  await withTransaction((tx) => transitionBooking(tx, bookingId, 'PAID'));
  return { bookingId, buyer, organizer, eventId };
}

async function ticketsOf(bookingId: string): Promise<{ id: string; qrToken: string; pdfKey: string | null }[]> {
  const { rows } = await pool.query<{ id: string; qrToken: string; pdfKey: string | null }>(
    `SELECT id, qr_token AS "qrToken", pdf_key AS "pdfKey" FROM tickets WHERE booking_id = $1 ORDER BY id`,
    [bookingId],
  );
  return rows;
}

describe('QR tokens', () => {
  it('round-trips and rejects tampering', () => {
    const id = '7d3c1f0e-6a5b-4c2d-9e8f-0a1b2c3d4e5f';
    const token = signQrToken(id);
    expect(verifyQrToken(token)).toBe(id);
    expect(verifyQrToken(token.replace(id, '00000000-0000-4000-8000-000000000000'))).toBeUndefined();
    expect(verifyQrToken(`${token}x`)).toBeUndefined();
    expect(verifyQrToken('garbage')).toBeUndefined();
  });
});

describe('generate-tickets job', () => {
  it('creates one ticket per seat with a PDF in storage, then queues the notification', async () => {
    const { bookingId } = await paidBooking(3);
    const result = await generateTickets(bookingId);
    expect(result).toEqual({ result: 'generated', created: 3, rendered: 3 });

    const tickets = await ticketsOf(bookingId);
    expect(tickets).toHaveLength(3);
    for (const t of tickets) {
      expect(verifyQrToken(t.qrToken)).toBe(t.id);
      const obj = storage.objects.get(t.pdfKey ?? '');
      expect(obj?.contentType).toBe('application/pdf');
      expect(obj?.body.subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect((await outboxRows('send-notification')).map((r) => r.payload)).toEqual([{ kind: 'tickets-ready', bookingId }]);
  });

  it('is idempotent: re-running (or running concurrently) never duplicates tickets', async () => {
    const { bookingId } = await paidBooking(2);
    await Promise.all([generateTickets(bookingId), generateTickets(bookingId), generateTickets(bookingId)]);
    const again = await generateTickets(bookingId);
    expect(again).toEqual({ result: 'generated', created: 0, rendered: 0 });
    expect(await ticketsOf(bookingId)).toHaveLength(2);
  });

  it('resumes after a crash between ticket insert and PDF upload', async () => {
    const { bookingId } = await paidBooking(2);
    await generateTickets(bookingId);
    await pool.query(`UPDATE tickets SET pdf_key = NULL WHERE booking_id = $1`, [bookingId]);
    storage.objects.clear();
    expect(await generateTickets(bookingId)).toEqual({ result: 'generated', created: 0, rendered: 2 });
    expect(storage.objects.size).toBe(2);
  });

  it('does nothing for a booking that is not PAID', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const bookingId = await bookSeats(url(), await createUser(), eventId, seatIds);
    expect(await generateTickets(bookingId)).toEqual({ result: 'noop', reason: 'booking is not PAID' });
  });
});

describe('ticket download', () => {
  it('returns a short-lived URL to the owner only', async () => {
    const { bookingId, buyer } = await paidBooking(1);
    await generateTickets(bookingId);
    const [ticket] = await ticketsOf(bookingId);

    const list = await request(url()).get('/tickets').set(buyer.auth);
    expect(list.body.tickets).toHaveLength(1);
    expect(list.body.tickets[0].ready).toBe(true);

    const res = await request(url()).get(`/tickets/${ticket?.id}/download`).set(buyer.auth);
    expect(res.status).toBe(200);
    expect(res.body.url).toContain(ticket?.pdfKey);

    const stranger = await createUser();
    expect((await request(url()).get(`/tickets/${ticket?.id}/download`).set(stranger.auth)).status).toBe(404);
  });
});

describe('POST /tickets/verify', () => {
  it('admits a ticket exactly once under concurrent scans', async () => {
    const { bookingId, organizer } = await paidBooking(1);
    await generateTickets(bookingId);
    const [ticket] = await ticketsOf(bookingId);

    const scans = await Promise.all(
      Array.from({ length: 20 }, () => request(url()).post('/tickets/verify').set(organizer.auth).send({ qrToken: ticket?.qrToken })),
    );
    const statuses = scans.map((s) => s.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    expect(scans.find((s) => s.status === 409)?.body.error.code).toBe('TICKET_ALREADY_USED');
  });

  it('rejects forged tokens, other organizers, attendees and refunded bookings', async () => {
    const { bookingId, organizer } = await paidBooking(1);
    await generateTickets(bookingId);
    const [ticket] = await ticketsOf(bookingId);
    const token = ticket?.qrToken ?? '';

    const forged = await request(url()).post('/tickets/verify').set(organizer.auth).send({ qrToken: signQrToken(ticket?.id ?? '', 'wrong-secret-wrong-secret-wrong-secret') });
    expect(forged.status).toBe(422);

    const otherOrganizer = await createUser('organizer');
    expect((await request(url()).post('/tickets/verify').set(otherOrganizer.auth).send({ qrToken: token })).status).toBe(403);

    const attendee = await createUser();
    expect((await request(url()).post('/tickets/verify').set(attendee.auth).send({ qrToken: token })).status).toBe(403);

    await withTransaction((tx) => transitionBooking(tx, bookingId, 'REFUNDED'));
    const voided = await request(url()).post('/tickets/verify').set(organizer.auth).send({ qrToken: token });
    expect(voided.status).toBe(409);
    expect(voided.body.error.code).toBe('TICKET_VOID');
  });
});

describe('send-notification job', () => {
  it('sends once per dedupe key', async () => {
    const { bookingId } = await paidBooking(2);
    expect(await sendNotification({ kind: 'tickets-ready', bookingId })).toBe('sent');
    expect(await sendNotification({ kind: 'tickets-ready', bookingId })).toBe('skipped');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.subject).toContain('Test Event');
  });
});

describe('daily sales report', () => {
  it('aggregates the day’s settled payments per organizer, idempotently', async () => {
    const { bookingId, organizer } = await paidBooking(2);
    await pool.query(
      `INSERT INTO payments (booking_id, provider, provider_order_id, status, amount_paise, succeeded_at)
       VALUES ($1, 'mock', 'order_r1', 'SUCCEEDED', 2000, now())`,
      [bookingId],
    );
    const today = new Date().toISOString().slice(0, 10);
    const first = await generateDailySalesReport(organizer.id, today);
    expect(first).toMatchObject({ bookingsPaid: 1, ticketsSold: 2, grossPaise: 2000, refundedPaise: 0 });
    const second = await generateDailySalesReport(organizer.id, today);
    expect(second).toMatchObject({ bookingsPaid: 1, ticketsSold: 2, grossPaise: 2000 });
    const { rows } = await pool.query(`SELECT 1 FROM reports WHERE organizer_id = $1`, [organizer.id]);
    expect(rows).toHaveLength(1);

    const summary = await request(url()).get('/organizer/sales').set(organizer.auth);
    expect(summary.status).toBe(200);
    expect(summary.body.daily[0]).toMatchObject({ reportDate: today, grossPaise: 2000 });
  });
});

describe('organizer analytics', () => {
  it('zero-fills the timeline and counts sales per day, per tier, and in the recent feed', async () => {
    const { bookingId, organizer, eventId } = await paidBooking(2);
    await pool.query(
      `INSERT INTO payments (booking_id, provider, provider_order_id, status, amount_paise, succeeded_at)
       VALUES ($1, 'mock', 'order_a1', 'SUCCEEDED', 2000, now())`,
      [bookingId],
    );

    const res = await request(url()).get('/organizer/analytics?days=7').set(organizer.auth);
    expect(res.status).toBe(200);
    expect(res.body.timeline).toHaveLength(7);
    expect(res.body.timeline.at(-1)).toMatchObject({ date: new Date().toISOString().slice(0, 10), bookingsPaid: 1, ticketsSold: 2, grossPaise: 2000 });
    expect(res.body.timeline[0]).toMatchObject({ bookingsPaid: 0, ticketsSold: 0, grossPaise: 0 });
    expect(res.body.tiers).toEqual([{ tier: 'Standard', totalSeats: 2, seatsSold: 2, seatsHeld: 0, grossPaise: 2000 }]);
    expect(res.body.recent).toEqual([expect.objectContaining({ bookingId, eventId, seats: 2, amountPaise: 2000 })]);

    // Another organizer sees none of it; attendees are refused.
    const other = await createUser('organizer');
    const theirs = await request(url()).get('/organizer/analytics').set(other.auth);
    expect(theirs.body.timeline).toHaveLength(30);
    expect(theirs.body.tiers).toEqual([]);
    expect(theirs.body.recent).toEqual([]);
    const attendee = await createUser();
    expect((await request(url()).get('/organizer/analytics').set(attendee.auth)).status).toBe(403);
    expect((await request(url()).get('/organizer/analytics?days=500').set(organizer.auth)).status).toBe(400);
  });
});
