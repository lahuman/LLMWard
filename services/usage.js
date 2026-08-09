const crypto = require('crypto');
const db = require('../db/database');
const config = require('../config');
const { ApiError } = require('./errors');

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function tokenCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(502, `Provider returned invalid ${name}`);
  }
  return value;
}

function responseTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(500, 'Response time is invalid');
  }
  return value;
}

function priceSnapshot(model, inputTokens, outputTokens) {
  const inputPrice = model.input_cost_per_million;
  const outputPrice = model.output_cost_per_million;
  const configured = inputPrice !== null && outputPrice !== null &&
    Number.isFinite(inputPrice) && Number.isFinite(outputPrice) &&
    inputPrice >= 0 && outputPrice >= 0;
  if (!configured) return { configured: 0, cost: null };
  const cost = ((inputTokens * inputPrice) + (outputTokens * outputPrice)) / 1_000_000;
  return Number.isFinite(cost) ? { configured: 1, cost } : { configured: 0, cost: null };
}

function runImmediate(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function reserveQuota(user, requestedMaxTokens, modelMaxTokens) {
  if (!Number.isSafeInteger(modelMaxTokens) || modelMaxTokens <= 0) {
    throw new ApiError(500, 'Model token limit is invalid');
  }
  if (requestedMaxTokens !== undefined &&
      (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens <= 0)) {
    throw new ApiError(400, 'max_tokens must be a positive safe integer');
  }
  if (!Number.isSafeInteger(user.max_daily_input_tokens) || user.max_daily_input_tokens <= 0 ||
      !Number.isSafeInteger(user.max_daily_output_tokens) || user.max_daily_output_tokens <= 0) {
    throw new ApiError(500, 'User quota configuration is invalid');
  }

  return runImmediate(() => {
    const now = new Date();
    const date = utcDate();
    db.prepare('DELETE FROM quota_reservations WHERE expires_at <= ?').run(now.toISOString());

    const usage = db.prepare(`
      SELECT input_tokens, output_tokens FROM usage_logs
      WHERE user_id = ? AND request_date = ?
    `).get(user.id, date) || { input_tokens: 0, output_tokens: 0 };
    tokenCount(usage.input_tokens, 'stored input token usage');
    tokenCount(usage.output_tokens, 'stored output token usage');

    if (usage.input_tokens >= user.max_daily_input_tokens) {
      throw new ApiError(429, 'Daily input token quota exceeded');
    }

    const reserved = db.prepare(`
      SELECT COALESCE(SUM(output_tokens), 0) AS tokens
      FROM quota_reservations WHERE user_id = ? AND request_date = ?
    `).get(user.id, date).tokens;
    const remaining = user.max_daily_output_tokens - usage.output_tokens - reserved;
    if (!Number.isSafeInteger(remaining) || remaining <= 0) {
      throw new ApiError(429, 'Daily output token quota exceeded');
    }

    const maxTokens = Math.min(requestedMaxTokens || modelMaxTokens, modelMaxTokens, remaining);
    const requestId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + config.providerTimeout + 30000).toISOString();
    db.prepare(`
      INSERT INTO quota_reservations
        (request_id, user_id, request_date, output_tokens, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(requestId, user.id, date, maxTokens, expiresAt);
    return { requestId, maxTokens };
  });
}

function releaseReservation(requestId) {
  if (requestId) {
    db.prepare('DELETE FROM quota_reservations WHERE request_id = ?').run(requestId);
  }
}

function recordUsage(requestId, userId, model, inputTokens, outputTokens, durationMs) {
  tokenCount(inputTokens, 'input token usage');
  tokenCount(outputTokens, 'output token usage');
  responseTime(durationMs);
  const totalTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens)) {
    throw new ApiError(502, 'Provider returned invalid total token usage');
  }

  runImmediate(() => {
    const reservation = db.prepare(`
      SELECT output_tokens, request_date FROM quota_reservations
      WHERE request_id = ? AND user_id = ?
    `).get(requestId, userId);
    if (!reservation) {
      throw new ApiError(500, 'Quota reservation is unavailable');
    }
    if (outputTokens > reservation.output_tokens) {
      throw new ApiError(502, 'Provider exceeded the reserved output token limit');
    }

    const pricing = priceSnapshot(model, inputTokens, outputTokens);

    db.prepare(`
      INSERT INTO usage_logs (user_id, request_date, input_tokens, output_tokens, total_tokens)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, request_date) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens = total_tokens + excluded.total_tokens
    `).run(userId, reservation.request_date, inputTokens, outputTokens, totalTokens);

    db.prepare(`
      INSERT INTO request_logs
        (user_id, model_name, provider_id, input_tokens, output_tokens, total_tokens,
         status, error_type, response_time_ms, estimated_cost_usd, cost_configured, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'success', NULL, ?, ?, ?, ?)
    `).run(
      userId,
      model.model_name,
      model.provider_id,
      inputTokens,
      outputTokens,
      totalTokens,
      durationMs,
      pricing.cost,
      pricing.configured,
      new Date().toISOString()
    );
    db.prepare('DELETE FROM quota_reservations WHERE request_id = ?').run(requestId);
  });
}

function recordFailure(requestId, userId, model, errorType, durationMs) {
  const allowedErrors = new Set(['authorization', 'quota', 'timeout', 'provider_http', 'provider_response', 'internal']);
  const safeError = allowedErrors.has(errorType) ? errorType : 'internal';
  responseTime(durationMs);
  const pricing = priceSnapshot(model, 0, 0);

  runImmediate(() => {
    if (requestId) db.prepare('DELETE FROM quota_reservations WHERE request_id = ?').run(requestId);
    db.prepare(`
      INSERT INTO request_logs
        (user_id, model_name, provider_id, input_tokens, output_tokens, total_tokens,
         status, error_type, response_time_ms, estimated_cost_usd, cost_configured, created_at)
      VALUES (?, ?, ?, 0, 0, 0, 'failure', ?, ?, ?, ?, ?)
    `).run(
      userId,
      model.model_name,
      model.provider_id,
      safeError,
      durationMs,
      pricing.cost,
      pricing.configured,
      new Date().toISOString()
    );
  });
}

function getDailyUsage(userId) {
  return db.prepare(`
    SELECT request_date, input_tokens, output_tokens, total_tokens
    FROM usage_logs WHERE user_id = ? AND request_date = ?
  `).get(userId, utcDate());
}

module.exports = { reserveQuota, releaseReservation, recordUsage, recordFailure, getDailyUsage, utcDate };
