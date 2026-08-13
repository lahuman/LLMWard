const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-admin-models-'));
const databasePath = path.join(temporaryDirectory, 'gateway.db');
const adminKey = crypto.randomBytes(32).toString('base64url');

process.env.ADMIN_SECRET_KEY = adminKey;
process.env.DATABASE_PATH = databasePath;
process.env.LOG_LEVEL = 'silent';

const defaultFields = [
  'context_window',
  'default_temperature',
  'default_top_p',
  'default_presence_penalty',
  'default_frequency_penalty',
  'default_seed'
];

const defaults = {
  context_window: 8192,
  default_temperature: 0,
  default_top_p: 1,
  default_presence_penalty: -2,
  default_frequency_penalty: 2,
  default_seed: 0
};

let server;
let baseUrl;
let db;
let providerId;

function listen(value) {
  return new Promise((resolve) => value.listen(0, '127.0.0.1', resolve));
}

function close(value) {
  return new Promise((resolve, reject) => value.close((error) => error ? reject(error) : resolve()));
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
  return { status: response.status, body };
}

function admin(route, options = {}) {
  return request(route, {
    ...options,
    headers: { 'X-Admin-Key': adminKey, ...(options.headers || {}) }
  });
}

function modelPayload(overrides = {}) {
  return {
    model_name: 'typed-model', display_name: 'Typed Model',
    provider_id: providerId, ...overrides
  };
}

function assertDefaults(actual, expected) {
  for (const field of defaultFields) assert.equal(actual[field], expected[field], field);
}

async function listedModel(modelId) {
  const response = await admin('/admin/models');
  assert.equal(response.status, 200);
  return response.body.find((model) => model.id === modelId);
}

before(async () => {
  const app = require('../app');
  db = require('../db/database');
  server = http.createServer(app);
  await listen(server);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const provider = await admin('/admin/providers', {
    method: 'POST',
    body: {
      provider_name: 'admin-model-test',
      display_name: 'Admin Model Test',
      base_url: 'https://provider.example/v1',
      auth_type: 'none'
    }
  });
  assert.equal(provider.status, 201);
  providerId = provider.body.id;
});

beforeEach(() => {
  db.prepare('DELETE FROM content_filter_models').run();
  db.prepare('DELETE FROM user_tokens').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM models').run();
  db.prepare("DELETE FROM audit_logs WHERE target_type IN ('model', 'user', 'token')").run();
});

after(async () => {
  await close(server);
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('admin model creation stores omitted defaults as null and keeps max_tokens at 4096', async () => {
  const created = await admin('/admin/models', { method: 'POST', body: modelPayload() });
  assert.equal(created.status, 201);
  assert.equal(created.body.max_tokens, 4096);
  assertDefaults(created.body, Object.fromEntries(defaultFields.map((field) => [field, null])));

  const listed = await listedModel(created.body.id);
  assert.ok(listed);
  assert.equal(listed.max_tokens, 4096);
  assertDefaults(listed, Object.fromEntries(defaultFields.map((field) => [field, null])));
});

test('admin model defaults create list partially update and clear with explicit null', async () => {
  const created = await admin('/admin/models', {
    method: 'POST', body: modelPayload(defaults)
  });
  assert.equal(created.status, 201);
  assertDefaults(created.body, defaults);
  assertDefaults(await listedModel(created.body.id), defaults);

  const partialDefaults = { ...defaults, default_temperature: 1.5, default_seed: -7 };
  const partial = await admin(`/admin/models/${created.body.id}`, {
    method: 'PUT', body: { default_temperature: 1.5, default_seed: -7 }
  });
  assert.equal(partial.status, 200);
  assertDefaults(partial.body, partialDefaults);
  assertDefaults(await listedModel(created.body.id), partialDefaults);

  const clearedValues = Object.fromEntries(defaultFields.map((field) => [field, null]));
  const cleared = await admin(`/admin/models/${created.body.id}`, {
    method: 'PUT', body: clearedValues
  });
  assert.equal(cleared.status, 200);
  assertDefaults(cleared.body, clearedValues);
  assertDefaults(await listedModel(created.body.id), clearedValues);
});

test('admin model defaults accept documented numeric boundaries', async () => {
  const cases = [
    ['context-min', { context_window: 1, max_tokens: 1 }],
    ['context-max', { context_window: Number.MAX_SAFE_INTEGER }],
    ['temperature-min', { default_temperature: 0 }],
    ['temperature-max', { default_temperature: 2 }],
    ['top-p-min', { default_top_p: 0 }],
    ['top-p-max', { default_top_p: 1 }],
    ['presence-min', { default_presence_penalty: -2 }],
    ['presence-max', { default_presence_penalty: 2 }],
    ['frequency-min', { default_frequency_penalty: -2 }],
    ['frequency-max', { default_frequency_penalty: 2 }],
    ['seed-min', { default_seed: Number.MIN_SAFE_INTEGER }],
    ['seed-max', { default_seed: Number.MAX_SAFE_INTEGER }]
  ];

  for (const [name, values] of cases) {
    const created = await admin('/admin/models', {
      method: 'POST',
      body: modelPayload({ model_name: `boundary-${name}`, ...values })
    });
    assert.equal(created.status, 201, name);
    for (const [field, value] of Object.entries(values)) assert.equal(created.body[field], value, `${name}:${field}`);
  }
});

test('admin model defaults reject invalid types ranges and unsafe integers atomically', async () => {
  const invalid = [
    ['context_window', 0], ['context_window', 1.5],
    ['context_window', Number.MAX_SAFE_INTEGER + 1], ['context_window', '8192'],
    ['default_temperature', -0.01], ['default_temperature', 2.01],
    ['default_temperature', ''], ['default_temperature', '1'],
    ['default_top_p', -0.01], ['default_top_p', 1.01], ['default_top_p', '1'],
    ['default_presence_penalty', -2.01], ['default_presence_penalty', 2.01],
    ['default_presence_penalty', '-1'],
    ['default_frequency_penalty', -2.01], ['default_frequency_penalty', 2.01],
    ['default_frequency_penalty', '1'],
    ['default_seed', 1.5], ['default_seed', Number.MAX_SAFE_INTEGER + 1],
    ['default_seed', '0']
  ];

  for (const [index, [field, value]] of invalid.entries()) {
    const modelName = `invalid-${index}`;
    const result = await admin('/admin/models', {
      method: 'POST', body: modelPayload({ model_name: modelName, [field]: value })
    });
    assert.equal(result.status, 400, `${field}:${JSON.stringify(value)}`);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM models WHERE model_name = ?').get(modelName).count, 0);
  }
});

test('admin model context relationship validates effective create and partial-update values', async () => {
  const invalidCreate = await admin('/admin/models', {
    method: 'POST', body: modelPayload({ model_name: 'context-too-small', context_window: 4095 })
  });
  assert.equal(invalidCreate.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM models WHERE model_name = 'context-too-small'").get().count, 0);

  const created = await admin('/admin/models', {
    method: 'POST', body: modelPayload({ max_tokens: 100, context_window: 200 })
  });
  assert.equal(created.status, 201);

  const smallerContext = await admin(`/admin/models/${created.body.id}`, {
    method: 'PUT', body: { context_window: 99 }
  });
  assert.equal(smallerContext.status, 400);
  let stored = await listedModel(created.body.id);
  assert.equal(stored.max_tokens, 100);
  assert.equal(stored.context_window, 200);

  const largerOutput = await admin(`/admin/models/${created.body.id}`, {
    method: 'PUT', body: { max_tokens: 201 }
  });
  assert.equal(largerOutput.status, 400);
  stored = await listedModel(created.body.id);
  assert.equal(stored.max_tokens, 100);
  assert.equal(stored.context_window, 200);

  const equalCapacity = await admin(`/admin/models/${created.body.id}`, {
    method: 'PUT', body: { max_tokens: 300, context_window: 300 }
  });
  assert.equal(equalCapacity.status, 200);
  assert.equal(equalCapacity.body.max_tokens, 300);
  assert.equal(equalCapacity.body.context_window, 300);

  const clearedContext = await admin(`/admin/models/${created.body.id}`, {
    method: 'PUT', body: { max_tokens: 500, context_window: null }
  });
  assert.equal(clearedContext.status, 200);
  assert.equal(clearedContext.body.max_tokens, 500);
  assert.equal(clearedContext.body.context_window, null);
});

test('invalid model capacity updates do not rename the model or its user permissions', async () => {
  const created = await admin('/admin/models', {
    method: 'POST', body: modelPayload({ model_name: 'rename-must-remain', max_tokens: 100, context_window: 200 })
  });
  assert.equal(created.status, 201);
  const user = await admin('/admin/users', {
    method: 'POST',
    body: { username: 'atomic-user', allowed_models: ['rename-must-remain'] }
  });
  assert.equal(user.status, 201);
  const permissionsBefore = db.prepare('SELECT id, allowed_models FROM users ORDER BY id').all();

  const invalid = await admin(`/admin/models/${created.body.id}`, {
    method: 'PUT',
    body: { model_name: 'must-not-stick', max_tokens: 201, context_window: 200 }
  });
  assert.equal(invalid.status, 400);

  const stored = await listedModel(created.body.id);
  assert.equal(stored.model_name, 'rename-must-remain');
  assert.equal(stored.max_tokens, 100);
  assert.equal(stored.context_window, 200);
  assert.deepEqual(db.prepare('SELECT id, allowed_models FROM users ORDER BY id').all(), permissionsBefore);
});

test('admin model audits store only changed default field names', async () => {
  const created = await admin('/admin/models', { method: 'POST', body: modelPayload() });
  assert.equal(created.status, 201);
  const distinctive = {
    context_window: 7654321,
    default_temperature: 1.234567,
    default_top_p: 0.876543,
    default_presence_penalty: -1.765432,
    default_frequency_penalty: 1.654321,
    default_seed: 6748392
  };

  const updated = await admin(`/admin/models/${created.body.id}`, {
    method: 'PUT', body: distinctive
  });
  assert.equal(updated.status, 200);

  const auditRow = db.prepare(`
    SELECT action, target_type, target_id, success, changed_fields
    FROM audit_logs WHERE action = 'model.update' ORDER BY id DESC LIMIT 1
  `).get();
  assert.deepEqual(JSON.parse(auditRow.changed_fields), [...defaultFields].sort());
  const serialized = JSON.stringify(auditRow);
  for (const value of Object.values(distinctive)) {
    assert.equal(serialized.includes(String(value)), false, String(value));
  }
});
