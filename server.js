const app = require('./app');
const config = require('./config');
const logger = require('./logger');

function startServer() {
  const server = app.listen(config.port, config.host, () => {
    logger.info('LLM Gateway server started', { host: config.host, port: config.port });
  });

  const shutdown = (signal) => {
    logger.info('Shutdown requested', { signal });
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (require.main === module) startServer();

module.exports = app;
module.exports.startServer = startServer;
