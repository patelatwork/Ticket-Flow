import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { AppError } from '../../lib/errors.js';
import type { AuthUser } from '../auth/tokens.js';
import * as repo from './events.repository.js';
import type { AddSeatsBody, CreateEventBody, ListEventsQuery, UpdateEventBody } from './events.schemas.js';

export interface EventDto {
  id: string;
  organizerId: string;
  title: string;
  description: string;
  venue: string;
  startsAt: string;
  status: repo.EventStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SeatDto {
  id: string;
  label: string;
  tier: string;
  pricePaise: number;
}

export interface SeatMapSeatDto extends SeatDto {
  state: repo.SeatState;
}

export function toEventDto(e: repo.EventRecord): EventDto {
  return {
    id: e.id,
    organizerId: e.organizerId,
    title: e.title,
    description: e.description,
    venue: e.venue,
    startsAt: e.startsAt.toISOString(),
    status: e.status,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

function toSeatDto(s: repo.SeatRecord): SeatDto {
  return { id: s.id, label: s.label, tier: s.tier, pricePaise: s.pricePaise };
}

function canManage(user: AuthUser | undefined, event: repo.EventRecord): boolean {
  return !!user && (user.role === 'admin' || event.organizerId === user.id);
}

function assertCanManage(user: AuthUser, event: repo.EventRecord | undefined): asserts event is repo.EventRecord {
  if (!event) throw AppError.notFound('Event');
  if (!canManage(user, event)) throw AppError.forbidden('You do not manage this event');
}

/** Drafts and cancelled events are only visible to their organizer and admins. */
async function findVisibleEvent(id: string, viewer: AuthUser | undefined): Promise<repo.EventRecord> {
  const event = await repo.findEventById(pool, id);
  if (!event || (event.status !== 'PUBLISHED' && !canManage(viewer, event))) throw AppError.notFound('Event');
  return event;
}

export async function createEvent(user: AuthUser, input: CreateEventBody): Promise<EventDto> {
  const event = await repo.insertEvent(pool, { organizerId: user.id, ...input });
  return toEventDto(event);
}

export async function updateEvent(user: AuthUser, id: string, patch: UpdateEventBody): Promise<EventDto> {
  return withTransaction(async (tx) => {
    const event = await repo.lockEvent(tx, id, 'update');
    assertCanManage(user, event);
    if (event.status === 'CANCELLED') throw AppError.conflict('EVENT_CANCELLED', 'Cancelled events cannot be edited');
    const updated = await repo.updateEvent(tx, id, patch);
    if (!updated) throw AppError.notFound('Event');
    return toEventDto(updated);
  });
}

export async function publishEvent(user: AuthUser, id: string): Promise<EventDto> {
  return withTransaction(async (tx) => {
    const event = await repo.lockEvent(tx, id, 'update');
    assertCanManage(user, event);
    if (event.status !== 'DRAFT') throw AppError.conflict('INVALID_EVENT_STATUS', `Cannot publish a ${event.status} event`);
    if (event.startsAt.getTime() <= Date.now()) throw AppError.conflict('EVENT_IN_PAST', 'Cannot publish an event that has started');
    if ((await repo.countSeats(tx, id)) === 0) throw AppError.conflict('EVENT_HAS_NO_SEATS', 'Add seats before publishing');
    return toEventDto(await repo.setEventStatus(tx, id, 'PUBLISHED'));
  });
}

export async function cancelEvent(user: AuthUser, id: string): Promise<EventDto> {
  return withTransaction(async (tx) => {
    // FOR UPDATE waits for in-flight bookings (which hold FOR SHARE) and blocks new ones.
    const event = await repo.lockEvent(tx, id, 'update');
    assertCanManage(user, event);
    if (event.status === 'CANCELLED') throw AppError.conflict('INVALID_EVENT_STATUS', 'Event is already cancelled');
    // Refunding paid bookings on cancellation arrives with payments (Phase 3).
    if (await repo.hasActiveBookings(tx, id)) {
      throw AppError.conflict('EVENT_HAS_ACTIVE_BOOKINGS', 'Event has held or paid bookings');
    }
    return toEventDto(await repo.setEventStatus(tx, id, 'CANCELLED'));
  });
}

export async function getEvent(id: string, viewer: AuthUser | undefined): Promise<EventDto> {
  return toEventDto(await findVisibleEvent(id, viewer));
}

export async function listPublicEvents(query: ListEventsQuery): Promise<EventDto[]> {
  const events = await repo.listPublishedUpcoming(pool, query.limit, query.offset);
  return events.map(toEventDto);
}

export async function listMyEvents(user: AuthUser): Promise<EventDto[]> {
  const events = await repo.listByOrganizer(pool, user.id);
  return events.map(toEventDto);
}

export async function addSeats(user: AuthUser, eventId: string, input: AddSeatsBody): Promise<SeatDto[]> {
  return withTransaction(async (tx) => {
    const event = await repo.lockEvent(tx, eventId, 'share');
    assertCanManage(user, event);
    if (event.status === 'CANCELLED') throw AppError.conflict('EVENT_CANCELLED', 'Cannot add seats to a cancelled event');
    const seats = await repo.insertSeats(tx, eventId, input.seats);
    if (!seats) throw AppError.conflict('SEAT_LABEL_TAKEN', 'One or more seat labels already exist for this event');
    return seats.map(toSeatDto);
  });
}

export async function deleteSeat(user: AuthUser, eventId: string, seatId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const event = await repo.lockEvent(tx, eventId, 'share');
    assertCanManage(user, event);
    const result = await repo.deleteSeat(tx, eventId, seatId);
    if (result === 'not_found') throw AppError.notFound('Seat');
    if (result === 'has_bookings') throw AppError.conflict('SEAT_HAS_BOOKINGS', 'Seats with booking history cannot be deleted');
  });
}

export async function getSeatMap(eventId: string, viewer: AuthUser | undefined): Promise<{ event: EventDto; seats: SeatMapSeatDto[] }> {
  const event = await findVisibleEvent(eventId, viewer);
  const seats = await repo.seatMap(pool, eventId);
  return { event: toEventDto(event), seats: seats.map((s) => ({ ...toSeatDto(s), state: s.state })) };
}
