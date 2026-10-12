import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import type { NotificationJob } from '../../queues/definitions.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/** EMAIL_TRANSPORT=log (tests, CI): records instead of sending. */
export class LogMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    logger.info({ to: message.to, subject: message.subject }, 'email (log transport)');
    return Promise.resolve();
  }
}

/** SMTP; Mailpit in docker compose (UI on :8025). */
export class SmtpMailer implements Mailer {
  private readonly transport = nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: false });
  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: env.EMAIL_FROM, ...message });
  }
}

let mailer: Mailer | undefined;

export function setMailer(next: Mailer): void {
  mailer = next;
}

export function getMailer(): Mailer {
  mailer ??= env.EMAIL_TRANSPORT === 'log' ? new LogMailer() : new SmtpMailer();
  return mailer;
}

function formatInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function compose(job: NotificationJob): Promise<{ dedupeKey: string; message: EmailMessage } | undefined> {
  if (job.kind === 'tickets-ready') {
    const { rows } = await pool.query<{ email: string; title: string; startsAt: Date; venue: string; seats: string; status: string }>(
      `SELECT u.email, e.title, e.starts_at AS "startsAt", e.venue, b.status,
              string_agg(s.label, ', ' ORDER BY s.label) AS seats
         FROM bookings b JOIN users u ON u.id = b.user_id JOIN events e ON e.id = b.event_id
         JOIN booking_seats bs ON bs.booking_id = b.id JOIN seats s ON s.id = bs.seat_id
        WHERE b.id = $1
        GROUP BY u.email, e.title, e.starts_at, e.venue, b.status`,
      [job.bookingId],
    );
    const row = rows[0];
    if (row?.status !== 'PAID') return undefined;
    return {
      dedupeKey: `tickets-ready:${job.bookingId}`,
      message: {
        to: row.email,
        subject: `Your tickets for ${row.title}`,
        text: [
          `You're going to ${row.title}!`,
          `${row.venue}, ${row.startsAt.toUTCString()}`,
          `Seats: ${row.seats}`,
          '',
          `Download your tickets: ${env.WEB_BASE_URL}/me/bookings`,
        ].join('\n'),
      },
    };
  }

  const { rows } = await pool.query<{ email: string; title: string; amountPaise: number; reason: string | null }>(
    `SELECT u.email, e.title, p.amount_paise AS "amountPaise", p.refund_reason AS reason
       FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN users u ON u.id = b.user_id JOIN events e ON e.id = b.event_id
      WHERE p.id = $1 AND p.status = 'REFUNDED'`,
    [job.paymentId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const why = row.reason === 'SEATS_TAKEN' || row.reason === 'EVENT_NOT_ACTIVE'
    ? 'Your payment arrived after your seat hold expired and the seats were no longer available.'
    : row.reason === 'EVENT_CANCELLED'
      ? 'The event was cancelled by the organizer.'
      : 'Your payment could not be applied to your booking.';
  return {
    dedupeKey: `refund-issued:${job.paymentId}`,
    message: {
      to: row.email,
      subject: `Refund of ${formatInr(row.amountPaise)} for ${row.title}`,
      text: `${why}\nWe have refunded ${formatInr(row.amountPaise)} to your original payment method.`,
    },
  };
}

/**
 * `send-notification` handler. Deduplicated by a deterministic key in `notifications`:
 * a key already marked sent is skipped. The send and the "sent" mark can't be atomic
 * (SMTP isn't transactional), so a crash between them can produce one duplicate email.
 * That is the usual at-least-once trade-off, and it is documented.
 */
export async function sendNotification(job: NotificationJob): Promise<'sent' | 'skipped'> {
  const composed = await compose(job);
  if (!composed) return 'skipped';
  const { dedupeKey, message } = composed;

  await pool.query(
    `INSERT INTO notifications (dedupe_key, kind, recipient) VALUES ($1, $2, $3) ON CONFLICT (dedupe_key) DO NOTHING`,
    [dedupeKey, job.kind, message.to],
  );
  const { rows } = await pool.query<{ sentAt: Date | null }>(`SELECT sent_at AS "sentAt" FROM notifications WHERE dedupe_key = $1`, [dedupeKey]);
  if (rows[0]?.sentAt) return 'skipped';

  await getMailer().send(message);
  await pool.query(`UPDATE notifications SET sent_at = now() WHERE dedupe_key = $1 AND sent_at IS NULL`, [dedupeKey]);
  return 'sent';
}
