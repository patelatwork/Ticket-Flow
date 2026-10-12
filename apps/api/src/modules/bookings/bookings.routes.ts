import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/auth.js';
import { BookingIdParamsSchema, CreateBookingBodySchema, IdempotencyKeySchema } from './bookings.schemas.js';
import * as paymentsService from '../payments/payments.service.js';
import * as bookingsService from './bookings.service.js';

export const bookingsRouter = Router();

bookingsRouter.use(authenticate);

bookingsRouter.post('/', async (req, res) => {
  const key = parse(IdempotencyKeySchema, req.get('Idempotency-Key'), 'Idempotency-Key header');
  const body = parse(CreateBookingBodySchema, req.body);
  const result = await bookingsService.createBooking(currentUser(req), key, body);
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
});

bookingsRouter.get('/', async (req, res) => {
  res.json({ bookings: await bookingsService.listMyBookings(currentUser(req)) });
});

bookingsRouter.get('/:id', async (req, res) => {
  const { id } = parse(BookingIdParamsSchema, req.params, 'path');
  res.json({ booking: await bookingsService.getBooking(currentUser(req), id) });
});

bookingsRouter.post('/:id/cancel', async (req, res) => {
  const { id } = parse(BookingIdParamsSchema, req.params, 'path');
  res.json({ booking: await bookingsService.cancelBooking(currentUser(req), id) });
});

/** Creates (or returns the in-flight) provider order for a HELD booking. */
bookingsRouter.post('/:id/pay', async (req, res) => {
  const { id } = parse(BookingIdParamsSchema, req.params, 'path');
  res.status(201).json({ payment: await paymentsService.startPayment(currentUser(req), id) });
});

bookingsRouter.get('/:id/payment', async (req, res) => {
  const { id } = parse(BookingIdParamsSchema, req.params, 'path');
  res.json({ payment: await paymentsService.getLatestPayment(currentUser(req), id) });
});
