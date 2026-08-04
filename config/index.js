const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ quiet: true });

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function validateAdminKey(value) {
  if (typeof value !== 'string' || value.length < 32) {
    throw new Error('ADMIN_SECRET_KEY must contain at least 32 characters');
  }

  const normalized = value.toLowerCase();
  const placeholders = [
    'change_me', 'changeme', 'example', 'placeholder', 'replace_me', 'your_admin',
    'generate-a-unique', 'admin_secret_key', 'password'
  ];
  if (placeholders.some((placeholder) => normalized.includes(placeholder)) || new Set(value).size < 8) {
    throw new Error('ADMIN_SECRET_KEY must not be weak or an example placeholder');
  }
  return value;
}

function validateCorsOrigin(value) {
  const origins = (value || 'http://localhost:3000').split(',').map((origin) => origin.trim()).filter(Boolean);
  if (!origins.length || origins.includes('*')) {
    throw new Error('CORS_ORIGIN must contain explicit http or https origins; wildcard is not allowed');
  }
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('CORS_ORIGIN contains an invalid origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('CORS_ORIGIN must contain only http or https origins without credentials, paths, queries, or fragments');
    }
  }
  return origins.join(',');
}

const databasePath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'gateway.db');

module.exports = {
  port: positiveInteger(process.env.PORT, 3000, 'PORT'),
  host: process.env.HOST || '0.0.0.0',
  adminKey: validateAdminKey(process.env.ADMIN_SECRET_KEY),
  databasePath,
  providerTimeout: positiveInteger(process.env.KERNEXA_TIMEOUT, 60000, 'KERNEXA_TIMEOUT'),
  corsOrigin: validateCorsOrigin(process.env.CORS_ORIGIN),
  requestLogRetentionDays: nonNegativeInteger(
    process.env.REQUEST_LOG_RETENTION_DAYS,
    30,
    'REQUEST_LOG_RETENTION_DAYS'
  ),
  logLevel: process.env.LOG_LEVEL || 'info',
  validateAdminKey,
  validateCorsOrigin,
  nonNegativeInteger
};
