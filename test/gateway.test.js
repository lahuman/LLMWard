const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-gateway-test-'));
const databasePath = path.join(temporaryDirectory, 'gateway.test.db');
const adminKey = process.env.TEST_ADMIN_SECRET_KEY || crypto.randomBytes(32).toString('base64url');
const providerKey = process.env.TEST_PROVIDER_API_KEY || crypto.randomBytes(24).toString('base64url');

process.env.ADMIN_SECRET_KEY = adminKey;
process.env.DATABASE_PATH = databasePath;
process.env.KERNEXA_TIMEOUT = '3000';
process.env.LOG_LEVEL = 'silent';

let gatewayServer;
let providerServer;
let baseUrl;
let providerBaseUrl;
let db;
let providerId;
let inactiveProviderId;
const providerCalls = new Map();
const receivedMaximums = new Map();
const receivedPayloads = new Map();
const providerPaths = [];
const providerEvents = new EventEmitter();
let upstreamDisconnects = 0;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
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
  return request(route, { ...options, headers: { 'X-Admin-Key': adminKey, ...(options.headers || {}) } });
}

async function createUser(username, models, inputQuota = 100, outputQuota = 100) {
  const response = await admin('/admin/users', {
    method: 'POST',
    body: {
      username,
      max_daily_input_tokens: inputQuota,
      max_daily_output_tokens: outputQuota,
      allowed_models: models
    }
  });
  assert.equal(response.status, 201);
  assert.equal(typeof response.body.apiToken, 'string');
  return { id: response.body.userId, token: response.body.apiToken };
}

function chat(token, model, maxTokens) {
  const body = { model, messages: [{ role: 'user', content: 'test' }] };
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  return request('/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body
  });
}

function unsafeProviderBaseUrls() {
  return [
    `${providerBaseUrl}?mode=unsafe`,
    `${providerBaseUrl}#fragment`,
    `${providerBaseUrl}?`,
    `${providerBaseUrl}#`,
    `${providerBaseUrl}/../escape`,
    `${providerBaseUrl}/%2e%2e/escape`,
    `${providerBaseUrl}/openai\\v1`,
    `${providerBaseUrl}/a/%2e%2e\\escape`,
    `${providerBaseUrl}/a/.%2e/escape`,
    `${providerBaseUrl}/a/%2e./escape`,
    `${providerBaseUrl}/openai%2fv1`,
    `${providerBaseUrl}/openai%5cv1`,
    `${providerBaseUrl}/openai/%252e/v1`,
    `${providerBaseUrl}/openai%252fv1`,
    `${providerBaseUrl}/openai%255cv1`
  ];
}

before(async () => {
  providerServer = http.createServer(async (req, res) => {
    providerPaths.push(req.url);
    if (req.url === '/redirect/models' || req.url === '/redirect/chat/completions') {
      res.writeHead(302, { Location: req.url.endsWith('/models') ? '/models' : '/chat/completions' });
      return res.end();
    }
    if (req.url === '/models' || req.url === '/openai/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'discovered-model' }, { id: 'standard' }] }));
    }
    if ((req.url !== '/chat/completions' && req.url !== '/openai/v1/chat/completions') || req.method !== 'POST') {
      res.writeHead(404); return res.end();
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    receivedPayloads.set(payload.model, payload);
    providerCalls.set(payload.model, (providerCalls.get(payload.model) || 0) + 1);
    const maximums = receivedMaximums.get(payload.model) || [];
    maximums.push(payload.max_tokens);
    receivedMaximums.set(payload.model, maximums);
    if (payload.model === 'provider-fail') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ secret: 'provider-response-must-not-be-stored' }));
    }
    if (payload.model === 'backpressure') {
      res.once('close', () => {
        if (!res.writableEnded) upstreamDisconnects += 1;
        providerEvents.emit('backpressure:closed');
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      providerEvents.emit('backpressure:started');
      const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(64 * 1024) } }] })}\n\n`;
      while (!res.destroyed && !res.writableEnded) {
        if (!res.write(chunk)) {
          await new Promise((resolve) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.once('drain', done);
            res.once('close', done);
          });
        }
      }
      return;
    }
    if (payload.model === 'abort-in-flight') {
      res.once('close', () => {
        if (!res.writableEnded) upstreamDisconnects += 1;
        providerEvents.emit('abort-in-flight:closed');
      });
      providerEvents.emit('abort-in-flight:started');
      return;
    }
    if (payload.model === 'concurrent' || payload.model.includes('concurrency') || payload.model === 'disconnect') {
      if (payload.model === 'disconnect') {
        res.once('close', () => { if (!res.writableEnded) upstreamDisconnects += 1; });
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const promptTokens = payload.model === 'input-limit' ? 2 : 1;
    const completionTokens = payload.model === 'concurrent' ? payload.max_tokens :
      payload.model === 'output-limit' ? 2 : 1;
    const body = {
      id: 'mock-response', model: payload.model,
      choices: [{ index: 0, message: { role: 'assistant', content: payload.model === 'privacy' ? 'private-response-marker' : 'ok' } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
    };
    if (payload.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'stream', choices: [{ delta: { tool_calls: [{ id: 'call-1' }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'stream', choices: [], usage: body.usage })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await listen(providerServer);
  providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;

  const app = require('../app');
  db = require('../db/database');
  gatewayServer = http.createServer(app);
  await listen(gatewayServer);
  baseUrl = `http://127.0.0.1:${gatewayServer.address().port}`;

  const provider = await admin('/admin/providers', {
    method: 'POST',
    body: { provider_name: 'mock', display_name: 'Mock Provider', base_url: providerBaseUrl, auth_type: 'api_key', stored_api_key: providerKey }
  });
  assert.equal(provider.status, 201);
  providerId = provider.body.id;
  for (const [name, maxTokens] of [['standard', 8], ['input-limit', 4], ['output-limit', 2], ['concurrent', 4], ['atomic-fail', 2], ['unpriced', 4], ['inactive-model', 4], ['streaming', 4], ['backpressure', 4], ['abort-in-flight', 4], ['user-concurrency', 4], ['model-concurrency', 4], ['disconnect', 4], ['privacy', 4]]) {
    const model = await admin('/admin/models', {
      method: 'POST', body: { model_name: name, display_name: name, provider_id: providerId, max_tokens: maxTokens }
    });
    assert.equal(model.status, 201);
  }
  for (const name of ['priced', 'provider-fail']) {
    const model = await admin('/admin/models', {
      method: 'POST',
      body: {
        model_name: name, display_name: name, provider_id: providerId, max_tokens: 4,
        input_cost_per_million: 2, output_cost_per_million: 4
      }
    });
    assert.equal(model.status, 201);
  }
  const inactiveModel = (await admin('/admin/models')).body.find((model) => model.model_name === 'inactive-model');
  assert.equal((await admin(`/admin/models/${inactiveModel.id}`, { method: 'PUT', body: { is_active: false } })).status, 200);

  const inactiveProvider = await admin('/admin/providers', {
    method: 'POST',
    body: { provider_name: 'inactive', display_name: 'Inactive Provider', base_url: providerBaseUrl, auth_type: 'none' }
  });
  assert.equal(inactiveProvider.status, 201);
  inactiveProviderId = inactiveProvider.body.id;
  assert.equal((await admin('/admin/models', {
    method: 'POST', body: { model_name: 'inactive-provider-model', display_name: 'inactive-provider-model', provider_id: inactiveProviderId, max_tokens: 4 }
  })).status, 201);
  assert.equal((await admin(`/admin/providers/${inactiveProviderId}`, { method: 'PUT', body: { is_active: false } })).status, 200);
});

after(async () => {
  await close(gatewayServer);
  await close(providerServer);
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('security headers and no-store protect browser and admin responses', async () => {
  const health = await request('/health');
  const dashboard = await request('/admin/');
  const uppercaseDashboard = await request('/ADMIN/');
  const directDashboard = await request('/admin-dashboard.html');
  const queriedDirectDashboard = await request('/admin-dashboard.html?x=1');
  const users = await admin('/admin/users');
  const uppercaseUsers = await admin('/ADMIN/users');
  const queriedUsers = await admin('/admin/users?x=1');
  const stylesheet = await request('/admin-dashboard.css');
  const script = await request('/admin-dashboard.js');
  const responses = [health, dashboard, uppercaseDashboard, directDashboard, queriedDirectDashboard, users, uppercaseUsers, queriedUsers, stylesheet, script];
  for (const response of responses) {
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('content-security-policy'), [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'"
    ].join('; '));
  }
  for (const response of [dashboard, uppercaseDashboard, directDashboard, queriedDirectDashboard, users, uppercaseUsers, queriedUsers]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const response of [dashboard, uppercaseDashboard, directDashboard, queriedDirectDashboard]) {
    assert.match(response.headers.get('content-type') || '', /^text\/html\b/);
  }
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get('content-type') || '', /^text\/css\b/);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') || '', /^(?:application|text)\/javascript\b/);
});

test('health check and admin authentication', async () => {
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/v1/models')).status, 401);
  assert.equal((await request('/admin/users')).status, 401);
  assert.equal((await request('/admin/users', { headers: { 'X-Admin-Key': crypto.randomBytes(32).toString('hex') } })).status, 403);
  assert.equal((await admin('/admin/users')).status, 200);
});

test('weak and placeholder admin keys are rejected', () => {
  const { validateAdminKey, validateCorsOrigin } = require('../config');
  assert.throws(() => validateAdminKey('short'));
  assert.throws(() => validateAdminKey('CHANGE_ME_TO_A_LONG_EXAMPLE_PLACEHOLDER_VALUE'));
  assert.throws(() => validateAdminKey('<generate-a-unique-random-value-of-at-least-32-characters>'));
  assert.throws(() => validateAdminKey('a'.repeat(40)));
  assert.throws(() => validateCorsOrigin('*'));
  assert.throws(() => validateCorsOrigin('https://user:password@example.test'));
  assert.equal(validateCorsOrigin('https://gateway.example.test'), 'https://gateway.example.test');
});

test('user creation authenticates and user lists never disclose tokens', async () => {
  const user = await createUser('authentication-user', []);
  const models = await request('/v1/models', { headers: { Authorization: `Bearer ${user.token}` } });
  assert.equal(models.status, 200);
  assert.ok(models.body.some((model) => model.id === 'standard'));
  assert.equal((await chat(user.token, 'standard', 999999)).status, 200);
  assert.equal(receivedMaximums.get('standard').at(-1), 8);
  const users = await admin('/admin/users');
  assert.equal(users.status, 200);
  assert.equal(JSON.stringify(users.body).includes(user.token), false);
  assert.equal(Object.hasOwn(users.body[0], 'api_token'), false);
});

test('successful admin audits keep only fixed supported field names', async () => {
  const user = await createUser('audit-success-user', ['standard']);
  const marker = `prompt_${crypto.randomBytes(12).toString('hex')}`;
  const response = await admin(`/admin/users/${user.id}`, {
    method: 'PUT',
    body: { max_daily_input_tokens: 321, [marker]: 'ignored' }
  });
  assert.equal(response.status, 200);

  const row = db.prepare(`
    SELECT target_id, changed_fields FROM audit_logs
    WHERE action = 'user.update' AND target_id = ? ORDER BY id DESC LIMIT 1
  `).get(String(user.id));
  const fields = JSON.parse(row.changed_fields);
  assert.equal(fields.includes(marker), false);
  assert.equal(fields.length, 1);
  assert.equal(fields[0], 'max_daily_input_tokens');
  assert.equal(row.target_id, String(user.id));
});

test('failed admin audits discard request field names and malformed target IDs', async () => {
  const fieldMarker = `secret_${crypto.randomBytes(12).toString('hex')}`;
  const routeMarker = `invalid-${crypto.randomBytes(12).toString('hex')}`;
  const previousId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs').get().id;
  const response = await admin(`/admin/users/${routeMarker}`, {
    method: 'PUT', body: { [fieldMarker]: 'ignored' }
  });
  assert.equal(response.status, 400);

  const row = db.prepare(`
    SELECT target_id, changed_fields FROM audit_logs
    WHERE id > ? AND success = 0 ORDER BY id DESC LIMIT 1
  `).get(previousId);
  assert.ok(row);
  const serialized = JSON.stringify(row);
  assert.equal(serialized.includes(fieldMarker), false);
  assert.equal(serialized.includes(routeMarker), false);
  assert.equal(row.target_id, null);
  assert.deepEqual(JSON.parse(row.changed_fields), []);
});

test('failed admin audits retain canonical target IDs', async () => {
  const user = await createUser('audit-failure-user', ['standard']);
  const marker = `secret_${crypto.randomBytes(12).toString('hex')}`;
  const previousId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs').get().id;
  const response = await admin(`/admin/users/${user.id}`, {
    method: 'PUT', body: { [marker]: 'ignored' }
  });
  assert.equal(response.status, 400);

  const row = db.prepare(`
    SELECT target_id, changed_fields FROM audit_logs
    WHERE id > ? AND success = 0 ORDER BY id DESC LIMIT 1
  `).get(previousId);
  assert.ok(row);
  assert.equal(row.changed_fields.includes(marker), false);
  assert.equal(row.target_id, String(user.id));
  assert.deepEqual(JSON.parse(row.changed_fields), []);
});

test('unknown admin mutation failures use fixed audit metadata', async () => {
  for (const method of ['POST', 'PUT']) {
    const routeMarker = `private-${crypto.randomBytes(12).toString('hex')}`;
    const bodyMarker = `private-${crypto.randomBytes(12).toString('hex')}`;
    const previousId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs').get().id;

    const response = await admin(`/admin/${routeMarker}`, { method, body: [bodyMarker] });

    assert.equal(response.status, 400);
    const row = db.prepare(`
      SELECT action, target_type, target_id, changed_fields FROM audit_logs
      WHERE id > ? AND success = 0 ORDER BY id DESC LIMIT 1
    `).get(previousId);
    assert.ok(row);
    const serialized = JSON.stringify(row);
    assert.equal(serialized.includes(routeMarker), false);
    assert.equal(serialized.includes(bodyMarker), false);
    assert.deepEqual(row, {
      action: 'admin.change', target_type: 'admin', target_id: null, changed_fields: '[]'
    });
  }
});

test('failed admin audits classify case-insensitive known families', async () => {
  const user = await createUser('audit-case-user', ['standard']);
  const marker = `private-${crypto.randomBytes(12).toString('hex')}`;
  const previousId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs').get().id;

  const response = await admin(`/admin/USERS/${user.id}`, {
    method: 'PUT', body: { [marker]: 'ignored' }
  });

  assert.equal(response.status, 400);
  const row = db.prepare(`
    SELECT action, target_type, target_id, changed_fields FROM audit_logs
    WHERE id > ? AND success = 0 ORDER BY id DESC LIMIT 1
  `).get(previousId);
  assert.ok(row);
  assert.equal(JSON.stringify(row).includes(marker), false);
  assert.deepEqual(row, {
    action: 'user.change',
    target_type: 'user',
    target_id: String(user.id),
    changed_fields: '[]'
  });
});

test('token rotation invalidates the old token immediately', async () => {
  const user = await createUser('rotation-user', ['standard']);
  const rotated = await admin(`/admin/users/${user.id}/rotate-token`, { method: 'POST' });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.apiToken, user.token);
  assert.equal((await request('/v1/models', { headers: { Authorization: `Bearer ${user.token}` } })).status, 401);
  assert.equal((await request('/v1/models', { headers: { Authorization: `Bearer ${rotated.body.apiToken}` } })).status, 200);
});

test('model authorization rejects unknown, unauthorized, and corrupt permissions before provider calls', async () => {
  const user = await createUser('restricted-user', ['standard']);
  const unknownBefore = providerCalls.get('not-registered') || 0;
  assert.equal((await chat(user.token, 'not-registered', 1)).status, 400);
  assert.equal(providerCalls.get('not-registered') || 0, unknownBefore);
  assert.equal((await chat(user.token, 'input-limit', 1)).status, 403);
  assert.equal(providerCalls.get('input-limit') || 0, 0);

  db.prepare('UPDATE users SET allowed_models = ? WHERE id = ?').run('{broken', user.id);
  assert.equal((await request('/v1/models', { headers: { Authorization: `Bearer ${user.token}` } })).status, 403);
  const standardBefore = providerCalls.get('standard') || 0;
  assert.equal((await chat(user.token, 'standard', 1)).status, 403);
  assert.equal(providerCalls.get('standard') || 0, standardBefore);
  db.prepare('UPDATE users SET allowed_models = ? WHERE id = ?').run('', user.id);
  assert.equal((await chat(user.token, 'standard', 1)).status, 403);
  assert.equal(providerCalls.get('standard') || 0, standardBefore);
  db.prepare('UPDATE users SET allowed_models = ? WHERE id = ?').run(JSON.stringify(['standard', 'missing']), user.id);
  assert.equal((await chat(user.token, 'standard', 1)).status, 403);
  assert.equal(providerCalls.get('standard') || 0, standardBefore);
});

test('inactive models and providers are rejected before provider calls', async () => {
  const user = await createUser('inactive-access-user', ['inactive-model', 'inactive-provider-model']);
  const modelCalls = providerCalls.get('inactive-model') || 0;
  const providerModelCalls = providerCalls.get('inactive-provider-model') || 0;
  assert.equal((await chat(user.token, 'inactive-model', 1)).status, 400);
  assert.equal((await chat(user.token, 'inactive-provider-model', 1)).status, 400);
  assert.equal(providerCalls.get('inactive-model') || 0, modelCalls);
  assert.equal(providerCalls.get('inactive-provider-model') || 0, providerModelCalls);
});

test('model identifiers can be renamed without breaking explicit user access', async () => {
  const created = await admin('/admin/models', {
    method: 'POST', body: { model_name: 'rename-source', display_name: 'Rename', provider_id: providerId, max_tokens: 2 }
  });
  assert.equal(created.status, 201);
  const user = await createUser('rename-user', ['rename-source']);
  const renamed = await admin(`/admin/models/${created.body.id}`, {
    method: 'PUT', body: { model_name: 'rename-target' }
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.model_name, 'rename-target');
  const storedUser = (await admin('/admin/users')).body.find((item) => item.id === user.id);
  assert.deepEqual(storedUser.allowed_models, ['rename-target']);
  assert.equal((await chat(user.token, 'rename-source', 1)).status, 400);
  assert.equal((await chat(user.token, 'rename-target', 1)).status, 200);
});

test('input quota is enforced after exact provider usage is recorded', async () => {
  const user = await createUser('input-quota-user', ['input-limit'], 2, 10);
  assert.equal((await chat(user.token, 'input-limit', 1)).status, 200);
  assert.equal((await chat(user.token, 'input-limit', 1)).status, 429);
  assert.equal(providerCalls.get('input-limit'), 1);
});

test('output quota is enforced', async () => {
  const user = await createUser('output-quota-user', ['output-limit'], 10, 2);
  assert.equal((await chat(user.token, 'output-limit', 2)).status, 200);
  assert.equal((await chat(user.token, 'output-limit', 1)).status, 429);
  assert.equal(providerCalls.get('output-limit'), 1);
});

test('concurrent requests cannot oversubscribe output quota', async () => {
  const user = await createUser('concurrent-user', ['concurrent'], 20, 5);
  const responses = await Promise.all([chat(user.token, 'concurrent', 4), chat(user.token, 'concurrent', 4)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200]);
  assert.deepEqual(receivedMaximums.get('concurrent').slice().sort((a, b) => a - b), [1, 4]);
  const usage = await request('/dashboard/usage', { headers: { Authorization: `Bearer ${user.token}` } });
  assert.equal(usage.body.outputTokens, 5);
  assert.equal(usage.body.remainingOutput, 0);
  assert.equal((await chat(user.token, 'concurrent', 1)).status, 429);
});

test('recordUsage applies tokens to the reservation UTC date', async () => {
  const user = await createUser('reservation-date-user', ['standard']);
  const model = db.prepare("SELECT * FROM models WHERE model_name = 'standard'").get();
  const { reserveQuota, recordUsage } = require('../services/usage');
  const reservation = reserveQuota(
    db.prepare('SELECT * FROM users WHERE id = ?').get(user.id),
    2,
    model.max_tokens
  );
  const reservedDate = '2001-02-03';
  db.prepare('UPDATE quota_reservations SET request_date = ? WHERE request_id = ?')
    .run(reservedDate, reservation.requestId);
  recordUsage(reservation.requestId, user.id, model, 2, 1, 5);
  const fixed = db.prepare('SELECT * FROM usage_logs WHERE user_id = ? AND request_date = ?')
    .get(user.id, reservedDate);
  assert.equal(fixed.input_tokens, 2);
  assert.equal(fixed.output_tokens, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM quota_reservations WHERE request_id = ?')
    .get(reservation.requestId).count, 0);
});

test('usage summary and request log are atomic', async () => {
  const user = await createUser('atomic-user', ['atomic-fail'], 20, 20);
  db.exec(`
    CREATE TRIGGER fail_atomic_request_log
    BEFORE INSERT ON request_logs
    WHEN NEW.model_name = 'atomic-fail'
    BEGIN SELECT RAISE(ABORT, 'forced test failure'); END;
  `);
  const response = await chat(user.token, 'atomic-fail', 1);
  assert.equal(response.status, 500);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_logs WHERE user_id = ?').get(user.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM request_logs WHERE user_id = ?').get(user.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM quota_reservations WHERE user_id = ?').get(user.id).count, 0);
  db.exec('DROP TRIGGER fail_atomic_request_log');
});

test('provider credentials are never disclosed by admin responses', async () => {
  const providers = await admin('/admin/providers');
  const provider = providers.body.find((item) => item.id === providerId);
  assert.equal(provider.hasApiKey, true);
  const serialized = JSON.stringify(providers.body);
  assert.equal(serialized.includes(providerKey), false);
  assert.equal(serialized.includes('stored_api_key'), false);
  assert.equal(serialized.includes('api_key_env_name'), false);
});

test('provider authentication modes and environment credential precedence are applied', () => {
  const { getAuthHeaders } = require('../services/provider-router');
  process.env.LLM_GATEWAY_TEST_ONLY_KEY = 'environment-key';
  try {
    assert.equal(getAuthHeaders({ auth_type: 'none', stored_api_key: 'stored' }).Authorization, undefined);
    const apiKey = getAuthHeaders({
      auth_type: 'api_key', api_key_env_name: 'LLM_GATEWAY_TEST_ONLY_KEY', stored_api_key: 'stored'
    });
    assert.equal(apiKey.Authorization, 'Bearer environment-key');
    const bearer = getAuthHeaders({ auth_type: 'bearer_token', stored_api_key: 'stored' });
    assert.equal(bearer.Authorization, 'Bearer stored');
  } finally {
    delete process.env.LLM_GATEWAY_TEST_ONLY_KEY;
  }
});

test('provider connection status stores a UTC timestamp and response time', async () => {
  const result = await admin(`/admin/providers/${providerId}/test`, { method: 'POST' });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'healthy');
  assert.ok(Number.isSafeInteger(result.body.latency_ms));
  const providers = await admin('/admin/providers');
  const provider = providers.body.find((item) => item.id === providerId);
  assert.equal(provider.health_status, 'healthy');
  assert.ok(Number.isSafeInteger(provider.last_health_latency_ms));
  assert.match(provider.last_health_check, /^\d{4}-\d{2}-\d{2}T/);
});

test('statistics include failures, response times, groupings, and immutable price snapshots', async () => {
  const pricedUser = await createUser('priced-stats-user', ['priced', 'provider-fail'], 100, 100);
  assert.equal((await chat(pricedUser.token, 'priced', 2)).status, 200);
  assert.equal((await chat(pricedUser.token, 'provider-fail', 2)).status, 502);

  const unpricedUser = await createUser('unpriced-stats-user', ['unpriced'], 100, 100);
  assert.equal((await chat(unpricedUser.token, 'unpriced', 2)).status, 200);

  let stats = await admin('/admin/stats?range=today');
  assert.equal(stats.status, 200);
  const pricedGroup = stats.body.by_user.find((row) => row.name === 'priced-stats-user');
  assert.equal(pricedGroup.total_requests, 2);
  assert.equal(pricedGroup.successful_requests, 1);
  assert.equal(pricedGroup.failed_requests, 1);
  assert.equal(pricedGroup.error_rate, 50);
  assert.equal(pricedGroup.cost_configured, true);
  assert.ok(Math.abs(pricedGroup.estimated_cost_usd - 0.000006) < 1e-12);
  assert.ok(pricedGroup.average_response_time_ms >= 0);
  assert.ok(pricedGroup.p95_response_time_ms >= pricedGroup.average_response_time_ms);
  assert.ok(stats.body.by_model.some((row) => row.id === 'priced'));
  assert.ok(stats.body.by_provider.some((row) => row.id === providerId));

  const unpricedGroup = stats.body.by_user.find((row) => row.name === 'unpriced-stats-user');
  assert.equal(unpricedGroup.cost_configured, false);
  assert.equal(unpricedGroup.estimated_cost_usd, null);
  const failure = stats.body.recent_requests.find((row) => row.user_id === pricedUser.id && row.model_name === 'provider-fail');
  assert.equal(failure.error_type, 'provider_http');
  assert.equal(JSON.stringify(failure).includes('provider-response-must-not-be-stored'), false);

  const pricedModel = (await admin('/admin/models')).body.find((model) => model.model_name === 'priced');
  await admin(`/admin/models/${pricedModel.id}`, {
    method: 'PUT', body: { input_cost_per_million: 100, output_cost_per_million: 100 }
  });
  stats = await admin('/admin/stats?range=today');
  const unchanged = stats.body.by_user.find((row) => row.name === 'priced-stats-user');
  assert.ok(Math.abs(unchanged.estimated_cost_usd - 0.000006) < 1e-12);

  assert.equal((await admin('/admin/stats?range=custom&start=2026-02-30&end=2026-03-01')).status, 400);
  assert.equal((await admin('/admin/stats?range=custom&start=2026-03-02&end=2026-03-01')).status, 400);
  assert.equal((await admin('/admin/stats?range=unknown')).status, 400);
});

test('admin input validation rejects unsafe values and references', async () => {
  const cases = [
    admin('/admin/users', { method: 'POST', body: { username: ' ', max_daily_input_tokens: 1, max_daily_output_tokens: 1 } }),
    admin('/admin/users', { method: 'POST', body: { username: 'invalid-quota', max_daily_input_tokens: 0, max_daily_output_tokens: 1 } }),
    admin('/admin/users', { method: 'POST', body: { username: 'unknown-model', max_daily_input_tokens: 1, max_daily_output_tokens: 1, allowed_models: ['missing'] } }),
    admin('/admin/models', { method: 'POST', body: { model_name: 'UPPER', display_name: 'Bad', provider_id: providerId, max_tokens: 1 } }),
    admin('/admin/models', { method: 'POST', body: { model_name: 'missing-provider', display_name: 'Bad', provider_id: 999999, max_tokens: 1 } }),
    admin('/admin/models', { method: 'POST', body: { model_name: 'bad-price', display_name: 'Bad', provider_id: providerId, max_tokens: 1, input_cost_per_million: -1 } }),
    admin('/admin/providers', { method: 'POST', body: { provider_name: 'ftp-provider', display_name: 'FTP', base_url: 'ftp://example.test', auth_type: 'none' } }),
    admin('/admin/providers', { method: 'POST', body: { provider_name: 'url-credentials', display_name: 'Bad', base_url: 'https://user:pass@example.test', auth_type: 'none' } }),
    admin('/admin/providers', { method: 'POST', body: { provider_name: 'bad-auth', display_name: 'Bad', base_url: 'https://example.test', auth_type: 'basic' } }),
    admin('/admin/providers/not-an-id/test', { method: 'POST' }),
    admin(`/admin/providers/${providerId}`, { method: 'PUT', body: { is_active: 1 } }),
    admin('/admin/users', { method: 'POST', body: [] })
  ];
  const results = await Promise.all(cases);
  for (const result of results) assert.equal(result.status, 400);
  for (const result of results) assert.equal(result.body.error.includes('SQLITE'), false);
});

test('provider Base URLs reject query fragment traversal and encoded separators', async () => {
  const unsafeUrls = unsafeProviderBaseUrls();
  for (const [index, base_url] of unsafeUrls.entries()) {
    const response = await admin('/admin/providers', {
      method: 'POST',
      body: { provider_name: `unsafe-${index}`, display_name: 'Unsafe', base_url, auth_type: 'none' }
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_request');
  }
});

test('provider Base URL updates reject unsafe forms without changing the stored canonical URL', async () => {
  const provider = await admin('/admin/providers', {
    method: 'POST',
    body: {
      provider_name: 'base-path-update-provider',
      display_name: 'Base Path Update',
      base_url: `HTTP://127.0.0.1:${providerServer.address().port}/openai/v1/`,
      auth_type: 'none'
    }
  });
  assert.equal(provider.status, 201);
  const canonicalUrl = `${providerBaseUrl}/openai/v1`;
  assert.equal(provider.body.base_url, canonicalUrl);

  for (const base_url of unsafeProviderBaseUrls()) {
    const response = await admin(`/admin/providers/${provider.body.id}`, {
      method: 'PUT', body: { base_url }
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_request');
    const stored = (await admin('/admin/providers')).body.find((item) => item.id === provider.body.id);
    assert.equal(stored.base_url, canonicalUrl);
  }
});

test('provider Base URLs are canonical and fixed endpoints preserve the base path', async () => {
  const provider = await admin('/admin/providers', {
    method: 'POST',
    body: {
      provider_name: 'base-path-provider',
      display_name: 'Base Path',
      base_url: `HTTP://127.0.0.1:${providerServer.address().port}/openai/v1/`,
      auth_type: 'none'
    }
  });
  assert.equal(provider.status, 201);
  assert.equal(provider.body.base_url, `${providerBaseUrl}/openai/v1`);
  const encodedPathProvider = await admin('/admin/providers', {
    method: 'POST',
    body: {
      provider_name: 'encoded-path-provider',
      display_name: 'Encoded Path',
      base_url: `${providerBaseUrl}/openai%20gateway/v1/`,
      auth_type: 'none'
    }
  });
  assert.equal(encodedPathProvider.status, 201);
  assert.equal(encodedPathProvider.body.base_url, `${providerBaseUrl}/openai%20gateway/v1`);

  const pathStart = providerPaths.length;
  assert.equal((await admin(`/admin/providers/${provider.body.id}/discover-models`)).status, 200);
  assert.equal((await admin('/admin/models', {
    method: 'POST',
    body: { model_name: 'base-path-model', display_name: 'Base Path', provider_id: provider.body.id }
  })).status, 201);
  const user = await createUser('base-path-user', ['base-path-model']);
  assert.equal((await chat(user.token, 'base-path-model', 1)).status, 200);
  assert.deepEqual(providerPaths.slice(pathStart), [
    '/openai/v1/models',
    '/openai/v1/chat/completions'
  ]);
});

test('dashboard uses CSP-compatible external assets and safe DOM rendering', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.js'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/admin-dashboard\.css">/);
  assert.match(html, /<script src="\/admin-dashboard\.js"><\/script>/);
  assert.equal(/<style(?:\s|>)/i.test(html), false);
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html), false);
  assert.equal(/\son\w+\s*=/.test(html), false);
  assert.equal(html.includes('\uFFFD'), false);
  assert.equal(script.includes('\uFFFD'), false);
  assert.doesNotThrow(() => new vm.Script(script));
  for (const sink of [
    /\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/,
    /document\.write/, /\blocalStorage\b/
  ]) {
    assert.equal(sink.test(script), false);
  }
  assert.ok(/\btextContent\b/.test(script));
  assert.ok(/createTextNode/.test(script));
});

test('database integrity remains valid', () => {
  const { runMigrations } = require('../db/migrations');
  runMigrations();
  runMigrations();
  const modelColumns = new Set(db.prepare('PRAGMA table_info(models)').all().map((column) => column.name));
  const logColumns = new Set(db.prepare('PRAGMA table_info(request_logs)').all().map((column) => column.name));
  assert.ok(modelColumns.has('input_cost_per_million'));
  assert.ok(modelColumns.has('output_cost_per_million'));
  assert.ok(logColumns.has('response_time_ms'));
  assert.ok(logColumns.has('error_type'));
  assert.ok(logColumns.has('estimated_cost_usd'));
  assert.equal(db.pragma('integrity_check')[0].integrity_check, 'ok');
});

test('setup creates secrets once and preserves existing configuration', () => {
  const setupRoot = fs.mkdtempSync(path.join(temporaryDirectory, 'setup-'));
  fs.copyFileSync(path.join(__dirname, '..', '.env.example'), path.join(setupRoot, '.env.example'));
  const environment = { ...process.env, LLM_GATEWAY_SETUP_ROOT: setupRoot };
  const first = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'setup.js')], { encoding: 'utf8', env: environment });
  assert.equal(first.status, 0, first.stderr);
  const created = fs.readFileSync(path.join(setupRoot, '.env'), 'utf8');
  const key = created.match(/^ADMIN_SECRET_KEY=(.+)$/m)[1];
  assert.ok(first.stdout.includes(key));
  const second = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'setup.js')], { encoding: 'utf8', env: environment });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(path.join(setupRoot, '.env'), 'utf8'), created);
  assert.equal(second.stdout.includes(key), false);
});

test('legacy plaintext tokens migrate without losing authentication material', () => {
  const legacyPath = path.join(temporaryDirectory, 'legacy.db');
  const legacyToken = crypto.randomBytes(32).toString('base64url');
  const legacy = new Database(legacyPath);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      api_token TEXT UNIQUE NOT NULL,
      max_daily_input_tokens INTEGER NOT NULL DEFAULT 100000,
      max_daily_output_tokens INTEGER NOT NULL DEFAULT 50000,
      is_active INTEGER NOT NULL DEFAULT 1,
      allowed_models TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  legacy.prepare('INSERT INTO users (username, api_token, created_at) VALUES (?, ?, ?)').run('legacy', legacyToken, new Date().toISOString());
  legacy.close();
  const migrate = spawnSync(process.execPath, ['-e', "const {runMigrations}=require('./db/migrations');runMigrations();require('./db/database').close()"], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: legacyPath, ADMIN_SECRET_KEY: adminKey, LOG_LEVEL: 'silent' }
  });
  assert.equal(migrate.status, 0, migrate.stdout + migrate.stderr);
  const migrated = new Database(legacyPath, { readonly: true });
  const row = migrated.prepare('SELECT u.api_token, t.token_hash FROM users u JOIN user_tokens t ON t.user_id = u.id').get();
  assert.match(row.api_token, /^sha256:[a-f0-9]{64}$/);
  assert.equal(row.token_hash, crypto.createHash('sha256').update(legacyToken).digest('hex'));
  assert.equal(row.api_token.includes(legacyToken), false);
  migrated.close();
  assert.equal(fs.readFileSync(legacyPath).includes(Buffer.from(legacyToken)), false);
  if (fs.existsSync(`${legacyPath}-wal`)) {
    assert.equal(fs.readFileSync(`${legacyPath}-wal`).includes(Buffer.from(legacyToken)), false);
  }
});

test('provider presets and discovery require explicit model registration', async () => {
  const presets = await admin('/admin/provider-presets');
  assert.equal(presets.status, 200);
  assert.deepEqual(presets.body.map((preset) => preset.name), [
    'Generic OpenAI-compatible', 'Ollama', 'vLLM', 'LM Studio',
    'llama.cpp server', 'LocalAI', 'NVIDIA NIM'
  ]);
  const beforeCount = db.prepare("SELECT COUNT(*) AS count FROM models WHERE model_name = 'discovered-model'").get().count;
  const discovered = await admin(`/admin/providers/${providerId}/discover-models`);
  assert.equal(discovered.status, 200);
  assert.ok(discovered.body.some((model) => model.model_name === 'discovered-model'));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM models WHERE model_name = 'discovered-model'").get().count, beforeCount);
  assert.equal((await admin('/admin/models', {
    method: 'POST', body: { model_name: 'discovered-model', display_name: 'Discovered', provider_id: providerId }
  })).status, 201);
  assert.equal((await admin('/admin/models', {
    method: 'POST', body: { model_name: 'discovered-model', display_name: 'Duplicate', provider_id: providerId }
  })).status, 409);
});

test('multiple hashed tokens support expiry, last use, and individual revocation', async () => {
  const user = await createUser('multi-token-user', ['standard']);
  const issued = await admin(`/admin/users/${user.id}/tokens`, {
    method: 'POST', body: { name: 'automation', expires_at: new Date(Date.now() + 60000).toISOString() }
  });
  assert.equal(issued.status, 201);
  assert.equal((await request('/v1/models', { headers: { Authorization: `Bearer ${issued.body.apiToken}` } })).status, 200);
  let tokens = await admin(`/admin/users/${user.id}/tokens`);
  const used = tokens.body.find((token) => token.id === issued.body.tokenId);
  assert.ok(used.last_used_at);
  assert.equal(JSON.stringify(tokens.body).includes(issued.body.apiToken), false);
  const stored = db.prepare('SELECT token_hash FROM user_tokens WHERE id = ?').get(issued.body.tokenId);
  assert.notEqual(stored.token_hash, issued.body.apiToken);
  assert.equal(db.prepare('SELECT api_token FROM users WHERE id = ?').get(user.id).api_token.includes(issued.body.apiToken), false);
  assert.equal((await admin(`/admin/users/${user.id}/tokens/${issued.body.tokenId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request('/v1/models', { headers: { Authorization: `Bearer ${issued.body.apiToken}` } })).status, 401);

  const expired = await admin(`/admin/users/${user.id}/tokens`, {
    method: 'POST', body: { name: 'expires', expires_at: new Date(Date.now() + 30).toISOString() }
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await request('/v1/models', { headers: { Authorization: `Bearer ${expired.body.apiToken}` } })).status, 401);
  assert.equal((await request('/v1/models', { headers: { Authorization: `Bearer ${user.token}` } })).status, 200);
});

test('RPM and concurrency limits fail before provider calls with stable 429 responses', async () => {
  const rpmUser = await createUser('rpm-user', ['standard']);
  await admin(`/admin/users/${rpmUser.id}`, { method: 'PUT', body: { max_requests_per_minute: 1 } });
  assert.equal((await chat(rpmUser.token, 'standard', 1)).status, 200);
  const before = providerCalls.get('standard');
  const limited = await chat(rpmUser.token, 'standard', 1);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'rate_limit_exceeded');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(providerCalls.get('standard'), before);

  const userLimited = await createUser('user-concurrency-user', ['user-concurrency']);
  await admin(`/admin/users/${userLimited.id}`, { method: 'PUT', body: { max_concurrent_requests: 1 } });
  const userResponses = await Promise.all([chat(userLimited.token, 'user-concurrency', 1), chat(userLimited.token, 'user-concurrency', 1)]);
  assert.deepEqual(userResponses.map((response) => response.status).sort(), [200, 429]);

  const model = (await admin('/admin/models')).body.find((item) => item.model_name === 'model-concurrency');
  await admin(`/admin/models/${model.id}`, { method: 'PUT', body: { max_concurrent_requests: 1 } });
  const modelUserA = await createUser('model-concurrency-a', ['model-concurrency']);
  const modelUserB = await createUser('model-concurrency-b', ['model-concurrency']);
  const modelResponses = await Promise.all([chat(modelUserA.token, 'model-concurrency', 1), chat(modelUserB.token, 'model-concurrency', 1)]);
  assert.deepEqual(modelResponses.map((response) => response.status).sort(), [200, 429]);

  const provider = await admin('/admin/providers', {
    method: 'POST', body: { provider_name: 'concurrency-provider', display_name: 'Concurrency', base_url: providerBaseUrl, auth_type: 'none', max_concurrent_requests: 1 }
  });
  assert.equal(provider.status, 201);
  for (const name of ['provider-concurrency-a', 'provider-concurrency-b']) {
    assert.equal((await admin('/admin/models', { method: 'POST', body: { model_name: name, display_name: name, provider_id: provider.body.id, max_concurrent_requests: 2 } })).status, 201);
  }
  const providerUserA = await createUser('provider-concurrency-user-a', ['provider-concurrency-a']);
  const providerUserB = await createUser('provider-concurrency-user-b', ['provider-concurrency-b']);
  const providerResponses = await Promise.all([chat(providerUserA.token, 'provider-concurrency-a', 1), chat(providerUserB.token, 'provider-concurrency-b', 1)]);
  assert.deepEqual(providerResponses.map((response) => response.status).sort(), [200, 429]);
});

test('streaming SSE and tool-call fields pass through and usage is recorded', async () => {
  const user = await createUser('streaming-user', ['streaming']);
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'streaming', stream: true,
      messages: [{ role: 'user', content: 'private-stream-prompt' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      vendor_extension: { passthrough: true }
    })
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes('tool_calls'));
  assert.ok(text.includes('[DONE]'));
  assert.equal(receivedPayloads.get('streaming').tools[0].function.name, 'lookup');
  assert.deepEqual(receivedPayloads.get('streaming').vendor_extension, { passthrough: true });
  const usage = await request('/dashboard/usage', { headers: { Authorization: `Bearer ${user.token}` } });
  assert.equal(usage.body.inputTokens, 1);
  assert.equal(usage.body.outputTokens, 1);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM request_logs WHERE user_id = ?').all(user.id)).includes('private-stream-prompt'), false);
});

test('prompts, responses, and provider error bodies are absent from database and logs', async () => {
  const user = await createUser('privacy-user', ['privacy', 'provider-fail']);
  assert.equal((await request('/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${user.token}` },
    body: { model: 'privacy', messages: [{ role: 'user', content: 'private-prompt-marker' }] }
  })).status, 200);
  assert.equal((await chat(user.token, 'provider-fail', 1)).status, 502);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const serialized = tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table.name}`).all())).join('');
  for (const marker of ['private-prompt-marker', 'private-response-marker', 'provider-response-must-not-be-stored']) {
    assert.equal(serialized.includes(marker), false);
  }
  const logFiles = fs.readdirSync(temporaryDirectory).filter((name) => /\.(log|out|err)$/i.test(name));
  for (const file of logFiles) {
    const contents = fs.readFileSync(path.join(temporaryDirectory, file), 'utf8');
    assert.equal(contents.includes('private-prompt-marker'), false);
    assert.equal(contents.includes('private-response-marker'), false);
  }
});

test('unexpected redirects are rejected without changing provider configuration', async () => {
  const provider = await admin('/admin/providers', {
    method: 'POST', body: { provider_name: 'redirect-provider', display_name: 'Redirect', base_url: `${providerBaseUrl}/redirect`, auth_type: 'none' }
  });
  assert.equal(provider.status, 201);
  assert.equal((await admin('/admin/models', {
    method: 'POST', body: { model_name: 'redirect-model', display_name: 'Redirect', provider_id: provider.body.id }
  })).status, 201);
  assert.equal((await admin(`/admin/providers/${provider.body.id}/discover-models`)).status, 502);
  const unchanged = (await admin('/admin/providers')).body.find((item) => item.id === provider.body.id);
  assert.equal(unchanged.base_url, `${providerBaseUrl}/redirect`);
  const user = await createUser('redirect-user', ['redirect-model']);
  const response = await chat(user.token, 'redirect-model', 1);
  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'provider_redirect_rejected');
});

test('client disconnect aborts upstream and releases quota and concurrency', async () => {
  const user = await createUser('disconnect-user', ['disconnect']);
  const before = upstreamDisconnects;
  await new Promise((resolve) => {
    const client = http.request(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' }
    });
    client.on('error', () => {});
    client.write(JSON.stringify({ model: 'disconnect', messages: [{ role: 'user', content: 'disconnect-secret' }], max_tokens: 1 }));
    client.end();
    setTimeout(() => client.destroy(), 30);
    setTimeout(resolve, 250);
  });
  assert.ok(upstreamDisconnects > before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM quota_reservations WHERE user_id = ?').get(user.id).count, 0);
  const { state } = require('../services/limits');
  assert.equal(state().users[user.id], undefined);
});

test('streaming backpressure aborts upstream and releases quota and concurrency', async () => {
  const user = await createUser('backpressure-user', ['backpressure']);
  const before = upstreamDisconnects;
  const started = once(providerEvents, 'backpressure:started', { signal: AbortSignal.timeout(3000) });
  const closed = once(providerEvents, 'backpressure:closed', { signal: AbortSignal.timeout(3000) });
  const client = http.request(`${baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' }
  });
  client.on('error', () => {});
  client.on('response', (response) => {
    response.once('error', () => {});
    client.destroy();
  });
  client.end(JSON.stringify({
    model: 'backpressure', stream: true,
    messages: [{ role: 'user', content: 'backpressure-secret' }], max_tokens: 1
  }));

  await started;
  await closed;
  const reservationCount = () => db.prepare(
    'SELECT COUNT(*) AS count FROM quota_reservations WHERE user_id = ?'
  ).get(user.id).count;
  await waitFor(() => reservationCount() === 0, 'backpressure cleanup did not finish');
  const { state } = require('../services/limits');
  assert.equal(upstreamDisconnects, before + 1);
  assert.equal(reservationCount(), 0);
  assert.equal(state().users[user.id], undefined);
  assert.equal(state().models.backpressure, undefined);
  assert.equal(state().providers[providerId], undefined);
});

test('abortInFlight aborts active requests and cleanup is idempotent', async (t) => {
  const user = await createUser('abort-in-flight-user', ['abort-in-flight']);
  const before = upstreamDisconnects;
  const started = once(providerEvents, 'abort-in-flight:started', { signal: AbortSignal.timeout(3000) });
  const closed = once(providerEvents, 'abort-in-flight:closed', { signal: AbortSignal.timeout(3000) });
  let client;
  client = http.request(`${baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' }
  }, (response) => {
    response.resume();
  });
  const completed = once(client, 'close', { signal: AbortSignal.timeout(3000) });
  client.end(JSON.stringify({
    model: 'abort-in-flight', messages: [{ role: 'user', content: 'abort-secret' }], max_tokens: 1
  }));
  t.after(() => client.destroy());

  await started;
  const v1 = require('../routes/v1');
  assert.equal(typeof v1.abortInFlight, 'function');
  v1.abortInFlight();
  v1.abortInFlight();
  await closed;
  await completed;
  const reservationCount = () => db.prepare(
    'SELECT COUNT(*) AS count FROM quota_reservations WHERE user_id = ?'
  ).get(user.id).count;
  await waitFor(() => reservationCount() === 0, 'abortInFlight cleanup did not finish');
  const { state } = require('../services/limits');
  assert.equal(upstreamDisconnects, before + 1);
  assert.equal(reservationCount(), 0);
  assert.equal(state().users[user.id], undefined);
  assert.equal(state().models['abort-in-flight'], undefined);
  assert.equal(state().providers[providerId], undefined);
});

test('online backup, retention, audit privacy, doctor, and Docker healthcheck are verifiable', async () => {
  const backup = await admin('/admin/backup', { method: 'POST' });
  assert.equal(backup.status, 201);
  assert.equal(backup.body.integrity, 'ok');
  const backupPath = path.join(path.dirname(databasePath), 'backups', backup.body.filename);
  const copy = new Database(backupPath, { readonly: true });
  assert.equal(copy.pragma('integrity_check')[0].integrity_check, 'ok');
  assert.equal(copy.pragma('user_version', { simple: true }), 2);
  copy.close();

  const user = await createUser('retention-user', ['standard']);
  db.prepare(`
    INSERT INTO request_logs (user_id, model_name, status, created_at)
    VALUES (?, 'standard', 'success', '2000-01-01T00:00:00.000Z')
  `).run(user.id);
  assert.equal((await admin('/admin/retention', { method: 'PUT', body: { request_log_retention_days: 1 } })).status, 200);
  const cleanup = await admin('/admin/retention/cleanup', { method: 'POST' });
  assert.ok(cleanup.body.deleted >= 1);
  const auditLogs = await admin('/admin/audit-logs');
  assert.equal(auditLogs.status, 200);
  const serializedAudit = JSON.stringify(auditLogs.body);
  assert.equal(serializedAudit.includes(adminKey), false);
  assert.equal(serializedAudit.includes(providerKey), false);

  const doctor = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'doctor.js')], {
    encoding: 'utf8', env: { ...process.env, ADMIN_SECRET_KEY: adminKey, DATABASE_PATH: databasePath, LOG_LEVEL: 'silent' }
  });
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.equal(doctor.stdout.includes(adminKey), false);
  assert.equal(doctor.stdout.includes(providerKey), false);
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /\/health/);
});
