const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-filter-runtime-'));
const databasePath = path.join(temporaryDirectory, 'filter-runtime.db');
const adminKey = crypto.randomBytes(32).toString('base64url');

process.env.ADMIN_SECRET_KEY = adminKey;
process.env.DATABASE_PATH = databasePath;
process.env.LLMWARD_PROVIDER_TIMEOUT_MS = '3000';
process.env.LOG_LEVEL = 'silent';

let gatewayServer;
let providerServer;
let baseUrl;
let providerBaseUrl;
let db;
let applicationLogger;
let contentFilters;
let originalApplyOutputFilters;
let usageService;
let originalRecordFailure;
let originalReleaseReservation;
let providerCalls;
let receivedPayloads;
let providerEvents;
let releaseHeldProvider;
let primaryModelId;
let secondaryModelId;
let heldModelId;
let primaryUser;
let restrictedUser;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request(route, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let body = null;
  try { body = await response.json(); } catch {}
  return { status: response.status, body, headers: response.headers };
}

function admin(route, options = {}) {
  return request(route, {
    ...options,
    headers: { 'X-Admin-Key': adminKey, ...(options.headers || {}) }
  });
}

function chat(token, body) {
  return request('/v1/chat/completions', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body
  });
}

async function createUser(username, allowedModels) {
  const response = await admin('/admin/users', {
    method: 'POST',
    body: {
      username,
      max_daily_input_tokens: 10_000_000,
      max_daily_output_tokens: 1_000,
      allowed_models: allowedModels
    }
  });
  assert.equal(response.status, 201);
  return { id: response.body.userId, token: response.body.apiToken };
}

function addFilter({
  name = crypto.randomUUID(),
  patterns = ['secret'],
  serializedPatterns,
  inputAction = null,
  outputAction = null,
  active = true,
  global = false,
  modelIds = []
}) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO content_filters
      (name, patterns, input_action, output_action, is_active, is_global, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    serializedPatterns === undefined ? JSON.stringify(patterns) : serializedPatterns,
    inputAction,
    outputAction,
    active ? 1 : 0,
    global ? 1 : 0,
    now,
    now
  );
  const filterId = Number(result.lastInsertRowid);
  const assign = db.prepare('INSERT INTO content_filter_models (filter_id, model_id) VALUES (?, ?)');
  for (const modelId of modelIds) assign.run(filterId, modelId);
  return filterId;
}

function requestLogs() {
  return db.prepare(`
    SELECT status, error_type, input_tokens, output_tokens, total_tokens
    FROM request_logs ORDER BY id
  `).all();
}

before(async () => {
  providerServer = http.createServer(async (req, res) => {
    if (req.url !== '/chat/completions' || req.method !== 'POST') {
      res.writeHead(404);
      return res.end();
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    providerCalls += 1;
    receivedPayloads.push(payload);

    if (payload.force_provider_error === true) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'private upstream failure' }));
    }

    if (payload.model === 'runtime-held') {
      const gate = new Promise((resolve) => { releaseHeldProvider = resolve; });
      providerEvents.emit('held');
      await gate;
    }

    if (payload.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      return res.end('data: {"choices":[{"delta":{"content":"raw-secret"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
    }

    const body = {
      id: 'runtime-response',
      model: payload.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Output Secret and New Secret',
          tool_calls: [{ function: { name: 'keep', arguments: 'Output Secret' } }],
          vendor_message: 'Output Secret'
        },
        finish_reason: 'stop',
        vendor_choice: 'Output Secret'
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      vendor_response: 'Output Secret'
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await listen(providerServer);
  providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;

  const app = require('../app');
  applicationLogger = require('../logger');
  db = require('../db/database');
  contentFilters = require('../services/content-filters');
  originalApplyOutputFilters = contentFilters.applyOutputFilters;
  usageService = require('../services/usage');
  originalRecordFailure = usageService.recordFailure;
  originalReleaseReservation = usageService.releaseReservation;
  gatewayServer = http.createServer(app);
  await listen(gatewayServer);
  baseUrl = `http://127.0.0.1:${gatewayServer.address().port}`;

  const provider = await admin('/admin/providers', {
    method: 'POST',
    body: {
      provider_name: 'filter-runtime-provider',
      display_name: 'Filter runtime provider',
      base_url: providerBaseUrl,
      auth_type: 'none'
    }
  });
  assert.equal(provider.status, 201);

  for (const name of ['runtime-primary', 'runtime-secondary', 'runtime-held']) {
    const model = await admin('/admin/models', {
      method: 'POST',
      body: {
        model_name: name,
        display_name: name,
        provider_id: provider.body.id,
        max_tokens: 6,
        input_cost_per_million: 2,
        output_cost_per_million: 4
      }
    });
    assert.equal(model.status, 201);
  }
  const models = await admin('/admin/models');
  primaryModelId = models.body.find((model) => model.model_name === 'runtime-primary').id;
  secondaryModelId = models.body.find((model) => model.model_name === 'runtime-secondary').id;
  heldModelId = models.body.find((model) => model.model_name === 'runtime-held').id;
  primaryUser = await createUser('filter-runtime-primary', []);
  restrictedUser = await createUser('filter-runtime-restricted', ['runtime-primary']);
});

beforeEach(() => {
  if (!db) return;
  contentFilters.applyOutputFilters = originalApplyOutputFilters;
  usageService.recordFailure = originalRecordFailure;
  usageService.releaseReservation = originalReleaseReservation;
  db.exec(`
    DELETE FROM content_filter_models;
    DELETE FROM content_filters;
    DELETE FROM quota_reservations;
    DELETE FROM usage_logs;
    DELETE FROM request_logs;
  `);
  providerCalls = 0;
  receivedPayloads = [];
  providerEvents = new EventEmitter();
  releaseHeldProvider = null;
});

after(async () => {
  if (contentFilters) contentFilters.applyOutputFilters = originalApplyOutputFilters;
  if (usageService) {
    usageService.recordFailure = originalRecordFailure;
    usageService.releaseReservation = originalReleaseReservation;
  }
  if (releaseHeldProvider) releaseHeldProvider();
  await close(gatewayServer);
  await close(providerServer);
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('authentication and model authorization run before a corrupt filter snapshot is read', async () => {
  addFilter({
    serializedPatterns: '{corrupt',
    inputAction: 'mask',
    active: true,
    global: true
  });

  const unauthenticated = await chat(null, {
    model: 'runtime-primary', messages: [{ role: 'user', content: 'secret' }]
  });
  const forbidden = await chat(restrictedUser.token, {
    model: 'runtime-secondary', messages: [{ role: 'user', content: 'secret' }]
  });

  assert.equal(unauthenticated.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(providerCalls, 0);
  assert.deepEqual(requestLogs(), []);
});

test('active global and current-model filters form one snapshot while inactive and unassigned filters do nothing', async () => {
  addFilter({ patterns: ['Global Secret'], inputAction: 'mask', global: true });
  addFilter({ patterns: ['Scoped Secret'], inputAction: 'mask', modelIds: [primaryModelId] });
  addFilter({ patterns: ['Inactive Secret'], inputAction: 'mask', active: false, global: true });
  addFilter({ patterns: ['No Scope Secret'], inputAction: 'mask' });
  addFilter({ patterns: ['Other Secret'], inputAction: 'mask', modelIds: [secondaryModelId] });

  const response = await chat(primaryUser.token, {
    model: 'runtime-primary',
    messages: [{
      role: 'user',
      content: 'Global Secret / Scoped Secret / Inactive Secret / No Scope Secret / Other Secret'
    }]
  });

  assert.equal(response.status, 200);
  assert.equal(receivedPayloads.length, 1);
  assert.equal(
    receivedPayloads[0].messages[0].content,
    '[FILTERED] / [FILTERED] / Inactive Secret / No Scope Secret / Other Secret'
  );
});

test('input blocking examines the original text before masking and records one zero-token filter failure', async (t) => {
  addFilter({ patterns: ['blocked secret'], inputAction: 'mask', global: true });
  addFilter({
    name: 'Runtime input policy', patterns: ['blocked secret'], inputAction: 'block', global: true
  });
  const applicationLogs = [];
  const captureLog = (info) => applicationLogs.push(info[Symbol.for('message')] ?? JSON.stringify(info));
  applicationLogger.on('data', captureLog);
  t.after(() => applicationLogger.off('data', captureLog));

  const response = await chat(primaryUser.token, {
    model: 'runtime-primary', messages: [{ role: 'user', content: 'BLOCKED SECRET' }]
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'content_filtered');
  assert.equal(response.body.filter_name, 'Runtime input policy');
  const serializedResponse = JSON.stringify(response.body).toLowerCase();
  assert.equal(serializedResponse.includes('blocked secret'), false);
  assert.equal(providerCalls, 0);
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'filter', input_tokens: 0, output_tokens: 0, total_tokens: 0
  }]);
  const serializedPersistedLogs = JSON.stringify({
    request: db.prepare('SELECT * FROM request_logs ORDER BY id').all(),
    audit: db.prepare('SELECT * FROM audit_logs ORDER BY id').all()
  }).toLowerCase();
  const serializedApplicationLogs = applicationLogs.join('\n').toLowerCase();
  for (const sensitive of ['runtime input policy', 'blocked secret']) {
    assert.equal(serializedPersistedLogs.includes(sensitive), false);
    assert.equal(serializedApplicationLogs.includes(sensitive), false);
  }
  assert.equal(db.prepare('SELECT COUNT(*) FROM usage_logs').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM quota_reservations').pluck().get(), 0);
});

test('non-400 content filter errors do not disclose policy names', async (t) => {
  const originalApplyInputFilters = contentFilters.applyInputFilters;
  contentFilters.applyInputFilters = () => {
    const error = new Error('Private filter failure');
    error.status = 500;
    error.code = 'content_filtered';
    error.filterName = 'Must not be disclosed';
    throw error;
  };
  t.after(() => { contentFilters.applyInputFilters = originalApplyInputFilters; });

  const response = await chat(primaryUser.token, {
    model: 'runtime-primary', messages: [{ role: 'user', content: 'safe' }]
  });

  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'Internal server error');
  assert.equal(response.body.code, 'content_filtered');
  assert.equal(Object.hasOwn(response.body, 'filter_name'), false);
  assert.equal(providerCalls, 0);
});

test('input masking changes only message text and preserves request extensions while max_tokens is clamped', async () => {
  addFilter({ patterns: ['Input Secret'], inputAction: 'mask', global: true });
  const body = {
    model: 'runtime-primary',
    stream: false,
    max_tokens: 99,
    messages: [
      { role: 'user', content: 'Input Secret' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'INPUT SECRET' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' }, text: 'Input Secret' }
        ],
        tool_calls: [{ function: { arguments: 'Input Secret' } }]
      }
    ],
    tools: [{ function: { name: 'keep', description: 'Input Secret' } }],
    vendor_request: { content: 'Input Secret' }
  };

  const response = await chat(primaryUser.token, body);
  assert.equal(response.status, 200);
  const payload = receivedPayloads[0];
  assert.equal(payload.model, body.model);
  assert.equal(payload.stream, false);
  assert.equal(payload.max_tokens, 6);
  assert.equal(payload.messages[0].content, '[FILTERED]');
  assert.equal(payload.messages[1].content[0].text, '[FILTERED]');
  assert.equal(payload.messages[1].content[1].text, 'Input Secret');
  assert.equal(payload.messages[1].tool_calls[0].function.arguments, 'Input Secret');
  assert.equal(payload.tools[0].function.description, 'Input Secret');
  assert.deepEqual(payload.vendor_request, body.vendor_request);
  assert.equal(body.messages[0].content, 'Input Secret');
});

test('expanded masked payloads over 1 MiB fail before provider dispatch and release the reservation once', async () => {
  addFilter({ patterns: ['a'], inputAction: 'mask', global: true });
  const response = await chat(primaryUser.token, {
    model: 'runtime-primary', messages: [{ role: 'user', content: 'a'.repeat(150_000) }]
  });

  assert.equal(response.status, 413);
  assert.equal(response.body.code, 'request_too_large');
  assert.equal(providerCalls, 0);
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'filter', input_tokens: 0, output_tokens: 0, total_tokens: 0
  }]);
  assert.equal(db.prepare('SELECT COUNT(*) FROM quota_reservations').pluck().get(), 0);
});

test('corrupt active configuration fails closed before provider dispatch without revealing filter data', async () => {
  addFilter({
    name: 'private-filter-name',
    serializedPatterns: '["private-pattern",',
    inputAction: 'mask',
    global: true
  });

  const response = await chat(primaryUser.token, {
    model: 'runtime-primary', messages: [{ role: 'user', content: 'private-pattern' }]
  });

  assert.equal(response.status, 500);
  assert.equal(response.body.code, 'filter_configuration_invalid');
  assert.equal(JSON.stringify(response.body).includes('private'), false);
  assert.equal(providerCalls, 0);
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'filter', input_tokens: 0, output_tokens: 0, total_tokens: 0
  }]);
});

test('non-stream output masking changes content only and preserves usage, tool calls, and vendor fields', async () => {
  addFilter({ patterns: ['Output Secret'], outputAction: 'mask', global: true });

  const response = await chat(primaryUser.token, {
    model: 'runtime-primary', messages: [{ role: 'user', content: 'ordinary' }]
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.choices[0].message.content, '[FILTERED] and New Secret');
  assert.equal(response.body.choices[0].message.tool_calls[0].function.arguments, 'Output Secret');
  assert.equal(response.body.choices[0].message.vendor_message, 'Output Secret');
  assert.equal(response.body.choices[0].vendor_choice, 'Output Secret');
  assert.equal(response.body.vendor_response, 'Output Secret');
  assert.deepEqual(response.body.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.deepEqual(requestLogs(), [{
    status: 'success', error_type: null, input_tokens: 3, output_tokens: 2, total_tokens: 5
  }]);
});

test('output filtering failure charges provider usage and records exactly one generic filter failure', async () => {
  addFilter({ patterns: ['Output Secret'], outputAction: 'mask', global: true });
  contentFilters.applyOutputFilters = () => {
    throw new Error('private provider output marker');
  };

  const response = await chat(primaryUser.token, {
    model: 'runtime-primary', messages: [{ role: 'user', content: 'ordinary' }]
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'filter_processing_failed');
  assert.equal(JSON.stringify(response.body).includes('private'), false);
  assert.equal(providerCalls, 1);
  assert.deepEqual(db.prepare(`
    SELECT input_tokens, output_tokens, total_tokens FROM usage_logs WHERE user_id = ?
  `).get(primaryUser.id), { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'filter', input_tokens: 3, output_tokens: 2, total_tokens: 5
  }]);
  assert.equal(db.prepare('SELECT COUNT(*) FROM quota_reservations').pluck().get(), 0);
});

test('finally retries reservation cleanup when failure logging and the first release both fail', async () => {
  let releaseAttempts = 0;
  usageService.recordFailure = () => {
    throw new Error('injected record failure');
  };
  usageService.releaseReservation = (requestId) => {
    releaseAttempts += 1;
    if (releaseAttempts === 1) throw new Error('injected first release failure');
    return originalReleaseReservation(requestId);
  };

  const response = await chat(primaryUser.token, {
    model: 'runtime-primary',
    force_provider_error: true,
    messages: [{ role: 'user', content: 'ordinary' }]
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'provider_http_error');
  assert.equal(releaseAttempts, 2);
  assert.deepEqual(requestLogs(), []);
  assert.equal(db.prepare('SELECT COUNT(*) FROM quota_reservations').pluck().get(), 0);
});

test('one immutable snapshot is reused after a held provider response', async () => {
  const filterId = addFilter({ patterns: ['Output Secret'], outputAction: 'mask', modelIds: [heldModelId] });
  const held = once(providerEvents, 'held');
  const responsePromise = chat(primaryUser.token, {
    model: 'runtime-held', messages: [{ role: 'user', content: 'ordinary' }]
  });
  await held;
  db.prepare('UPDATE content_filters SET patterns = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(['New Secret']), new Date().toISOString(), filterId
  );
  releaseHeldProvider();

  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(response.body.choices[0].message.content, '[FILTERED] and New Secret');
});

test('streaming without an output filter retains the existing byte-transparent relay', async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${primaryUser.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'runtime-primary', stream: true, messages: [{ role: 'user', content: 'ordinary' }]
    })
  });
  assert.equal(response.status, 200);
  assert.equal(
    await response.text(),
    'data: {"choices":[{"delta":{"content":"raw-secret"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'
  );
});
