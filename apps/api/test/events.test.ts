import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createUser, useTestServer } from './helpers.js';

const { url } = useTestServer();

const inAWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

describe('events and seats', () => {
  it('runs the organizer lifecycle: draft -> seats -> publish -> public seat map', async () => {
    const org = await createUser('organizer');

    const created = await request(url())
      .post('/events')
      .set(org.auth)
      .send({ title: 'Jazz Night', venue: 'Blue Frog', startsAt: inAWeek() });
    expect(created.status).toBe(201);
    expect(created.body.event.status).toBe('DRAFT');
    const eventId = created.body.event.id as string;

    // Drafts are invisible to the public and cannot be published without seats.
    expect((await request(url()).get(`/events/${eventId}`)).status).toBe(404);
    expect((await request(url()).get(`/events/${eventId}`).set(org.auth)).status).toBe(200);
    const noSeats = await request(url()).post(`/events/${eventId}/publish`).set(org.auth);
    expect(noSeats.body.error.code).toBe('EVENT_HAS_NO_SEATS');

    const seats = await request(url())
      .post(`/events/${eventId}/seats`)
      .set(org.auth)
      .send({
        seats: [
          { label: 'A1', tier: 'VIP', pricePaise: 250_000 },
          { label: 'A2', tier: 'VIP', pricePaise: 250_000 },
        ],
      });
    expect(seats.status).toBe(201);
    expect(seats.body.seats).toHaveLength(2);

    const dup = await request(url())
      .post(`/events/${eventId}/seats`)
      .set(org.auth)
      .send({ seats: [{ label: 'A1', tier: 'VIP', pricePaise: 100 }] });
    expect(dup.status).toBe(409);

    expect((await request(url()).post(`/events/${eventId}/publish`).set(org.auth)).body.event.status).toBe('PUBLISHED');

    const list = await request(url()).get('/events');
    expect(list.status).toBe(200);
    expect(list.body.events.map((e: { id: string }) => e.id)).toContain(eventId);

    const map = await request(url()).get(`/events/${eventId}/seats`);
    expect(map.status).toBe(200);
    expect(map.body.seats).toHaveLength(2);
    expect(map.body.seats.every((s: { state: string }) => s.state === 'AVAILABLE')).toBe(true);
  });

  it('only lets the owning organizer (or an admin) manage an event', async () => {
    const owner = await createUser('organizer');
    const other = await createUser('organizer');
    const admin = await createUser('admin');
    const created = await request(url()).post('/events').set(owner.auth).send({ title: 'Mine', venue: 'Here', startsAt: inAWeek() });
    const id = created.body.event.id as string;

    expect((await request(url()).patch(`/events/${id}`).set(other.auth).send({ title: 'Hijacked' })).status).toBe(403);
    const byAdmin = await request(url()).patch(`/events/${id}`).set(admin.auth).send({ title: 'Renamed' });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.event.title).toBe('Renamed');
  });

  it('validates input', async () => {
    const org = await createUser('organizer');
    const past = await request(url())
      .post('/events')
      .set(org.auth)
      .send({ title: 'Old', venue: 'Here', startsAt: new Date(Date.now() - 1000).toISOString() });
    expect(past.status).toBe(400);
    expect(past.body.error.details[0].path).toBe('startsAt');

    const badPrice = await request(url())
      .post('/events/00000000-0000-0000-0000-000000000000/seats')
      .set(org.auth)
      .send({ seats: [{ label: 'A1', tier: 'VIP', pricePaise: 12.5 }] });
    expect(badPrice.status).toBe(400);

    expect((await request(url()).get('/events/not-a-uuid')).status).toBe(400);
    expect((await request(url()).get('/events?limit=1000')).status).toBe(400);
  });

  it('returns a structured 400 for malformed JSON', async () => {
    const org = await createUser('organizer');
    const res = await request(url()).post('/events').set(org.auth).set('Content-Type', 'application/json').send('{"title":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});
