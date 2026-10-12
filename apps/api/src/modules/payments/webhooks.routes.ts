import express, { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { z } from 'zod';
import * as paymentsService from './payments.service.js';

export const webhooksRouter = Router();

const ProviderParamsSchema = z.object({ provider: z.string().min(1).max(40) });

/**
 * Mounted BEFORE the global JSON parser: signatures are computed over the exact bytes
 * the provider sent, so the body must reach the service unparsed.
 * Responses: 200 applied/duplicate/ignored, 401 bad signature (no retry useful),
 * 503 unknown order (provider should retry).
 */
webhooksRouter.post('/payments/:provider', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
  const { provider } = parse(ProviderParamsSchema, req.params, 'path');
  const outcome = await paymentsService.handleWebhook(provider, req.body, req.headers);
  res.json({ received: true, ...outcome });
});
