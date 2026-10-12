import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser, optionalAuthenticate, requireRole } from '../../middleware/auth.js';
import {
  AddSeatsBodySchema,
  CreateEventBodySchema,
  EventIdParamsSchema,
  ListEventsQuerySchema,
  SeatParamsSchema,
  UpdateEventBodySchema,
} from './events.schemas.js';
import * as eventsService from './events.service.js';

export const eventsRouter = Router();

const organizerOnly = [authenticate, requireRole('organizer', 'admin')];

// ---- public ----

eventsRouter.get('/', async (req, res) => {
  const query = parse(ListEventsQuerySchema, req.query, 'query');
  res.json({ events: await eventsService.listPublicEvents(query), ...query });
});

// Declared before '/:id' so "mine" is not parsed as an id.
eventsRouter.get('/mine', ...organizerOnly, async (req, res) => {
  res.json({ events: await eventsService.listMyEvents(currentUser(req)) });
});

eventsRouter.get('/:id', optionalAuthenticate, async (req, res) => {
  const { id } = parse(EventIdParamsSchema, req.params, 'path');
  res.json({ event: await eventsService.getEvent(id, req.user) });
});

eventsRouter.get('/:id/seats', optionalAuthenticate, async (req, res) => {
  const { id } = parse(EventIdParamsSchema, req.params, 'path');
  res.json(await eventsService.getSeatMap(id, req.user));
});

// ---- organizer ----

eventsRouter.post('/', ...organizerOnly, async (req, res) => {
  const body = parse(CreateEventBodySchema, req.body);
  res.status(201).json({ event: await eventsService.createEvent(currentUser(req), body) });
});

eventsRouter.patch('/:id', ...organizerOnly, async (req, res) => {
  const { id } = parse(EventIdParamsSchema, req.params, 'path');
  const body = parse(UpdateEventBodySchema, req.body);
  res.json({ event: await eventsService.updateEvent(currentUser(req), id, body) });
});

eventsRouter.post('/:id/publish', ...organizerOnly, async (req, res) => {
  const { id } = parse(EventIdParamsSchema, req.params, 'path');
  res.json({ event: await eventsService.publishEvent(currentUser(req), id) });
});

eventsRouter.post('/:id/cancel', ...organizerOnly, async (req, res) => {
  const { id } = parse(EventIdParamsSchema, req.params, 'path');
  res.json({ event: await eventsService.cancelEvent(currentUser(req), id) });
});

eventsRouter.post('/:id/seats', ...organizerOnly, async (req, res) => {
  const { id } = parse(EventIdParamsSchema, req.params, 'path');
  const body = parse(AddSeatsBodySchema, req.body);
  res.status(201).json({ seats: await eventsService.addSeats(currentUser(req), id, body) });
});

eventsRouter.delete('/:id/seats/:seatId', ...organizerOnly, async (req, res) => {
  const { id, seatId } = parse(SeatParamsSchema, req.params, 'path');
  await eventsService.deleteSeat(currentUser(req), id, seatId);
  res.status(204).end();
});
