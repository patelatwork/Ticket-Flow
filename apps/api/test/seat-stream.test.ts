import { get, type IncomingMessage } from 'node:http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bookSeats, createPublishedEvent, createUser, useTestServer } from './helpers.js';

const { url } = useTestServer();

interface SseEvent {
  event: string;
  data: unknown;
}

/** Minimal SSE client: collects parsed events until `until` is satisfied. */
function openStream(path: string): Promise<{ res: IncomingMessage; next: (pred: (e: SseEvent) => boolean) => Promise<SseEvent>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = get(`${url()}${path}`, (res) => {
      const events: SseEvent[] = [];
      const waiters: { pred: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void }[] = [];
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!event || data === undefined) continue;
          const parsed = { event, data: JSON.parse(data) as unknown };
          events.push(parsed);
          for (const w of [...waiters]) {
            if (w.pred(parsed)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(parsed);
            }
          }
        }
      });
      resolve({
        res,
        next: (pred) => {
          const seen = events.find(pred);
          if (seen) return Promise.resolve(seen);
          return new Promise((r) => waiters.push({ pred, resolve: r }));
        },
        close: () => {
          req.destroy();
        },
      });
    });
    req.on('error', reject);
  });
}

describe('GET /events/:id/seats/stream', () => {
  it('sends a snapshot on connect, then live seat changes', async () => {
    const { eventId, seatIds } = await createPublishedEvent(3);
    const stream = await openStream(`/events/${eventId}/seats/stream`);
    try {
      expect(stream.res.statusCode).toBe(200);
      expect(stream.res.headers['content-type']).toContain('text/event-stream');

      const snapshot = await stream.next((e) => e.event === 'snapshot');
      const seats = (snapshot.data as { seats: { id: string; state: string }[] }).seats;
      expect(seats.map((s) => s.state)).toEqual(['AVAILABLE', 'AVAILABLE', 'AVAILABLE']);

      const user = await createUser();
      const bookingId = await bookSeats(url(), user, eventId, [seatIds[0] ?? '']);
      const held = await stream.next((e) => e.event === 'seats');
      expect(held.data).toMatchObject({ type: 'seats', eventId, seats: [{ id: seatIds[0], state: 'HELD' }] });

      await request(url()).post(`/bookings/${bookingId}/cancel`).set(user.auth).expect(200);
      const released = await stream.next(
        (e) => e.event === 'seats' && (e.data as { seats: { state: string }[] }).seats[0]?.state === 'AVAILABLE',
      );
      expect(released.data).toMatchObject({ seats: [{ id: seatIds[0], state: 'AVAILABLE' }] });
    } finally {
      stream.close();
    }
  });

  it('404s for an unknown or unpublished event before opening the stream', async () => {
    const res = await request(url()).get('/events/00000000-0000-4000-8000-000000000000/seats/stream');
    expect(res.status).toBe(404);
  });
});
