import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/pool.js';
import { logger } from './lib/logger.js';

const server = createApp().listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
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

  server.close((err) => {
    if (err) logger.error({ err }, 'error closing http server');
    closePool()
      .catch((poolErr: unknown) => {
        logger.error({ err: poolErr }, 'error closing postgres pool');
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
