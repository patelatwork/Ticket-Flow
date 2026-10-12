import type { Response } from 'express';
import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { optionalAuthenticate } from '../../middleware/auth.js';
import { EventIdParamsSchema } from '../events/events.schemas.js';
import * as eventsService from '../events/events.service.js';
import { getSeatChangeBus, type SeatChange } from './seat-events.js';

export const liveRouter = Router();

const HEARTBEAT_MS = 20_000;
const openStreams = new Set<Response>();

function send(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * GET /events/:id/seats/stream: live seat availability over Server-Sent Events.
 *
 * Snapshot-on-connect, without gaps:
 *   1. subscribe to the event's changes, buffering them
 *   2. read the snapshot
 *   3. send the snapshot, then the buffered changes, then go live
 * Messages carry absolute seat states, so a buffered change that the snapshot already
 * reflects is harmless when replayed. EventSource reconnects automatically (we suggest
 * 3s), and every reconnect starts again at step 1, so a client can never stay out of sync.
 */
liveRouter.get('/:id/seats/stream', optionalAuthenticate, async (req, res) => {
  const { id } = parse(EventIdParamsSchema, req.params, 'path');

  let buffer: SeatChange[] | undefined = [];
  const unsubscribe = await getSeatChangeBus().subscribe(id, (change) => {
    if (buffer) buffer.push(change);
    else send(res, change.type, change);
  });

  let snapshot;
  try {
    snapshot = await eventsService.getSeatMap(id, req.user);
  } catch (err) {
    unsubscribe();
    throw err; // 404 etc., before any SSE headers are sent
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Disable proxy buffering (nginx) so events arrive immediately.
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  send(res, 'snapshot', snapshot);
  for (const change of buffer) send(res, change.type, change);
  buffer = undefined;
  openStreams.add(res);

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    openStreams.delete(res);
  };
  req.on('close', cleanup);
});

/** Ends every open stream (graceful shutdown); clients reconnect to another instance. */
export function closeAllSeatStreams(): void {
  for (const res of openStreams) res.end();
  openStreams.clear();
}
