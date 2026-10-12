import { Router } from 'express';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import * as reportsService from './reports.service.js';

export const reportsRouter = Router();

reportsRouter.get('/sales', authenticate, requireRole('organizer', 'admin'), async (req, res) => {
  res.json(await reportsService.getSalesSummary(currentUser(req)));
});
