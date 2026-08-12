const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-admin-filters-'));
const databasePath = path.join(temporaryDirectory, 'gateway.db');
const adminKey = crypto.randomBytes(32).toString('base64url');

process.env.ADMIN_SECRET_KEY = adminKey;
process.env.DATABASE_PATH = databasePath;
process.env.LOG_LEVEL = 'silent';

let server;
let baseUrl;
let db;
let providerId;
let modelIds;

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

before(async () => {
  const app = require('../app');
  db = require('../db/database');
  server = http.createServer(app);
  await listen(server);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const provider = await admin('/admin/providers', {
    method: 'POST',
    body: {
      provider_name: 'filter-test',
      display_name: 'Filter Test',
      base_url: 'https://provider.example/v1',
      auth_type: 'none'
    }
  });
  assert.equal(provider.status, 201);
  providerId = provider.body.id;
  modelIds = [];
  for (const name of ['filter-model-a', 'filter-model-b']) {
    const model = await admin('/admin/models', {
      method: 'POST',
      body: { model_name: name, display_name: name, provider_id: providerId }
    });
    assert.equal(model.status, 201);
    modelIds.push(model.body.id);
  }
});

beforeEach(() => {
  if (!db) return;
  db.prepare('DELETE FROM content_filters').run();
  db.prepare("DELETE FROM audit_logs WHERE target_type = 'filter'").run();
});

after(async () => {
  await close(server);
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('filter routes authenticate first and create inactive model-scoped filters by default', async () => {
  const payload = { name: '  Organization PII  ', patterns: ['literal one'], input_action: 'block' };
  assert.equal((await request('/admin/filters', { method: 'POST', body: payload })).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content_filters').get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE target_type = 'filter'").get().count, 0);

  const created = await admin('/admin/filters', { method: 'POST', body: payload });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body), [
    'id', 'name', 'patterns', 'input_action', 'output_action', 'is_active', 'is_global',
    'model_ids', 'created_at', 'updated_at'
  ]);
  assert.equal(created.body.name, 'Organization PII');
  assert.deepEqual(created.body.patterns, ['literal one']);
  assert.equal(created.body.input_action, 'block');
  assert.equal(created.body.output_action, null);
  assert.equal(created.body.is_active, false);
  assert.equal(created.body.is_global, false);
  assert.deepEqual(created.body.model_ids, []);
  assert.equal(typeof created.body.created_at, 'string');
  assert.equal(typeof created.body.updated_at, 'string');

  const listed = await admin('/admin/filters');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, [created.body]);
});

test('filter routes partially update model/global scope and delete assignments', async () => {
  const created = await admin('/admin/filters', {
    method: 'POST',
    body: {
      name: 'Scoped output', patterns: ['token'], output_action: 'mask',
      is_active: true, model_ids: [modelIds[1], modelIds[0]]
    }
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.model_ids, modelIds);

  const global = await admin(`/admin/filters/${created.body.id}`, {
    method: 'PUT', body: { is_global: true, model_ids: [modelIds[0]] }
  });
  assert.equal(global.status, 200);
  assert.equal(global.body.is_global, true);
  assert.deepEqual(global.body.model_ids, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content_filter_models WHERE filter_id = ?').get(created.body.id).count, 0);

  const modelScoped = await admin(`/admin/filters/${created.body.id}`, {
    method: 'PUT', body: { is_global: false, model_ids: [modelIds[1]], name: 'Scoped output v2' }
  });
  assert.equal(modelScoped.status, 200);
  assert.equal(modelScoped.body.name, 'Scoped output v2');
  assert.deepEqual(modelScoped.body.model_ids, [modelIds[1]]);

  const deleted = await admin(`/admin/filters/${created.body.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { message: 'Filter deleted' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content_filters WHERE id = ?').get(created.body.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content_filter_models WHERE filter_id = ?').get(created.body.id).count, 0);
});

test('filter validation is atomic and audits only fixed metadata', async () => {
  const privateName = 'private-filter-name-marker';
  const privatePattern = 'private-pattern-marker';
  const created = await admin('/admin/filters', {
    method: 'POST',
    body: { name: privateName, patterns: [privatePattern], input_action: 'mask', model_ids: [modelIds[0]] }
  });
  assert.equal(created.status, 201);

  for (const requestCase of [
    { route: `/admin/filters/${created.body.id}`, method: 'PUT', body: { unknown: true } },
    { route: `/admin/filters/${created.body.id}`, method: 'PUT', body: { patterns: ['duplicate', 'DUPLICATE'] } },
    { route: `/admin/filters/${created.body.id}`, method: 'PUT', body: { patterns: ['changed-private-marker'], model_ids: [999999] } },
    { route: '/admin/filters', method: 'POST', body: { name: privateName, patterns: ['other'], output_action: 'mask' } },
    { route: '/admin/filters/999999', method: 'PUT', body: { name: 'missing' } },
    { route: '/admin/filters/999999', method: 'DELETE' }
  ]) {
    const result = await admin(requestCase.route, {
      method: requestCase.method,
      ...(requestCase.body === undefined ? {} : { body: requestCase.body })
    });
    assert.ok([400, 404, 409].includes(result.status), `${requestCase.method} ${requestCase.route}: ${result.status}`);
  }

  const unchanged = (await admin('/admin/filters')).body;
  assert.equal(unchanged.length, 1);
  assert.deepEqual(unchanged[0].patterns, [privatePattern]);
  assert.deepEqual(unchanged[0].model_ids, [modelIds[0]]);

  const audits = db.prepare(`
    SELECT action, target_type, target_id, success, changed_fields
    FROM audit_logs WHERE target_type = 'filter' ORDER BY id
  `).all();
  assert.equal(audits[0].action, 'filter.create');
  assert.equal(audits[0].success, 1);
  assert.deepEqual(JSON.parse(audits[0].changed_fields), ['input_action', 'model_ids', 'name', 'patterns']);
  assert.ok(audits.slice(1).every((row) => row.action === 'filter.change' && row.success === 0));
  const serializedAudits = JSON.stringify(audits);
  assert.equal(serializedAudits.includes(privateName), false);
  assert.equal(serializedAudits.includes(privatePattern), false);
  assert.equal(serializedAudits.includes('changed-private-marker'), false);
});

test('filter routes enforce the organization-wide 200-pattern limit', async () => {
  const first = await admin('/admin/filters', {
    method: 'POST',
    body: {
      name: 'First 199',
      patterns: Array.from({ length: 199 }, (_, index) => `pattern-${index}`),
      input_action: 'block'
    }
  });
  assert.equal(first.status, 201);
  assert.equal((await admin('/admin/filters', {
    method: 'POST', body: { name: 'Pattern 200', patterns: ['last-pattern'], output_action: 'mask' }
  })).status, 201);
  assert.equal((await admin('/admin/filters', {
    method: 'POST', body: { name: 'Pattern 201', patterns: ['one-too-many'], output_action: 'mask' }
  })).status, 400);
  assert.equal((await admin('/admin/filters')).body.length, 2);
});

test('dashboard exposes an accessible safe-DOM filter editor without rendering pattern values in the list', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.js'), 'utf8');
  assert.match(html, /data-tab="filters"/);
  assert.match(html, /id="tab-filters"/);
  assert.match(html, /id="filter-form"/);
  assert.match(html, /<section[^>]+id="filter-usage-guide"[^>]+aria-labelledby="filter-guide-title"/);
  assert.match(html, /<h2[^>]+id="filter-guide-title"[^>]*>How filters work<\/h2>/);
  assert.match(html, /<ol[^>]+class="filter-steps"/);
  assert.match(html, /<li>Enter one case-insensitive literal pattern per line\.<\/li>/);
  assert.match(html, /<li>Choose an input action and, when needed, output masking\.<\/li>/);
  assert.match(html, /<li>Select global or model scope, review the rule, and then activate it\.<\/li>/);
  assert.match(html, /None[^<]*<\/strong> leaves that direction unchanged/);
  assert.match(html, /<p>Before: <code>Contact employee@example\.test<\/code><\/p>/);
  assert.match(html, /Block[^<]*<\/strong> rejects matching input with HTTP 400/);
  assert.match(html, /stored in plaintext in SQLite and backups/);
  assert.match(html, /Mask[^<]*<\/strong> replaces matching text with <code>\[FILTERED\]<\/code>/);
  assert.match(html, /employee@example\.test/);
  assert.match(html, /Contact <code>\[FILTERED\]<\/code>/);
  assert.match(html, /literal substrings, not regular expressions/);
  assert.match(html, /New filters are inactive by default/);
  assert.match(html, /Global scope ignores model selection/);
  assert.match(html, /Global scope ignores model selection\.<\/p>\s*<\/section>\s*<div class="card"><h2 id="filter-form-title">Create filter/);
  assert.match(html, /<textarea[^>]+name="patterns"[^>]+aria-describedby="filter-pattern-help"/);
  assert.match(html, /<select[^>]+name="modelIds"[^>]+multiple/);
  assert.match(html, /id="filter-cancel"/);
  assert.match(html, /id="filters-content"/);
  assert.doesNotThrow(() => new vm.Script(script));
  for (const unsafeSink of [/\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/]) {
    assert.equal(unsafeSink.test(script), false);
  }
  assert.match(script, /filter\.patterns\.length/);
  assert.match(script, /filter\.patterns\.join\('\\n'\)/);
  assert.match(script, /new Set\(Array\.from\(select\.selectedOptions,\(option\)=>Number\(option\.value\)\)\)/);
  assert.match(script, /option\.selected=selected\.has\(model\.id\)/);
  assert.match(script, /select\.disabled=global/);
  assert.equal(/option\.selected=false/.test(script), false);
  assert.match(script, /function resetFilterForm\(focusName=false\).*if\(focusName\)form\.elements\.name\.focus\(\)/);
  assert.match(script, /filter-cancel'\)\.addEventListener\('click',\(\)=>resetFilterForm\(true\)\)/);
});

test('dashboard exposes client-safe policy attribution guidance for input blocks', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');
  assert.match(html, /<input[^>]+name="name"[^>]+aria-describedby="filter-name-help"/);
  assert.match(html, /<p[^>]+id="filter-name-help"[^>]*>[\s\S]*?<code>filter_name<\/code>/);
  const blockSectionMatch = html.match(/<section\b[^>]*\bid="filter-block-example"[^>]*>[\s\S]*?<\/section>/);
  assert.ok(blockSectionMatch, 'input block example section must exist');
  const blockExample = blockSectionMatch[0];
  assert.match(blockExample, /aria-labelledby="filter-block-example-title"/);
  assert.match(blockExample, /<h3[^>]+id="filter-block-example-title"[^>]*>Input block example<\/h3>/);
  assert.match(blockExample, /[\w.+-]+@[\w.-]+\.test\b/i);
  const responseMatch = blockExample.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/);
  assert.ok(responseMatch, 'input block response example must exist');
  const responseBody = JSON.parse(responseMatch[1].trim().replace(/^HTTP 400\s*/, ''));
  assert.deepEqual(responseBody, {
    error: 'Request content was filtered', code: 'content_filtered', filter_name: 'Example input policy'
  });
  assert.match(html, /no selected models[^<]*does not take effect/i);
  assert.match(html, /documented chat text fields/i);
  assert.match(html, /literal matching/i);
  assert.match(html, /not a general DLP/i);
});
