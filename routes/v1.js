const express = require('express');
const db = require('../db/database');
const config = require('../config');
const { validateToken } = require('../middleware/auth');
const { reserveQuota, releaseReservation, recordUsage, recordFailure, getDailyUsage, utcDate } = require('../services/usage');
const { buildProviderEndpoint, getAuthHeaders, getActiveModelsWithProviders } = require('../services/provider-router');
const { ApiError } = require('../services/errors');
const { acquire } = require('../services/limits');

const router = express.Router();
const IDENTIFIER = /^[a-z0-9][a-z0-9_.:/-]{0,199}$/;

function modelPermissions(serialized) {
  if (serialized === null || serialized === undefined) return { all: true };
  try {
    const values = JSON.parse(serialized);
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !IDENTIFIER.test(value))) return null;
    if (values.length === 0) return { all: true };
    const unique = [...new Set(values)];
    if (unique.length !== values.length) return null;
    const placeholders = unique.map(() => '?').join(',');
    const found = db.prepare(`SELECT COUNT(*) AS count FROM models WHERE model_name IN (${placeholders})`).get(...unique).count;
    return found === unique.length ? { all: false, values: new Set(unique) } : null;
  } catch {
    return null;
  }
}

router.get('/models', validateToken, (req, res, next) => {
  try {
    const permissions = modelPermissions(req.user.allowed_models);
    if (!permissions) throw new ApiError(403, 'Model permissions are invalid');
    const models = getActiveModelsWithProviders()
      .filter((model) => permissions.all || permissions.values.has(model.model_name))
      .map((model) => ({
        id: model.model_name,
        name: model.display_name,
        type: model.model_type,
        provider: model.provider_name,
        max_tokens: model.max_tokens
      }));
    res.json(models);
  } catch (error) {
    next(error);
  }
});

function validateModelAccess(req, res, next) {
  try {
    const modelName = req.body && req.body.model;
    if (typeof modelName !== 'string' || !modelName.trim()) {
      throw new ApiError(400, 'model must be a non-empty string');
    }
    const permissions = modelPermissions(req.user.allowed_models);
    if (!permissions) throw new ApiError(403, 'Model permissions are invalid');

    const model = db.prepare(`
      SELECT m.model_name, m.max_tokens, p.id AS provider_id, p.provider_name,
             p.base_url, p.auth_type, p.api_key_env_name, p.stored_api_key,
             m.input_cost_per_million, m.output_cost_per_million,
             m.max_concurrent_requests,
             p.max_concurrent_requests AS provider_max_concurrent_requests
      FROM models m
      JOIN providers p ON p.id = m.provider_id
      WHERE m.model_name = ? AND m.is_active = 1 AND p.is_active = 1
    `).get(modelName);
    if (!model || !model.base_url) throw new ApiError(400, 'Requested model is unavailable');
    if (!permissions.all && !permissions.values.has(modelName)) {
      throw new ApiError(403, 'Access to the requested model is not allowed');
    }
    req.gatewayModel = model;
    next();
  } catch (error) {
    next(error);
  }
}

function usageFromProvider(body) {
  const usage = body && body.usage ? body.usage : {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (inputTokens + outputTokens);
  for (const [name, value] of Object.entries({ prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ApiError(502, `Provider returned invalid ${name}`);
    }
  }
  return { inputTokens, outputTokens };
}

router.post('/chat/completions', validateToken, validateModelAccess, async (req, res, next) => {
  let reservation;
  let releaseLimit;
  let timeout;
  let clientDisconnected = false;
  const startedAt = Date.now();
  const controller = new AbortController();
  const disconnect = () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      controller.abort();
    }
  };
  res.once('close', disconnect);
  try {
    releaseLimit = acquire(req.user, req.gatewayModel);
    reservation = reserveQuota(req.user, req.body.max_tokens, req.gatewayModel.max_tokens);
    const payload = { ...req.body, max_tokens: reservation.maxTokens };
    timeout = setTimeout(() => controller.abort(), config.providerTimeout);
    const response = await fetch(buildProviderEndpoint(req.gatewayModel.base_url, 'chat/completions'), {
      method: 'POST',
      headers: getAuthHeaders(req.gatewayModel),
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'manual'
    });
    if (response.status >= 300 && response.status < 400) {
      throw new ApiError(502, 'Provider redirect was rejected', 'provider_redirect_rejected');
    }
    if (!response.ok) {
      throw new ApiError(502, `Provider returned status ${response.status}`, 'provider_http_error');
    }

    if (req.body.stream === true) {
      await relayStream(response, res, reservation, req.user.id, req.gatewayModel, startedAt);
      reservation = null;
      return;
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(502, 'Provider returned invalid JSON', 'provider_response_invalid');
    }
    const { inputTokens, outputTokens } = usageFromProvider(body);
    recordUsage(
      reservation.requestId,
      req.user.id,
      req.gatewayModel,
      inputTokens,
      outputTokens,
      Date.now() - startedAt
    );
    reservation = null;
    res.json(body);
  } catch (error) {
    const aborted = error.name === 'AbortError';
    const handledError = aborted
      ? clientDisconnected
        ? new ApiError(499, 'Client disconnected', 'client_disconnected')
        : new ApiError(504, 'Provider request timed out', 'provider_timeout')
      : error;
    try {
      recordFailure(
        reservation && reservation.requestId,
        req.user.id,
        req.gatewayModel,
        classifyError(handledError),
        Date.now() - startedAt
      );
      reservation = null;
    } catch {
      if (reservation) releaseReservation(reservation.requestId);
    }
    if (!clientDisconnected && !res.headersSent) next(handledError);
    else if (!res.writableEnded) res.destroy();
  } finally {
    clearTimeout(timeout);
    res.off('close', disconnect);
    if (reservation) releaseReservation(reservation.requestId);
    if (releaseLimit) releaseLimit();
  }
});

async function relayStream(response, res, reservation, userId, model, startedAt) {
  res.status(200);
  res.setHeader('Content-Type', response.headers.get('content-type') || 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const decoder = new TextDecoder();
  let pending = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const chunk of response.body) {
    const text = decoder.decode(chunk, { stream: true });
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const usage = usageFromProvider(parsed);
        if (parsed.usage) {
          inputTokens = usage.inputTokens;
          outputTokens = usage.outputTokens;
        }
      } catch {}
    }
    if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
  }
  res.end();
  recordUsage(reservation.requestId, userId, model, inputTokens, outputTokens, Date.now() - startedAt);
}

function classifyError(error) {
  if (error.status === 429) return 'quota';
  if (error.status === 401 || error.status === 403) return 'authorization';
  if (error.status === 504) return 'timeout';
  if (error.status === 502) {
    return /^Provider returned status /.test(error.message) ? 'provider_http' : 'provider_response';
  }
  return 'internal';
}

router.get('/usage', validateToken, (req, res, next) => {
  try {
    const usage = getDailyUsage(req.user.id) || {
      request_date: utcDate(), input_tokens: 0, output_tokens: 0, total_tokens: 0
    };
    res.json({
      date: usage.request_date,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      remainingInput: Math.max(0, req.user.max_daily_input_tokens - usage.input_tokens),
      remainingOutput: Math.max(0, req.user.max_daily_output_tokens - usage.output_tokens)
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.modelPermissions = modelPermissions;
