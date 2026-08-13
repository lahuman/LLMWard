const express = require('express');
const { once } = require('node:events');
const db = require('../db/database');
const config = require('../config');
const { validateToken } = require('../middleware/auth');
const usage = require('../services/usage');
const { reserveQuota, recordUsage, getDailyUsage, utcDate } = usage;
const { buildProviderEndpoint, getAuthHeaders, getActiveModelsWithProviders } = require('../services/provider-router');
const { ApiError } = require('../services/errors');
const { acquire } = require('../services/limits');
const contentFilters = require('../services/content-filters');

const router = express.Router();
const activeRequests = new Set();
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
      SELECT m.id AS model_id, m.model_name, m.max_tokens, p.id AS provider_id, p.provider_name,
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
  let providerTimeout;
  let streamIdleTimeout;
  let streamMaxDurationTimeout;
  let clientDisconnected = false;
  let requestFinalized = false;
  const startedAt = Date.now();
  let abortCause = null;
  const controller = new AbortController();
  const abortRequest = (cause) => {
    if (controller.signal.aborted) return;
    abortCause = cause;
    controller.abort();
  };
  const abortForTimeout = () => abortRequest('timeout');
  const refreshStreamIdleTimeout = () => {
    clearTimeout(streamIdleTimeout);
    streamIdleTimeout = setTimeout(abortForTimeout, config.streamIdleTimeoutMs);
  };
  activeRequests.add(abortRequest);
  const disconnect = () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      abortRequest('client');
    }
  };
  res.once('close', disconnect);
  try {
    releaseLimit = acquire(req.user, req.gatewayModel);
    const filterSnapshot = contentFilters.getEffectiveFilterSnapshot(req.gatewayModel.model_id);
    const filteredBody = contentFilters.applyInputFilters(req.body, filterSnapshot);
    const streaming = req.body.stream === true;
    const requestLifetimeMs = streaming
      ? config.streamMaxDurationMs
      : config.providerTimeoutMs;
    reservation = reserveQuota(req.user, req.body.max_tokens, req.gatewayModel.max_tokens, requestLifetimeMs);
    const payload = { ...filteredBody, max_tokens: reservation.maxTokens };
    contentFilters.assertRequestSize(payload);
    const serializedPayload = JSON.stringify(payload);
    providerTimeout = setTimeout(abortForTimeout, config.providerTimeoutMs);
    if (streaming) {
      streamMaxDurationTimeout = setTimeout(
        abortForTimeout,
        config.streamMaxDurationMs
      );
    }
    const response = await fetch(buildProviderEndpoint(req.gatewayModel.base_url, 'chat/completions'), {
      method: 'POST',
      headers: getAuthHeaders(req.gatewayModel),
      body: serializedPayload,
      signal: controller.signal,
      redirect: 'manual'
    });
    if (streaming) {
      clearTimeout(providerTimeout);
      providerTimeout = undefined;
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ApiError(502, 'Provider redirect was rejected', 'provider_redirect_rejected');
    }
    if (!response.ok) {
      throw new ApiError(502, `Provider returned status ${response.status}`, 'provider_http_error');
    }

    if (streaming) {
      let streamUsage;
      refreshStreamIdleTimeout();
      try {
        streamUsage = await relayStream(
          response,
          res,
          controller.signal,
          filterSnapshot.output_mask_patterns,
          refreshStreamIdleTimeout
        );
      } catch (error) {
        if (error.code === 'filter_processing_failed') {
          abortRequest('filter');
          if (error.providerUsage) {
            recordUsage(
              reservation.requestId,
              req.user.id,
              req.gatewayModel,
              error.providerUsage.inputTokens,
              error.providerUsage.outputTokens,
              Date.now() - startedAt,
              { status: 'failure', errorType: 'filter' }
            );
            reservation = null;
            requestFinalized = true;
          }
        }
        throw error;
      }
      recordUsage(
        reservation.requestId,
        req.user.id,
        req.gatewayModel,
        streamUsage.inputTokens,
        streamUsage.outputTokens,
        Date.now() - startedAt
      );
      reservation = null;
      requestFinalized = true;
      return;
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new ApiError(502, 'Provider returned invalid JSON', 'provider_response_invalid');
    }
    const { inputTokens, outputTokens } = usageFromProvider(body);
    let filteredResponse;
    try {
      filteredResponse = contentFilters.applyOutputFilters(body, filterSnapshot);
    } catch {
      recordUsage(
        reservation.requestId,
        req.user.id,
        req.gatewayModel,
        inputTokens,
        outputTokens,
        Date.now() - startedAt,
        { status: 'failure', errorType: 'filter' }
      );
      reservation = null;
      requestFinalized = true;
      throw new ApiError(502, 'Content filter processing failed', 'filter_processing_failed');
    }
    recordUsage(
      reservation.requestId,
      req.user.id,
      req.gatewayModel,
      inputTokens,
      outputTokens,
      Date.now() - startedAt
    );
    reservation = null;
    requestFinalized = true;
    res.json(filteredResponse);
  } catch (error) {
    const aborted = error.name === 'AbortError' && controller.signal.aborted;
    const handledError = aborted
      ? abortCause === 'client'
        ? new ApiError(499, 'Client disconnected', 'client_disconnected')
        : abortCause === 'timeout'
          ? new ApiError(504, 'Provider request timed out', 'provider_timeout')
          : new ApiError(503, 'Gateway is shutting down', 'gateway_shutdown')
      : error;
    if (!requestFinalized) {
      const requestId = reservation && reservation.requestId;
      try {
        usage.recordFailure(
          requestId,
          req.user.id,
          req.gatewayModel,
          classifyError(handledError),
          Date.now() - startedAt
        );
        reservation = null;
        requestFinalized = true;
      } catch {
        try {
          if (requestId) {
            usage.releaseReservation(requestId);
            reservation = null;
            requestFinalized = true;
          }
        } catch {}
      }
    }
    if (!clientDisconnected && !res.headersSent) next(handledError);
    else if (!res.writableEnded) res.destroy();
  } finally {
    clearTimeout(providerTimeout);
    clearTimeout(streamIdleTimeout);
    clearTimeout(streamMaxDurationTimeout);
    activeRequests.delete(abortRequest);
    res.off('close', disconnect);
    if (reservation && !requestFinalized) {
      try {
        usage.releaseReservation(reservation.requestId);
        reservation = null;
        requestFinalized = true;
      } catch {
        // A cleanup failure must not replace the request error.
      }
    }
    if (releaseLimit) releaseLimit();
  }
});

function setStreamHeaders(response, res) {
  res.status(200);
  res.setHeader('Content-Type', response.headers.get('content-type') || 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
}

async function writeStreamChunk(response, res, chunk, signal) {
  if (!res.headersSent) {
    setStreamHeaders(response, res);
    res.flushHeaders();
  }
  if (!res.write(chunk)) await once(res, 'drain', { signal });
}

async function relayStream(response, res, signal, outputPatterns, onChunk) {
  if (outputPatterns.length > 0) {
    return relayFilteredStream(response, res, signal, outputPatterns, onChunk);
  }
  setStreamHeaders(response, res);
  res.flushHeaders();
  const decoder = new TextDecoder();
  let pending = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const chunk of response.body) {
    onChunk();
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
    if (!res.write(chunk)) await once(res, 'drain', { signal });
  }
  res.end();
  return { inputTokens, outputTokens };
}


function createMaskState(patterns) {
  return {
    filter: contentFilters.createLiteralFilter(patterns),
    maxPatternLength: Math.max(...patterns.map((pattern) => pattern.length)),
    choices: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    usageSeen: false,
    done: false
  };
}

function choiceState(streamState, index) {
  let state = streamState.choices.get(index);
  if (!state) {
    state = { carry: '', finished: false };
    streamState.choices.set(index, state);
  }
  return state;
}

function maskIncrementally(state, content, streamState, terminal = false) {
  const combined = state.carry + content;
  let boundary = terminal
    ? combined.length
    : Math.max(0, combined.length - (streamState.maxPatternLength - 1));
  if (boundary > 0 && boundary < combined.length &&
      /[\uD800-\uDBFF]/u.test(combined[boundary - 1]) &&
      /[\uDC00-\uDFFF]/u.test(combined[boundary])) {
    boundary -= 1;
  }

  if (!terminal) boundary = streamState.filter.extendBoundary(combined, boundary);
  const output = streamState.filter.replace(combined.slice(0, boundary));
  state.carry = combined.slice(boundary);
  return output;
}

function filterStreamError(streamState) {
  const error = new ApiError(502, 'Content filter processing failed', 'filter_processing_failed');
  if (streamState.usageSeen) {
    Object.defineProperty(error, 'providerUsage', {
      value: {
        inputTokens: streamState.inputTokens,
        outputTokens: streamState.outputTokens
      }
    });
  }
  return error;
}

function isDataLine(line) {
  return line === 'data' || line.startsWith('data:');
}

function dataValue(line) {
  if (line === 'data') return '';
  const value = line.slice(5);
  return value.startsWith(' ') ? value.slice(1) : value;
}

function serializeDataEvent(lines, body, delimiter) {
  const newline = delimiter.startsWith('\r\n') ? '\r\n' : '\n';
  const serialized = `data: ${JSON.stringify(body)}`;
  const output = [];
  let inserted = false;
  for (const line of lines) {
    if (isDataLine(line)) {
      if (!inserted) output.push(serialized);
      inserted = true;
    } else {
      output.push(line);
    }
  }
  return output.join(newline) + delimiter;
}

function flushChoices(streamState, delimiter) {
  const choices = [];
  for (const [index, state] of streamState.choices) {
    if (!state.carry) continue;
    const content = maskIncrementally(state, '', streamState, true);
    if (content) choices.push({ index, delta: { content }, finish_reason: null });
  }
  if (choices.length === 0) return [];
  return [`data: ${JSON.stringify({ choices })}${delimiter}`];
}

function transformDataEvent(rawEvent, delimiter, streamState) {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines = lines.filter(isDataLine);
  if (dataLines.length === 0) return [rawEvent + delimiter];
  if (streamState.done) throw filterStreamError(streamState);
  const data = dataLines.map(dataValue).join('\n');
  if (data.trim() === '[DONE]') {
    streamState.done = true;
    return [...flushChoices(streamState, delimiter), rawEvent + delimiter];
  }

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw filterStreamError(streamState);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw filterStreamError(streamState);
  }

  if (Object.hasOwn(parsed, 'usage') && parsed.usage !== null) {
    if (!parsed.usage || typeof parsed.usage !== 'object' || Array.isArray(parsed.usage)) {
      throw filterStreamError(streamState);
    }
    let providerUsage;
    try {
      providerUsage = usageFromProvider(parsed);
    } catch {
      throw filterStreamError(streamState);
    }
    streamState.inputTokens = providerUsage.inputTokens;
    streamState.outputTokens = providerUsage.outputTokens;
    streamState.usageSeen = true;
  }

  if (Object.hasOwn(parsed, 'choices')) {
    if (!Array.isArray(parsed.choices)) throw filterStreamError(streamState);
    const eventIndexes = new Set();
    for (const choice of parsed.choices) {
      if (!choice || typeof choice !== 'object' || Array.isArray(choice) ||
          !Number.isSafeInteger(choice.index) || choice.index < 0 || eventIndexes.has(choice.index) ||
          !choice.delta || typeof choice.delta !== 'object' || Array.isArray(choice.delta)) {
        throw filterStreamError(streamState);
      }
      eventIndexes.add(choice.index);
      const state = choiceState(streamState, choice.index);
      if (state.finished) throw filterStreamError(streamState);
      const hasContent = Object.hasOwn(choice.delta, 'content');
      if (hasContent && choice.delta.content !== null && typeof choice.delta.content !== 'string') {
        throw filterStreamError(streamState);
      }
      const finishes = Object.hasOwn(choice, 'finish_reason') && choice.finish_reason !== null;
      if (finishes && typeof choice.finish_reason !== 'string') throw filterStreamError(streamState);
      const content = typeof choice.delta.content === 'string' ? choice.delta.content : '';
      let output = maskIncrementally(state, content, streamState);
      if (finishes) {
        output += maskIncrementally(state, '', streamState, true);
        state.finished = true;
      }
      if (typeof choice.delta.content === 'string' || output) choice.delta.content = output;
    }
  }

  return [serializeDataEvent(lines, parsed, delimiter)];
}

const FILTERED_SSE_EVENT_BYTE_LIMIT = 1024 * 1024;
const INITIAL_FILTERED_SSE_EVENT_CAPACITY = 4096;

function createEventAccumulator() {
  return {
    buffer: Buffer.allocUnsafe(INITIAL_FILTERED_SSE_EVENT_CAPACITY),
    length: 0,
    previousLineEndingLength: 0,
    pendingCarriageReturn: false
  };
}

function growEventAccumulator(pending) {
  if (pending.length < pending.buffer.length) return;
  const capacity = Math.min(FILTERED_SSE_EVENT_BYTE_LIMIT, pending.buffer.length * 2);
  const buffer = Buffer.allocUnsafe(capacity);
  pending.buffer.copy(buffer, 0, 0, pending.length);
  pending.buffer = buffer;
}

function completeLineEnding(pending, lineEndingLength) {
  if (pending.length === lineEndingLength) return lineEndingLength;
  if (pending.previousLineEndingLength > 0) {
    return pending.previousLineEndingLength + lineEndingLength;
  }
  pending.previousLineEndingLength = lineEndingLength;
  return 0;
}

function appendEventByte(pending, byte, streamState) {
  if (pending.length === FILTERED_SSE_EVENT_BYTE_LIMIT) throw filterStreamError(streamState);
  growEventAccumulator(pending);
  pending.buffer[pending.length] = byte;
  pending.length += 1;

  if (pending.pendingCarriageReturn) {
    pending.pendingCarriageReturn = false;
    if (byte === 0x0a) return completeLineEnding(pending, 2);
    pending.previousLineEndingLength = 0;
  }
  if (byte === 0x0d) {
    pending.pendingCarriageReturn = true;
    return 0;
  }
  if (byte === 0x0a) return completeLineEnding(pending, 1);
  pending.previousLineEndingLength = 0;
  return 0;
}

function resetEventAccumulator(pending) {
  pending.length = 0;
  pending.previousLineEndingLength = 0;
  pending.pendingCarriageReturn = false;
}

async function writeCompleteEvents(response, res, signal, pending, bytes, streamState) {
  for (const byte of bytes) {
    const delimiterLength = appendEventByte(pending, byte, streamState);
    if (delimiterLength === 0) continue;
    let events;
    try {
      const rawLength = pending.length - delimiterLength;
      const rawEvent = new TextDecoder('utf-8', { fatal: true }).decode(
        pending.buffer.subarray(0, rawLength)
      );
      events = transformDataEvent(
        rawEvent,
        pending.buffer.toString('ascii', rawLength, pending.length),
        streamState
      );
    } catch (error) {
      if (error.code === 'filter_processing_failed') throw error;
      throw filterStreamError(streamState);
    }
    resetEventAccumulator(pending);
    for (const event of events) {
      await writeStreamChunk(response, res, event, signal);
    }
  }
}

async function relayFilteredStream(response, res, signal, patterns, onChunk) {
  const streamState = createMaskState(patterns);
  const pending = createEventAccumulator();
  for await (const chunk of response.body) {
    onChunk();
    await writeCompleteEvents(response, res, signal, pending, chunk, streamState);
  }

  if (pending.length > 0) throw filterStreamError(streamState);
  const finalOutput = streamState.done ? [] : flushChoices(streamState, '\n\n');
  for (const event of finalOutput) {
    await writeStreamChunk(response, res, event, signal);
  }
  if (!res.headersSent) {
    setStreamHeaders(response, res);
    res.flushHeaders();
  }
  res.end();
  return { inputTokens: streamState.inputTokens, outputTokens: streamState.outputTokens };
}

function classifyError(error) {
  if (new Set([
    'content_filtered',
    'filter_configuration_invalid',
    'filter_processing_failed',
    'request_too_large'
  ]).has(error.code)) return 'filter';
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
      remainingInput: req.user.max_daily_input_tokens === 0
        ? null
        : Math.max(0, req.user.max_daily_input_tokens - usage.input_tokens),
      remainingOutput: req.user.max_daily_output_tokens === 0
        ? null
        : Math.max(0, req.user.max_daily_output_tokens - usage.output_tokens)
    });
  } catch (error) {
    next(error);
  }
});

function abortInFlight() {
  for (const abortRequest of activeRequests) abortRequest('shutdown');
}

module.exports = router;
module.exports.modelPermissions = modelPermissions;
module.exports.abortInFlight = abortInFlight;
