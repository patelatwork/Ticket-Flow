import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { AnalyticsQuerySchema } from './reports.schemas.js';
import * as reportsService from './reports.service.js';

export const reportsRouter = Router();

reportsRouter.get('/sales', authenticate, requireRole('organizer', 'admin'), async (req, res) => {
  res.json(await reportsService.getSalesSummary(currentUser(req)));
});

reportsRouter.get('/analytics', authenticate, requireRole('organizer', 'admin'), async (req, res) => {
  const { days } = parse(AnalyticsQuerySchema, req.query, 'query');
  res.json(await reportsService.getSalesAnalytics(currentUser(req), days));
});
