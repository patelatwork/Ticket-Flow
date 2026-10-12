import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { closeAllSeatStreams } from './modules/live/live.routes.js';
import { createRuntime } from './runtime.js';

const runtime = createRuntime({ subscriber: true });
const server = createApp({ redis: runtime.redis, queues: runtime.queues }).listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV, paymentProvider: env.PAYMENT_PROVIDER }, 'api listening');
});

// Keep-alive must outlive the load balancer's idle timeout to avoid 502s on reused sockets.
server.keepAliveTimeout = 65_000;

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down: draining connections');

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  // SSE streams never end on their own; close them so server.close() can finish.
  // Clients reconnect (EventSource retry) to another instance and get a fresh snapshot.
  closeAllSeatStreams();
  server.close((err) => {
    if (err) logger.error({ err }, 'error closing http server');
    void Promise.allSettled([runtime.close(), closePool()])
      .then((results) => {
        for (const r of results) if (r.status === 'rejected') logger.error({ err: r.reason as unknown }, 'error during shutdown');
      })
      .finally(() => {
        logger.info('shutdown complete');
        process.exit(err ? 1 : 0);
      });
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
