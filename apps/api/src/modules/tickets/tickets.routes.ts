import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { ListTicketsQuerySchema, TicketIdParamsSchema, VerifyTicketBodySchema } from './tickets.schemas.js';
import * as ticketsService from './tickets.service.js';

export const ticketsRouter = Router();

ticketsRouter.use(authenticate);

ticketsRouter.get('/', async (req, res) => {
  const { bookingId } = parse(ListTicketsQuerySchema, req.query, 'query');
  res.json({ tickets: await ticketsService.listMyTickets(currentUser(req), bookingId) });
});

ticketsRouter.get('/:id/download', async (req, res) => {
  const { id } = parse(TicketIdParamsSchema, req.params, 'path');
  res.json(await ticketsService.getTicketDownload(currentUser(req), id));
});

ticketsRouter.post('/verify', requireRole('organizer', 'admin'), async (req, res) => {
  const { qrToken } = parse(VerifyTicketBodySchema, req.body);
  res.json(await ticketsService.verifyTicket(currentUser(req), qrToken));
});
