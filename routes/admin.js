const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('../db/database');
const { validateAdmin } = require('../middleware/auth');
const { testProvider, discoverModels, normalizeProviderBaseUrl, PROVIDER_PRESETS } = require('../services/provider-router');
const { ApiError } = require('../services/errors');
const { hashToken } = require('../db/migrations');
const { audit } = require('../services/audit');
const { createBackup } = require('../services/backup');
const { retentionDays, cleanupRequestLogs, setRetentionDays } = require('../services/retention');
const { listFilters, createFilter, updateFilter, deleteFilter, getBuiltInPiiFilter, setBuiltInPiiFilter } = require('../services/content-filters');

const router = express.Router();
const IDENTIFIER = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const MODEL_IDENTIFIER = /^[a-z0-9][a-z0-9_.:/-]{0,199}$/;
const AUTH_TYPES = new Set(['none', 'api_key', 'bearer_token']);
const USER_UPDATE_AUDIT_FIELDS = [
  'max_daily_input_tokens', 'max_daily_output_tokens', 'max_requests_per_minute',
  'max_concurrent_requests', 'is_active', 'allowed_models'
];
const MODEL_CREATE_AUDIT_FIELDS = [
  'model_name', 'display_name', 'model_type', 'provider_id', 'max_tokens',
  'max_concurrent_requests', 'input_cost_per_million', 'output_cost_per_million',
  'context_window', 'default_temperature', 'default_top_p',
  'default_presence_penalty', 'default_frequency_penalty', 'default_seed'
];
const MODEL_UPDATE_AUDIT_FIELDS = [...MODEL_CREATE_AUDIT_FIELDS, 'is_active'];
const PROVIDER_CREATE_AUDIT_FIELDS = [
  'provider_name', 'display_name', 'base_url', 'auth_type', 'api_key_env_name',
  'stored_api_key', 'max_concurrent_requests'
];
const PROVIDER_UPDATE_AUDIT_FIELDS = [...PROVIDER_CREATE_AUDIT_FIELDS, 'is_active'];

const FAILURE_AUDIT_FAMILIES = new Map([
  ['users', { action: 'user.change', targetType: 'user', hasTargetId: true }],
  ['models', { action: 'model.change', targetType: 'model', hasTargetId: true }],
  ['providers', { action: 'provider.change', targetType: 'provider', hasTargetId: true }],
  ['filters', { action: 'filter.change', targetType: 'filter', hasTargetId: true }],
  ['provider-presets', { action: 'provider-preset.change', targetType: 'provider-preset' }],
  ['usage', { action: 'usage.change', targetType: 'usage' }],
  ['onboarding', { action: 'onboarding.change', targetType: 'onboarding' }],
  ['backup', { action: 'backup.change', targetType: 'backup' }],
  ['backups', { action: 'backup.change', targetType: 'backup' }],
  ['retention', { action: 'retention.change', targetType: 'retention' }],
  ['audit-logs', { action: 'audit-log.change', targetType: 'audit-log' }],
  ['stats', { action: 'stats.change', targetType: 'stats' }]
]);
const ADMIN_FAILURE_AUDIT = { action: 'admin.change', targetType: 'admin' };

function auditChangedFields(body, supportedFields) {
  return supportedFields.filter((field) => Object.hasOwn(body, field));
}

function auditTargetId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const canonical = String(value);
  if (!/^[1-9]\d*$/.test(canonical)) return null;
  const parsed = Number(canonical);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function failureAuditMetadata(requestPath) {
  const segments = requestPath.split('/').filter(Boolean);
  if ((segments[0] || '').toLowerCase() === 'filters' &&
      (segments[1] || '').toLowerCase() === 'built-in-pii') {
    return {
      action: 'filter.change',
      targetType: 'filter',
      targetId: 'built-in-pii'
    };
  }
  const family = FAILURE_AUDIT_FAMILIES.get((segments[0] || '').toLowerCase()) || ADMIN_FAILURE_AUDIT;
  return {
    action: family.action,
    targetType: family.targetType,
    targetId: family.hasTargetId ? auditTargetId(segments[1]) : null
  };
}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ApiError(400, `${name} must be a positive safe integer`);
  return value;
}

function nullablePositive(value, name) {
  return value === null ? null : positive(value, name);
}

function nullableRange(value, name, minimum, maximum) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ApiError(400, `${name} must be null or a finite number from ${minimum} through ${maximum}`);
  }
  return value;
}

function nullableSafeInteger(value, name) {
  if (value !== null && !Number.isSafeInteger(value)) {
    throw new ApiError(400, `${name} must be null or a safe integer`);
  }
  return value;
}

function assertModelCapacity(maxTokens, contextWindow) {
  if (contextWindow !== null && maxTokens > contextWindow) {
    throw new ApiError(400, 'max_tokens must not exceed context_window');
  }
}

function nonNegative(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, `${name} must be a non-negative safe integer`);
  }
  return value;
}

function id(value, name = 'id') {
  const parsed = Number(value);
  return positive(parsed, name);
}

function nonEmpty(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new ApiError(400, `${name} must be a non-empty string`);
  }
  return value.trim();
}

function credential(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) {
    throw new ApiError(400, 'stored_api_key must be a non-empty string');
  }
  return value;
}

function identifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new ApiError(400, `${name} is invalid`);
  }
  return value;
}

function modelIdentifier(value) {
  if (typeof value !== 'string' || !MODEL_IDENTIFIER.test(value)) {
    throw new ApiError(400, 'model_name is invalid');
  }
  return value;
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new ApiError(400, `${name} must be a boolean`);
  return value ? 1 : 0;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(400, `${name} must be a non-negative safe integer`);
  return value;
}

function createRawToken() {
  return `lgw_${crypto.randomBytes(32).toString('base64url')}`;
}

function insertToken(userId, name, expiresAt = null) {
  const rawToken = createRawToken();
  const result = db.prepare(`
    INSERT INTO user_tokens
      (user_id, name, token_prefix, token_hash, created_at, expires_at, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(userId, name, rawToken.slice(0, 12), hashToken(rawToken), new Date().toISOString(), expiresAt);
  return { id: Number(result.lastInsertRowid), rawToken };
}

function optionalExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ApiError(400, 'expires_at must be an ISO 8601 timestamp or null');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed <= new Date()) throw new ApiError(400, 'expires_at must be a future timestamp');
  return parsed.toISOString();
}

function nonNegativeNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ApiError(400, `${name} must be a non-negative finite number`);
  }
  return value;
}

function nullablePrice(value, name) {
  return value === null || value === '' ? null : nonNegativeNumber(value, name);
}

function iso(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function dateOnly(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, `${name} must be a UTC date in YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, `${name} must be a valid UTC date`);
  }
  return value;
}

function addUtcDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function statsPeriod(query) {
  const range = query.range || 'today';
  const today = new Date().toISOString().slice(0, 10);
  let start;
  let end = today;
  if (range === 'today') start = today;
  else if (range === '7d') start = addUtcDays(today, -6);
  else if (range === '30d') start = addUtcDays(today, -29);
  else if (range === 'month') start = `${today.slice(0, 7)}-01`;
  else if (range === 'custom') {
    start = dateOnly(query.start, 'start');
    end = dateOnly(query.end, 'end');
  } else {
    throw new ApiError(400, 'range must be today, 7d, 30d, month, or custom');
  }
  if (start > end) throw new ApiError(400, 'start must not be later than end');
  return {
    range,
    start,
    end,
    endExclusive: addUtcDays(end, 1),
    start_at: `${start}T00:00:00.000Z`,
    end_at: `${end}T23:59:59.999Z`
  };
}

function percentile95(values) {
  if (!values.length) return 0;
  values.sort((left, right) => left - right);
  return values[Math.ceil(values.length * 0.95) - 1];
}

function finalizeAggregate(row, p95) {
  const total = Number(row.total_requests) || 0;
  const failures = Number(row.failed_requests) || 0;
  const unpriced = Number(row.unpriced_requests) || 0;
  return {
    ...row,
    total_requests: total,
    successful_requests: Number(row.successful_requests) || 0,
    failed_requests: failures,
    error_rate: total ? (failures / total) * 100 : 0,
    average_response_time_ms: Number(row.average_response_time_ms) || 0,
    p95_response_time_ms: p95,
    estimated_cost_usd: unpriced ? null : (Number(row.configured_cost_usd) || 0),
    cost_configured: unpriced === 0,
    unpriced_requests: unpriced
  };
}

function validateAllowedModels(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || !MODEL_IDENTIFIER.test(name))) {
    throw new ApiError(400, 'allowed_models must be null or an array of model identifiers');
  }
  const unique = [...new Set(value)];
  if (unique.length) {
    const placeholders = unique.map(() => '?').join(',');
    const found = db.prepare(`SELECT model_name FROM models WHERE model_name IN (${placeholders})`).all(...unique);
    if (found.length !== unique.length) throw new ApiError(400, 'allowed_models contains an unknown model');
  }
  return JSON.stringify(unique);
}

function userResponse(row) {
  let allowedModels = null;
  let permissionsValid = true;
  if (row.allowed_models !== null) {
    try {
      allowedModels = JSON.parse(row.allowed_models);
      permissionsValid = Array.isArray(allowedModels) && allowedModels.every((value) => typeof value === 'string' && MODEL_IDENTIFIER.test(value));
      if (permissionsValid && allowedModels.length) {
        const unique = [...new Set(allowedModels)];
        const placeholders = unique.map(() => '?').join(',');
        const found = db.prepare(`SELECT COUNT(*) AS count FROM models WHERE model_name IN (${placeholders})`).get(...unique).count;
        permissionsValid = unique.length === allowedModels.length && found === unique.length;
      }
      if (!permissionsValid) allowedModels = null;
    } catch {
      permissionsValid = false;
    }
  }
  return {
    id: row.id,
    username: row.username,
    max_daily_input_tokens: row.max_daily_input_tokens,
    max_daily_output_tokens: row.max_daily_output_tokens,
    max_requests_per_minute: row.max_requests_per_minute,
    max_concurrent_requests: row.max_concurrent_requests,
    is_active: Boolean(row.is_active),
    allowed_models: allowedModels,
    permissions_valid: permissionsValid,
    created_at: iso(row.created_at),
    token_count: Number(row.token_count || 0)
  };
}

function userById(userId) {
  return db.prepare(`
    SELECT u.id, u.username, u.max_daily_input_tokens, u.max_daily_output_tokens,
           u.max_requests_per_minute, u.max_concurrent_requests,
           u.is_active, u.allowed_models, u.created_at,
           (SELECT COUNT(*) FROM user_tokens t WHERE t.user_id = u.id AND t.is_active = 1 AND t.revoked_at IS NULL) AS token_count
    FROM users u WHERE u.id = ?
  `).get(userId);
}

function providerResponse(row) {
  return {
    id: row.id,
    provider_name: row.provider_name,
    display_name: row.display_name,
    base_url: row.base_url,
    auth_type: row.auth_type,
    is_active: Boolean(row.is_active),
    last_health_check: iso(row.last_health_check),
    health_status: row.health_status,
    last_health_latency_ms: row.last_health_latency_ms,
    max_concurrent_requests: row.max_concurrent_requests,
    created_at: iso(row.created_at),
    hasApiKey: Boolean(row.has_api_key)
  };
}

function validateUrl(value) {
  return normalizeProviderBaseUrl(nonEmpty(value, 'base_url'));
}

function authType(value) {
  if (typeof value !== 'string' || !AUTH_TYPES.has(value)) {
    throw new ApiError(400, 'auth_type is not supported');
  }
  return value;
}

router.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin-dashboard.html')));
router.use(validateAdmin);
router.use((req, res, next) => {
  if (req.method !== 'POST' && req.method !== 'PUT') return next();
  if (req.body === undefined) req.body = {};
  if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return next(new ApiError(400, 'Request body must be a JSON object'));
  }
  next();
});

router.post('/users', (req, res, next) => {
  try {
    const username = nonEmpty(req.body.username, 'username');
    const inputQuota = req.body.max_daily_input_tokens === undefined
      ? 0
      : nonNegative(req.body.max_daily_input_tokens, 'max_daily_input_tokens');
    const outputQuota = req.body.max_daily_output_tokens === undefined
      ? 0
      : nonNegative(req.body.max_daily_output_tokens, 'max_daily_output_tokens');
    const allowed = req.body.allowed_models === undefined ? null : validateAllowedModels(req.body.allowed_models);
    const rpm = req.body.max_requests_per_minute === undefined ? 60 : positive(req.body.max_requests_per_minute, 'max_requests_per_minute');
    const concurrency = req.body.max_concurrent_requests === undefined ? 2 : positive(req.body.max_concurrent_requests, 'max_concurrent_requests');
    let created;
    db.transaction(() => {
      const placeholder = `pending:${crypto.randomUUID()}`;
      const result = db.prepare(`
        INSERT INTO users
          (username, api_token, max_daily_input_tokens, max_daily_output_tokens, allowed_models,
           max_requests_per_minute, max_concurrent_requests, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(username, placeholder, inputQuota, outputQuota, allowed, rpm, concurrency, new Date().toISOString());
      const userId = Number(result.lastInsertRowid);
      const token = insertToken(userId, 'Initial token');
      db.prepare('UPDATE users SET api_token = ? WHERE id = ?').run(`sha256:${hashToken(token.rawToken)}`, userId);
      created = { userId, apiToken: token.rawToken, tokenId: token.id };
      audit('user.create', 'user', userId, true, ['username', 'quota', 'permissions', 'limits']);
      audit('token.create', 'token', token.id, true, ['name']);
    }).immediate();
    res.status(201).json(created);
  } catch (error) { next(error); }
});

router.get('/users', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT u.id, u.username, u.max_daily_input_tokens, u.max_daily_output_tokens,
             u.max_requests_per_minute, u.max_concurrent_requests,
             u.is_active, u.allowed_models, u.created_at,
             (SELECT COUNT(*) FROM user_tokens t WHERE t.user_id = u.id AND t.is_active = 1 AND t.revoked_at IS NULL) AS token_count
      FROM users u ORDER BY u.id
    `).all().map(userResponse));
  } catch (error) { next(error); }
});

router.put('/users/:id', (req, res, next) => {
  try {
    const userId = id(req.params.id, 'user id');
    const fields = [];
    const values = [];
    if (req.body.max_daily_input_tokens !== undefined) {
      fields.push('max_daily_input_tokens = ?');
      values.push(nonNegative(req.body.max_daily_input_tokens, 'max_daily_input_tokens'));
    }
    if (req.body.max_daily_output_tokens !== undefined) {
      fields.push('max_daily_output_tokens = ?');
      values.push(nonNegative(req.body.max_daily_output_tokens, 'max_daily_output_tokens'));
    }
    if (req.body.max_requests_per_minute !== undefined) {
      fields.push('max_requests_per_minute = ?'); values.push(positive(req.body.max_requests_per_minute, 'max_requests_per_minute'));
    }
    if (req.body.max_concurrent_requests !== undefined) {
      fields.push('max_concurrent_requests = ?'); values.push(positive(req.body.max_concurrent_requests, 'max_concurrent_requests'));
    }
    if (req.body.is_active !== undefined) {
      fields.push('is_active = ?'); values.push(boolean(req.body.is_active, 'is_active'));
    }
    if (req.body.allowed_models !== undefined) {
      fields.push('allowed_models = ?'); values.push(validateAllowedModels(req.body.allowed_models));
    }
    if (!fields.length) throw new ApiError(400, 'No supported fields were provided');
    const result = db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values, userId);
    if (!result.changes) throw new ApiError(404, 'User not found');
    audit('user.update', 'user', userId, true, auditChangedFields(req.body, USER_UPDATE_AUDIT_FIELDS));
    res.json(userResponse(userById(userId)));
  } catch (error) { next(error); }
});

router.delete('/users/:id', (req, res, next) => {
  try {
    const userId = id(req.params.id, 'user id');
    const result = db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
    if (!result.changes) throw new ApiError(404, 'User not found');
    audit('user.deactivate', 'user', userId, true, ['is_active']);
    res.json({ message: 'User deactivated' });
  } catch (error) { next(error); }
});

router.post('/users/:id/rotate-token', (req, res, next) => {
  try {
    const userId = id(req.params.id, 'user id');
    if (!userById(userId)) throw new ApiError(404, 'User not found');
    let token;
    db.transaction(() => {
      const now = new Date().toISOString();
      db.prepare('UPDATE user_tokens SET is_active = 0, revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
      token = insertToken(userId, 'Rotated token');
      db.prepare('UPDATE users SET api_token = ? WHERE id = ?').run(`sha256:${hashToken(token.rawToken)}`, userId);
      audit('token.rotate', 'user', userId, true, ['tokens']);
    }).immediate();
    res.json({ userId, apiToken: token.rawToken, tokenId: token.id });
  } catch (error) { next(error); }
});

router.get('/users/:id/tokens', (req, res, next) => {
  try {
    const userId = id(req.params.id, 'user id');
    if (!userById(userId)) throw new ApiError(404, 'User not found');
    res.json(db.prepare(`
      SELECT id, name, token_prefix, created_at, expires_at, last_used_at, revoked_at, is_active
      FROM user_tokens WHERE user_id = ? ORDER BY id
    `).all(userId).map((token) => ({
      ...token,
      is_active: Boolean(token.is_active),
      created_at: iso(token.created_at),
      expires_at: iso(token.expires_at),
      last_used_at: iso(token.last_used_at),
      revoked_at: iso(token.revoked_at)
    })));
  } catch (error) { next(error); }
});

router.post('/users/:id/tokens', (req, res, next) => {
  try {
    const userId = id(req.params.id, 'user id');
    if (!userById(userId)) throw new ApiError(404, 'User not found');
    const name = req.body.name === undefined ? 'API token' : nonEmpty(req.body.name, 'name');
    const token = insertToken(userId, name, optionalExpiry(req.body.expires_at));
    audit('token.create', 'token', token.id, true, ['name', 'expires_at']);
    res.status(201).json({ tokenId: token.id, apiToken: token.rawToken });
  } catch (error) { next(error); }
});

router.delete('/users/:userId/tokens/:tokenId', (req, res, next) => {
  try {
    const userId = id(req.params.userId, 'user id');
    const tokenId = id(req.params.tokenId, 'token id');
    const result = db.prepare(`
      UPDATE user_tokens SET is_active = 0, revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), tokenId, userId);
    if (!result.changes) throw new ApiError(404, 'Active token not found');
    audit('token.revoke', 'token', tokenId, true, ['is_active', 'revoked_at']);
    res.json({ message: 'Token revoked' });
  } catch (error) { next(error); }
});

router.get('/models', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT m.id, m.model_name, m.display_name, m.model_type, m.is_active, m.max_tokens,
             m.max_concurrent_requests,
             m.input_cost_per_million, m.output_cost_per_million,
             m.context_window, m.default_temperature, m.default_top_p,
             m.default_presence_penalty, m.default_frequency_penalty, m.default_seed,
             m.provider_id, p.provider_name, m.created_at
      FROM models m LEFT JOIN providers p ON p.id = m.provider_id ORDER BY m.id
    `).all().map((row) => ({ ...row, is_active: Boolean(row.is_active), created_at: iso(row.created_at) }));
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/models', (req, res, next) => {
  try {
    const modelName = modelIdentifier(req.body.model_name);
    const displayName = nonEmpty(req.body.display_name, 'display_name');
    const modelType = req.body.model_type === undefined ? 'chat' : identifier(req.body.model_type, 'model_type');
    const maxTokens = req.body.max_tokens === undefined ? 4096 : positive(req.body.max_tokens, 'max_tokens');
    const maxConcurrent = req.body.max_concurrent_requests === undefined ? 4 : positive(req.body.max_concurrent_requests, 'max_concurrent_requests');
    const inputPrice = req.body.input_cost_per_million === undefined ? null : nullablePrice(req.body.input_cost_per_million, 'input_cost_per_million');
    const outputPrice = req.body.output_cost_per_million === undefined ? null : nullablePrice(req.body.output_cost_per_million, 'output_cost_per_million');
    const contextWindow = req.body.context_window === undefined ? null : nullablePositive(req.body.context_window, 'context_window');
    const defaultTemperature = req.body.default_temperature === undefined
      ? null
      : nullableRange(req.body.default_temperature, 'default_temperature', 0, 2);
    const defaultTopP = req.body.default_top_p === undefined
      ? null
      : nullableRange(req.body.default_top_p, 'default_top_p', 0, 1);
    const defaultPresencePenalty = req.body.default_presence_penalty === undefined
      ? null
      : nullableRange(req.body.default_presence_penalty, 'default_presence_penalty', -2, 2);
    const defaultFrequencyPenalty = req.body.default_frequency_penalty === undefined
      ? null
      : nullableRange(req.body.default_frequency_penalty, 'default_frequency_penalty', -2, 2);
    const defaultSeed = req.body.default_seed === undefined
      ? null
      : nullableSafeInteger(req.body.default_seed, 'default_seed');
    assertModelCapacity(maxTokens, contextWindow);
    const providerId = id(req.body.provider_id, 'provider_id');
    if (!db.prepare('SELECT id FROM providers WHERE id = ?').get(providerId)) throw new ApiError(400, 'provider_id is unknown');
    const result = db.prepare(`
      INSERT INTO models
        (model_name, display_name, model_type, provider_id, max_tokens,
         max_concurrent_requests, input_cost_per_million, output_cost_per_million,
         context_window, default_temperature, default_top_p,
         default_presence_penalty, default_frequency_penalty, default_seed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      modelName, displayName, modelType, providerId, maxTokens, maxConcurrent, inputPrice, outputPrice,
      contextWindow, defaultTemperature, defaultTopP, defaultPresencePenalty,
      defaultFrequencyPenalty, defaultSeed, new Date().toISOString()
    );
    const modelId = Number(result.lastInsertRowid);
    audit('model.create', 'model', modelId, true, auditChangedFields(req.body, MODEL_CREATE_AUDIT_FIELDS));
    res.status(201).json({
      id: modelId, model_name: modelName, display_name: displayName,
      model_type: modelType, provider_id: providerId, max_tokens: maxTokens,
      max_concurrent_requests: maxConcurrent,
      input_cost_per_million: inputPrice, output_cost_per_million: outputPrice,
      context_window: contextWindow, default_temperature: defaultTemperature,
      default_top_p: defaultTopP, default_presence_penalty: defaultPresencePenalty,
      default_frequency_penalty: defaultFrequencyPenalty, default_seed: defaultSeed,
      is_active: true
    });
  } catch (error) { next(error); }
});

router.put('/models/:id', (req, res, next) => {
  try {
    const modelId = id(req.params.id, 'model id');
    const existingModel = db.prepare('SELECT model_name, max_tokens, context_window FROM models WHERE id = ?').get(modelId);
    if (!existingModel) throw new ApiError(404, 'Model not found');
    const nextMaxTokens = Object.hasOwn(req.body, 'max_tokens')
      ? positive(req.body.max_tokens, 'max_tokens')
      : existingModel.max_tokens;
    const nextContextWindow = Object.hasOwn(req.body, 'context_window')
      ? nullablePositive(req.body.context_window, 'context_window')
      : existingModel.context_window;
    assertModelCapacity(nextMaxTokens, nextContextWindow);
    const fields = [];
    const values = [];
    const newModelName = req.body.model_name === undefined
      ? existingModel.model_name
      : modelIdentifier(req.body.model_name);
    if (req.body.model_name !== undefined) { fields.push('model_name = ?'); values.push(newModelName); }
    if (req.body.display_name !== undefined) { fields.push('display_name = ?'); values.push(nonEmpty(req.body.display_name, 'display_name')); }
    if (req.body.model_type !== undefined) { fields.push('model_type = ?'); values.push(identifier(req.body.model_type, 'model_type')); }
    if (req.body.is_active !== undefined) { fields.push('is_active = ?'); values.push(boolean(req.body.is_active, 'is_active')); }
    if (Object.hasOwn(req.body, 'max_tokens')) { fields.push('max_tokens = ?'); values.push(nextMaxTokens); }
    if (req.body.max_concurrent_requests !== undefined) {
      fields.push('max_concurrent_requests = ?'); values.push(positive(req.body.max_concurrent_requests, 'max_concurrent_requests'));
    }
    if (req.body.input_cost_per_million !== undefined) {
      fields.push('input_cost_per_million = ?');
      values.push(nullablePrice(req.body.input_cost_per_million, 'input_cost_per_million'));
    }
    if (req.body.output_cost_per_million !== undefined) {
      fields.push('output_cost_per_million = ?');
      values.push(nullablePrice(req.body.output_cost_per_million, 'output_cost_per_million'));
    }
    if (Object.hasOwn(req.body, 'context_window')) {
      fields.push('context_window = ?'); values.push(nextContextWindow);
    }
    if (Object.hasOwn(req.body, 'default_temperature')) {
      fields.push('default_temperature = ?');
      values.push(nullableRange(req.body.default_temperature, 'default_temperature', 0, 2));
    }
    if (Object.hasOwn(req.body, 'default_top_p')) {
      fields.push('default_top_p = ?');
      values.push(nullableRange(req.body.default_top_p, 'default_top_p', 0, 1));
    }
    if (Object.hasOwn(req.body, 'default_presence_penalty')) {
      fields.push('default_presence_penalty = ?');
      values.push(nullableRange(req.body.default_presence_penalty, 'default_presence_penalty', -2, 2));
    }
    if (Object.hasOwn(req.body, 'default_frequency_penalty')) {
      fields.push('default_frequency_penalty = ?');
      values.push(nullableRange(req.body.default_frequency_penalty, 'default_frequency_penalty', -2, 2));
    }
    if (Object.hasOwn(req.body, 'default_seed')) {
      fields.push('default_seed = ?');
      values.push(nullableSafeInteger(req.body.default_seed, 'default_seed'));
    }
    if (req.body.provider_id !== undefined) {
      const providerId = id(req.body.provider_id, 'provider_id');
      if (!db.prepare('SELECT id FROM providers WHERE id = ?').get(providerId)) throw new ApiError(400, 'provider_id is unknown');
      fields.push('provider_id = ?'); values.push(providerId);
    }
    if (!fields.length) throw new ApiError(400, 'No supported fields were provided');
    db.transaction(() => {
      if (newModelName !== existingModel.model_name) {
        const updatePermissions = db.prepare('UPDATE users SET allowed_models = ? WHERE id = ?');
        for (const user of db.prepare('SELECT id, allowed_models FROM users WHERE allowed_models IS NOT NULL').all()) {
          let allowed;
          try { allowed = JSON.parse(user.allowed_models); } catch { continue; }
          if (!Array.isArray(allowed) || allowed.some((value) => typeof value !== 'string' || !MODEL_IDENTIFIER.test(value))) {
            continue;
          }
          if (allowed.includes(existingModel.model_name)) {
            updatePermissions.run(JSON.stringify(allowed.map((value) => value === existingModel.model_name ? newModelName : value)), user.id);
          }
        }
      }
      db.prepare(`UPDATE models SET ${fields.join(', ')} WHERE id = ?`).run(...values, modelId);
    }).immediate();
    const row = db.prepare(`
      SELECT id, model_name, display_name, model_type, provider_id, max_tokens,
             max_concurrent_requests, input_cost_per_million, output_cost_per_million,
             context_window, default_temperature, default_top_p,
             default_presence_penalty, default_frequency_penalty, default_seed,
             is_active, created_at
      FROM models WHERE id = ?
    `).get(modelId);
    audit('model.update', 'model', modelId, true, auditChangedFields(req.body, MODEL_UPDATE_AUDIT_FIELDS));
    res.json({ ...row, is_active: Boolean(row.is_active), created_at: iso(row.created_at) });
  } catch (error) { next(error); }
});

router.delete('/models/:id', (req, res, next) => {
  try {
    const modelId = id(req.params.id, 'model id');
    const model = db.prepare('SELECT model_name FROM models WHERE id = ?').get(modelId);
    if (!model) throw new ApiError(404, 'Model not found');
    for (const row of db.prepare('SELECT allowed_models FROM users WHERE allowed_models IS NOT NULL').all()) {
      let allowed;
      try { allowed = JSON.parse(row.allowed_models); } catch { throw new ApiError(400, 'Cannot delete a model while user permissions are invalid'); }
      if (!Array.isArray(allowed)) throw new ApiError(400, 'Cannot delete a model while user permissions are invalid');
      if (allowed.includes(model.model_name)) throw new ApiError(400, 'Cannot delete a model assigned to a user');
    }
    db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
    audit('model.delete', 'model', modelId, true, []);
    res.json({ message: 'Model deleted' });
  } catch (error) { next(error); }
});

router.get('/filters/built-in-pii', (req, res, next) => {
  try { res.json(getBuiltInPiiFilter()); }
  catch (error) { next(error); }
});

router.put('/filters/built-in-pii', (req, res, next) => {
  try { res.json(setBuiltInPiiFilter(req.body)); }
  catch (error) { next(error); }
});

router.get('/filters', (req, res, next) => {
  try { res.json(listFilters()); }
  catch (error) { next(error); }
});

router.post('/filters', (req, res, next) => {
  try { res.status(201).json(createFilter(req.body)); }
  catch (error) { next(error); }
});

router.put('/filters/:id', (req, res, next) => {
  try { res.json(updateFilter(req.params.id, req.body)); }
  catch (error) { next(error); }
});

router.delete('/filters/:id', (req, res, next) => {
  try {
    deleteFilter(req.params.id);
    res.json({ message: 'Filter deleted' });
  } catch (error) { next(error); }
});

const providerSelect = `
  SELECT id, provider_name, display_name, base_url, auth_type, is_active,
         last_health_check, health_status, last_health_latency_ms, max_concurrent_requests, created_at,
         (stored_api_key IS NOT NULL OR api_key_env_name IS NOT NULL) AS has_api_key
  FROM providers`;

router.get('/providers', (req, res, next) => {
  try { res.json(db.prepare(`${providerSelect} ORDER BY id`).all().map(providerResponse)); }
  catch (error) { next(error); }
});

router.post('/providers', (req, res, next) => {
  try {
    const name = identifier(req.body.provider_name, 'provider_name');
    const displayName = nonEmpty(req.body.display_name, 'display_name');
    const baseUrl = validateUrl(req.body.base_url);
    const type = authType(req.body.auth_type === undefined ? 'api_key' : req.body.auth_type);
    const envName = req.body.api_key_env_name == null || req.body.api_key_env_name === '' ? null : req.body.api_key_env_name;
    if (envName !== null && !/^[A-Z_][A-Z0-9_]*$/.test(envName)) throw new ApiError(400, 'api_key_env_name is invalid');
    const storedKey = req.body.stored_api_key == null || req.body.stored_api_key === '' ? null : credential(req.body.stored_api_key);
    const maxConcurrent = req.body.max_concurrent_requests === undefined ? 8 : positive(req.body.max_concurrent_requests, 'max_concurrent_requests');
    const result = db.prepare(`
      INSERT INTO providers
        (provider_name, display_name, base_url, auth_type, api_key_env_name, stored_api_key, max_concurrent_requests, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, displayName, baseUrl, type, envName, storedKey, maxConcurrent, new Date().toISOString());
    const providerId = Number(result.lastInsertRowid);
    audit('provider.create', 'provider', providerId, true, auditChangedFields(req.body, PROVIDER_CREATE_AUDIT_FIELDS));
    const row = db.prepare(`${providerSelect} WHERE id = ?`).get(providerId);
    res.status(201).json(providerResponse(row));
  } catch (error) { next(error); }
});

router.put('/providers/:id', (req, res, next) => {
  try {
    const providerId = id(req.params.id, 'provider id');
    const fields = [];
    const values = [];
    if (req.body.provider_name !== undefined) { fields.push('provider_name = ?'); values.push(identifier(req.body.provider_name, 'provider_name')); }
    if (req.body.display_name !== undefined) { fields.push('display_name = ?'); values.push(nonEmpty(req.body.display_name, 'display_name')); }
    if (req.body.base_url !== undefined) { fields.push('base_url = ?'); values.push(validateUrl(req.body.base_url)); }
    if (req.body.auth_type !== undefined) { fields.push('auth_type = ?'); values.push(authType(req.body.auth_type)); }
    if (req.body.is_active !== undefined) { fields.push('is_active = ?'); values.push(boolean(req.body.is_active, 'is_active')); }
    if (req.body.max_concurrent_requests !== undefined) {
      fields.push('max_concurrent_requests = ?'); values.push(positive(req.body.max_concurrent_requests, 'max_concurrent_requests'));
    }
    if (req.body.api_key_env_name !== undefined) {
      const envName = req.body.api_key_env_name || null;
      if (envName !== null && !/^[A-Z_][A-Z0-9_]*$/.test(envName)) throw new ApiError(400, 'api_key_env_name is invalid');
      fields.push('api_key_env_name = ?'); values.push(envName);
    }
    if (req.body.stored_api_key !== undefined) {
      fields.push('stored_api_key = ?'); values.push(req.body.stored_api_key ? credential(req.body.stored_api_key) : null);
    }
    if (!fields.length) throw new ApiError(400, 'No supported fields were provided');
    const result = db.prepare(`UPDATE providers SET ${fields.join(', ')} WHERE id = ?`).run(...values, providerId);
    if (!result.changes) throw new ApiError(404, 'Provider not found');
    audit('provider.update', 'provider', providerId, true, auditChangedFields(req.body, PROVIDER_UPDATE_AUDIT_FIELDS));
    res.json(providerResponse(db.prepare(`${providerSelect} WHERE id = ?`).get(providerId)));
  } catch (error) { next(error); }
});

router.post('/providers/:id/test', async (req, res, next) => {
  try {
    const providerId = id(req.params.id, 'provider id');
    const result = await testProvider(providerId);
    audit('provider.test', 'provider', providerId, result.status === 'healthy', ['health_status']);
    res.json(result);
  }
  catch (error) { next(error); }
});

router.get('/provider-presets', (req, res) => res.json(PROVIDER_PRESETS));

router.get('/providers/:id/discover-models', async (req, res, next) => {
  try { res.json(await discoverModels(id(req.params.id, 'provider id'))); }
  catch { next(new ApiError(502, 'Model discovery failed', 'model_discovery_failed')); }
});

router.delete('/providers/:id', (req, res, next) => {
  try {
    const providerId = id(req.params.id, 'provider id');
    if (db.prepare('SELECT COUNT(*) AS count FROM models WHERE provider_id = ?').get(providerId).count) {
      throw new ApiError(400, 'Cannot delete a provider with attached models');
    }
    const result = db.prepare('DELETE FROM providers WHERE id = ?').run(providerId);
    if (!result.changes) throw new ApiError(404, 'Provider not found');
    audit('provider.delete', 'provider', providerId, true, []);
    res.json({ message: 'Provider deleted' });
  } catch (error) { next(error); }
});

router.get('/usage', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT u.id AS user_id, u.username,
             COALESCE(SUM(l.input_tokens), 0) AS total_input,
             COALESCE(SUM(l.output_tokens), 0) AS total_output,
             COALESCE(SUM(l.total_tokens), 0) AS total_tokens
      FROM users u LEFT JOIN usage_logs l ON l.user_id = u.id
      GROUP BY u.id ORDER BY u.id
    `).all());
  } catch (error) { next(error); }
});

router.get('/onboarding', (req, res, next) => {
  try {
    const providerCount = db.prepare('SELECT COUNT(*) AS count FROM providers').get().count;
    const healthyProviderCount = db.prepare("SELECT COUNT(*) AS count FROM providers WHERE health_status = 'healthy'").get().count;
    const modelCount = db.prepare('SELECT COUNT(*) AS count FROM models').get().count;
    const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    const tokenCount = db.prepare('SELECT COUNT(*) AS count FROM user_tokens WHERE is_active = 1 AND revoked_at IS NULL').get().count;
    res.json({
      complete: providerCount > 0 && healthyProviderCount > 0 && modelCount > 0 && userCount > 0 && tokenCount > 0,
      steps: [
        { id: 'provider', label: 'Register a provider', complete: providerCount > 0 },
        { id: 'connection', label: 'Test the connection', complete: healthyProviderCount > 0 },
        { id: 'model', label: 'Discover or register a model', complete: modelCount > 0 },
        { id: 'user', label: 'Create a user', complete: userCount > 0 },
        { id: 'token', label: 'Issue a user token', complete: tokenCount > 0 },
        { id: 'example', label: 'Verify the API example', complete: false }
      ],
      example: "curl -H 'Authorization: Bearer <token>' http://localhost:3000/v1/models"
    });
  } catch (error) { next(error); }
});

router.post('/backup', async (req, res, next) => {
  try { res.status(201).json(await createBackup()); }
  catch (error) { next(error); }
});

router.get('/backups', (req, res, next) => {
  try { res.json(db.prepare('SELECT filename, schema_version, created_at, integrity_status FROM backup_history ORDER BY id DESC').all()); }
  catch (error) { next(error); }
});

router.get('/retention', (req, res) => res.json({ request_log_retention_days: retentionDays() }));

router.put('/retention', (req, res, next) => {
  try {
    const days = nonNegativeInteger(req.body.request_log_retention_days, 'request_log_retention_days');
    setRetentionDays(days);
    res.json({ request_log_retention_days: days });
  } catch (error) { next(error); }
});

router.post('/retention/cleanup', (req, res, next) => {
  try { res.json(cleanupRequestLogs()); }
  catch (error) { next(error); }
});

router.get('/audit-logs', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT id, action, target_type, target_id, success, changed_fields, created_at
      FROM audit_logs ORDER BY id DESC LIMIT 500
    `).all().map((row) => ({
      ...row,
      success: Boolean(row.success),
      changed_fields: JSON.parse(row.changed_fields),
      created_at: iso(row.created_at)
    })));
  } catch (error) { next(error); }
});

router.get('/stats', (req, res, next) => {
  try {
    const period = statsPeriod(req.query);
    const parameters = [period.start, period.endExclusive];
    const aggregateFields = `
      COUNT(*) AS total_requests,
      COALESCE(SUM(l.input_tokens), 0) AS total_input,
      COALESCE(SUM(l.output_tokens), 0) AS total_output,
      COALESCE(SUM(l.total_tokens), 0) AS total_tokens,
      SUM(CASE WHEN l.status = 'success' THEN 1 ELSE 0 END) AS successful_requests,
      SUM(CASE WHEN l.status = 'failure' THEN 1 ELSE 0 END) AS failed_requests,
      COALESCE(AVG(l.response_time_ms), 0) AS average_response_time_ms,
      SUM(CASE WHEN l.status = 'success' AND l.cost_configured = 0 THEN 1 ELSE 0 END) AS unpriced_requests,
      COALESCE(SUM(CASE WHEN l.cost_configured = 1 THEN l.estimated_cost_usd ELSE 0 END), 0) AS configured_cost_usd`;
    const summary = db.prepare(`
      SELECT ${aggregateFields},
             COUNT(DISTINCT l.user_id) AS active_users,
             COUNT(DISTINCT l.model_name) AS active_models,
             COUNT(DISTINCT l.provider_id) AS active_providers
      FROM request_logs l
      WHERE l.created_at >= ? AND l.created_at < ?
    `).get(...parameters);
    const durations = db.prepare(`
      SELECT user_id, model_name, provider_id, response_time_ms
      FROM request_logs
      WHERE created_at >= ? AND created_at < ?
    `).all(...parameters);

    const groupQuery = (identity, joins, groupBy) => db.prepare(`
      SELECT ${identity}, ${aggregateFields}
      FROM request_logs l ${joins}
      WHERE l.created_at >= ? AND l.created_at < ?
      GROUP BY ${groupBy}
      ORDER BY total_requests DESC, name
    `).all(...parameters);

    const byUser = groupQuery(
      "l.user_id AS id, COALESCE(u.username, 'Unknown user') AS name",
      'LEFT JOIN users u ON u.id = l.user_id',
      'l.user_id, u.username'
    );
    const byModel = groupQuery(
      'l.model_name AS id, COALESCE(m.display_name, l.model_name) AS name',
      'LEFT JOIN models m ON m.model_name = l.model_name',
      'l.model_name, m.display_name'
    );
    const byProvider = groupQuery(
      "l.provider_id AS id, COALESCE(p.display_name, 'Deleted provider') AS name",
      'LEFT JOIN providers p ON p.id = l.provider_id',
      'l.provider_id, p.display_name'
    );
    const p95For = (field, value) => percentile95(
      durations.filter((row) => row[field] === value).map((row) => row.response_time_ms)
    );

    const recent = db.prepare(`
      SELECT l.id, l.user_id, u.username, l.model_name, l.provider_id,
             l.status, l.error_type, l.input_tokens, l.output_tokens, l.total_tokens,
             l.response_time_ms, l.estimated_cost_usd, l.cost_configured, l.created_at
      FROM request_logs l
      LEFT JOIN users u ON u.id = l.user_id
      WHERE l.created_at >= ? AND l.created_at < ?
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 100
    `).all(...parameters).map((row) => ({
      ...row,
      cost_configured: Boolean(row.cost_configured),
      created_at: iso(row.created_at)
    }));

    const summaryResult = finalizeAggregate(summary, percentile95(durations.map((row) => row.response_time_ms)));
    summaryResult.total_users = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    res.json({
      generated_at: new Date().toISOString(),
      period: { range: period.range, start: period.start_at, end: period.end_at },
      summary: summaryResult,
      by_user: byUser.map((row) => finalizeAggregate(row, p95For('user_id', row.id))),
      by_model: byModel.map((row) => finalizeAggregate(row, p95For('model_name', row.id))),
      by_provider: byProvider.map((row) => finalizeAggregate(row, p95For('provider_id', row.id))),
      recent_requests: recent
    });
  } catch (error) { next(error); }
});

router.use((error, req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    try {
      const target = failureAuditMetadata(req.path);
      audit(target.action, target.targetType, target.targetId, false, []);
    } catch {}
  }
  next(error);
});

module.exports = router;
