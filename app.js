const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const logger = require('./logger');
const { runMigrations } = require('./db/migrations');
const adminRoutes = require('./routes/admin');
const v1Routes = require('./routes/v1');
const { cleanupRequestLogs } = require('./services/retention');

runMigrations();
cleanupRequestLogs();

const app = express();
const allowedOrigins = config.corsOrigin === '*'
  ? '*'
  : config.corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);

app.disable('x-powered-by');
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', adminRoutes);
app.use('/v1', v1Routes);
app.use('/dashboard', v1Routes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  let status = Number.isInteger(error.status) ? error.status : 500;
  let message = status < 500 ? error.message : 'Internal server error';
  if (error.type === 'entity.parse.failed') {
    status = 400;
    message = 'Request body contains invalid JSON';
  } else if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    status = 409;
    message = 'A resource with that identifier already exists';
  } else if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || error.code === 'SQLITE_CONSTRAINT_CHECK') {
    status = 400;
    message = 'The request violates a data constraint';
  }

  if (status >= 500) {
    logger.error('Request failed', {
      errorType: error.name,
      errorCode: error.code,
      method: req.method,
      path: req.path
    });
  }
  if (status === 429 && Number.isSafeInteger(error.retryAfter)) {
    res.setHeader('Retry-After', String(error.retryAfter));
  }
  res.status(status).json({
    error: message,
    code: error.code || (status === 429 ? 'quota_exceeded' : status >= 500 ? 'internal_error' : 'invalid_request')
  });
});

module.exports = app;
