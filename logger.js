const winston = require('winston');
const config = require('./config');

module.exports = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'llm-gateway' },
  transports: [new winston.transports.Console()]
});
