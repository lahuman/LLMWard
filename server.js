const app = require('./app');
const config = require('./config');
const db = require('./db/database');
const logger = require('./logger');
const { abortInFlight = () => {} } = require('./routes/v1');

function startServer() {
  const server = app.listen(config.port, config.host, () => {
    logger.info('LLM Gateway server started', { host: config.host, port: config.port });
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutdown requested', { signal });
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out');
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      process.exit(1);
    }, 10000);
    forceExit.unref();
    server.close((error) => {
      clearTimeout(forceExit);
      try {
        if (db.open) {
          db.pragma('wal_checkpoint(PASSIVE)');
          db.close();
        }
      } catch (databaseError) {
        logger.error('Database shutdown failed', { errorType: databaseError.name, errorCode: databaseError.code });
        process.exitCode = 1;
        return;
      }
      process.exitCode = error ? 1 : 0;
    });
    abortInFlight();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (require.main === module) startServer();

module.exports = app;
module.exports.startServer = startServer;
