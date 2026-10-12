import { Router } from 'express';
import { z } from 'zod';
import { LoginBodySchema, RegisterBodySchema } from '../auth/auth.schemas.js';
import { CreateBookingBodySchema } from '../bookings/bookings.schemas.js';
import { AddSeatsBodySchema, CreateEventBodySchema, ListEventsQuerySchema, UpdateEventBodySchema } from '../events/events.schemas.js';
import { ListTicketsQuerySchema, VerifyTicketBodySchema } from '../tickets/tickets.schemas.js';

/**
 * OpenAPI 3.1 document generated from the SAME Zod schemas that validate requests
 * (zod v4's native z.toJSONSchema), so the docs cannot drift from the validation.
 */
type JsonSchema = Record<string, unknown>;

function schema(s: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return json;
}

interface Op {
  summary: string;
  tag: string;
  auth?: 'bearer' | 'none';
  body?: z.ZodType;
  query?: z.ZodObject;
  params?: string[];
  headers?: { name: string; required: boolean; description: string }[];
  responses: Record<string, string>;
}

const ERROR_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } },
      required: ['code', 'message'],
    },
  },
};

const ops: Record<string, Record<string, Op>> = {
  '/health/live': { get: { summary: 'Liveness', tag: 'Health', auth: 'none', responses: { 200: 'Process is up' } } },
  '/health/ready': { get: { summary: 'Readiness (Postgres, Redis)', tag: 'Health', auth: 'none', responses: { 200: 'Ready', 503: 'Dependency down' } } },
  '/auth/register': { post: { summary: 'Register', tag: 'Auth', auth: 'none', body: RegisterBodySchema, responses: { 201: 'Created; refresh cookie set', 409: 'Email taken', 429: 'Rate limited' } } },
  '/auth/login': { post: { summary: 'Log in', tag: 'Auth', auth: 'none', body: LoginBodySchema, responses: { 200: 'Access token; refresh cookie set', 401: 'Invalid credentials', 429: 'Rate limited' } } },
  '/auth/refresh': { post: { summary: 'Rotate refresh token (cookie)', tag: 'Auth', auth: 'none', responses: { 200: 'New access token', 401: 'Invalid/reused refresh token' } } },
  '/auth/logout': { post: { summary: 'Revoke the refresh token family', tag: 'Auth', auth: 'none', responses: { 204: 'Logged out' } } },
  '/auth/me': { get: { summary: 'Current user', tag: 'Auth', responses: { 200: 'User' } } },
  '/events': {
    get: { summary: 'Published upcoming events', tag: 'Events', auth: 'none', query: ListEventsQuerySchema, responses: { 200: 'Events' } },
    post: { summary: 'Create event (DRAFT)', tag: 'Events', body: CreateEventBodySchema, responses: { 201: 'Created', 403: 'Not an organizer' } },
  },
  '/events/mine': { get: { summary: "Organizer's events", tag: 'Events', responses: { 200: 'Events' } } },
  '/events/{id}': {
    get: { summary: 'Event', tag: 'Events', auth: 'none', params: ['id'], responses: { 200: 'Event', 404: 'Not found' } },
    patch: { summary: 'Update event', tag: 'Events', params: ['id'], body: UpdateEventBodySchema, responses: { 200: 'Updated' } },
  },
  '/events/{id}/publish': { post: { summary: 'Publish', tag: 'Events', params: ['id'], responses: { 200: 'Published', 409: 'Invalid state' } } },
  '/events/{id}/cancel': { post: { summary: 'Cancel; HELD bookings cancelled, PAID refunded', tag: 'Events', params: ['id'], responses: { 200: 'Cancelled' } } },
  '/events/{id}/seats': {
    get: { summary: 'Seat map (cached)', tag: 'Events', auth: 'none', params: ['id'], responses: { 200: 'Seats with AVAILABLE/HELD/SOLD' } },
    post: { summary: 'Add seats (bulk)', tag: 'Events', params: ['id'], body: AddSeatsBodySchema, responses: { 201: 'Seats', 409: 'Label taken' } },
  },
  '/events/{id}/seats/stream': {
    get: {
      summary: 'Live seat availability (Server-Sent Events): `snapshot`, then `seats` / `refresh` events',
      tag: 'Events',
      auth: 'none',
      params: ['id'],
      responses: { 200: 'text/event-stream' },
    },
  },
  '/bookings': {
    get: { summary: 'My bookings', tag: 'Bookings', responses: { 200: 'Bookings' } },
    post: {
      summary: 'Hold seats for 10 minutes',
      tag: 'Bookings',
      body: CreateBookingBodySchema,
      headers: [{ name: 'Idempotency-Key', required: true, description: '8-255 printable ASCII chars; replays return the original response' }],
      responses: { 201: 'HELD booking', 409: 'SEATS_UNAVAILABLE with details.seatIds', 422: 'Key reused with a different body', 429: 'Rate limited' },
    },
  },
  '/bookings/{id}': { get: { summary: 'Booking', tag: 'Bookings', params: ['id'], responses: { 200: 'Booking', 404: 'Not found' } } },
  '/bookings/{id}/cancel': { post: { summary: 'Release a HELD booking', tag: 'Bookings', params: ['id'], responses: { 200: 'Cancelled', 409: 'Illegal transition' } } },
  '/bookings/{id}/pay': { post: { summary: 'Create (or reuse) the provider order', tag: 'Payments', params: ['id'], responses: { 201: 'Payment with checkout data', 409: 'HOLD_EXPIRED / BOOKING_NOT_PAYABLE' } } },
  '/bookings/{id}/payment': { get: { summary: 'Latest payment for a booking', tag: 'Payments', params: ['id'], responses: { 200: 'Payment or null' } } },
  '/webhooks/payments/{provider}': {
    post: {
      summary: 'Provider webhook (signature-verified, deduplicated by event id)',
      tag: 'Payments',
      auth: 'none',
      params: ['provider'],
      responses: { 200: 'Applied / duplicate / ignored', 401: 'Bad signature', 503: 'Unknown order, retry' },
    },
  },
  '/tickets': { get: { summary: 'My tickets', tag: 'Tickets', query: ListTicketsQuerySchema, responses: { 200: 'Tickets' } } },
  '/tickets/{id}/download': { get: { summary: 'Presigned PDF URL (owner only, short-lived)', tag: 'Tickets', params: ['id'], responses: { 200: '{ url, expiresAt }', 409: 'Not ready / void' } } },
  '/tickets/verify': { post: { summary: 'Gate check-in (exactly once)', tag: 'Tickets', body: VerifyTicketBodySchema, responses: { 200: 'Admitted', 409: 'Already used / void', 422: 'Forged token' } } },
  '/organizer/sales': { get: { summary: 'Sales summary + daily reports', tag: 'Organizer', responses: { 200: 'Summary' } } },
  '/admin/session': { post: { summary: 'Set the admin cookie for Bull Board', tag: 'Admin', responses: { 200: 'Cookie set' } } },
  '/admin/dlq': { get: { summary: 'Dead-lettered jobs', tag: 'Admin', responses: { 200: 'Jobs' } } },
  '/admin/dlq/{id}/retry': { post: { summary: 'Re-enqueue a dead-lettered job', tag: 'Admin', params: ['id'], responses: { 200: 'Requeued' } } },
  '/metrics': { get: { summary: 'Prometheus metrics', tag: 'Ops', auth: 'none', responses: { 200: 'text/plain' } } },
};

function buildDocument(): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, methods] of Object.entries(ops)) {
    paths[path] = {};
    for (const [method, op] of Object.entries(methods)) {
      const parameters: unknown[] = [
        ...(op.params ?? []).map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
        ...(op.headers ?? []).map((h) => ({ name: h.name, in: 'header', required: h.required, description: h.description, schema: { type: 'string' } })),
      ];
      if (op.query) {
        for (const [name, s] of Object.entries(op.query.shape)) {
          parameters.push({ name, in: 'query', required: false, schema: schema(s as z.ZodType) });
        }
      }
      paths[path][method] = {
        summary: op.summary,
        tags: [op.tag],
        ...(op.auth === 'none' ? { security: [] } : {}),
        ...(parameters.length ? { parameters } : {}),
        ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(op.body) } } } } : {}),
        responses: Object.fromEntries(
          Object.entries(op.responses).map(([code, description]) => [
            code,
            Number(code) >= 400 ? { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } : { description },
          ]),
        ),
      };
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'TicketFlow API',
      version: '1.0.0',
      description: 'High-concurrency event ticketing. Money is integer paise; timestamps are ISO-8601 UTC.',
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: { Error: ERROR_SCHEMA },
    },
    security: [{ bearer: [] }],
    paths,
  };
}

const SWAGGER_UI_VERSION = '5.17.14';
export const DOCS_CSP = {
  'default-src': ["'self'"],
  'script-src': ["'self'", 'https://cdn.jsdelivr.net', "'unsafe-inline'"],
  'style-src': ["'self'", 'https://cdn.jsdelivr.net', "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
};

export const docsRouter = Router();
let cached: JsonSchema | undefined;

docsRouter.get('/openapi.json', (_req, res) => {
  cached ??= buildDocument();
  res.json(cached);
});

/** Swagger UI from a pinned CDN build (no extra npm dependency). */
docsRouter.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>TicketFlow API</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({ url: location.pathname.replace(/\\/$/, '') + '/openapi.json', dom_id: '#ui' });</script>
</body></html>`);
});
