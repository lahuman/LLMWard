const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-usage-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'gateway.db');
process.env.ADMIN_SECRET_KEY = `admin-${crypto.randomBytes(32).toString('base64url')}`;
process.env.LOG_LEVEL = 'silent';

const db = require('../db/database');
require('../db/migrations').runMigrations();
const { reserveQuota, releaseReservation, recordUsage, recordFailure } = require('../services/usage');

let fixtureId = 0;

after(() => {
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function createFixture() {
  fixtureId += 1;
  const provider = db.prepare(`
    INSERT INTO providers (provider_name, display_name, base_url, auth_type)
    VALUES (?, ?, ?, 'none')
  `).run(
    `usage-provider-${fixtureId}`,
    `Usage provider ${fixtureId}`,
    `https://usage-${fixtureId}.invalid/v1`
  );
  const modelName = `usage-model-${fixtureId}`;
  db.prepare(`
    INSERT INTO models
      (model_name, display_name, provider_id, max_tokens,
       input_cost_per_million, output_cost_per_million)
    VALUES (?, ?, ?, 16, 2, 3)
  `).run(modelName, `Usage model ${fixtureId}`, provider.lastInsertRowid);
  const model = db.prepare('SELECT * FROM models WHERE model_name = ?').get(modelName);
  const user = db.prepare('INSERT INTO users (username, api_token) VALUES (?, ?)')
    .run(`usage-user-${fixtureId}`, `sha256:${crypto.randomBytes(32).toString('hex')}`);
  const requestId = `usage-request-${fixtureId}`;
  db.prepare(`
    INSERT INTO quota_reservations
      (request_id, user_id, request_date, output_tokens, expires_at)
    VALUES (?, ?, '2026-08-11', 10, '2099-01-01T00:00:00.000Z')
  `).run(requestId, user.lastInsertRowid);
  return { requestId, userId: Number(user.lastInsertRowid), model };
}

function storedRows(fixture) {
  return {
    usage: db.prepare('SELECT * FROM usage_logs WHERE user_id = ?').get(fixture.userId),
    request: db.prepare('SELECT * FROM request_logs WHERE user_id = ?').get(fixture.userId),
    reservations: db.prepare('SELECT COUNT(*) AS count FROM quota_reservations WHERE request_id = ?')
      .get(fixture.requestId).count
  };
}

function createQuotaUser() {
  fixtureId += 1;
  const user = db.prepare(`
    INSERT INTO users
      (username, api_token, max_daily_input_tokens, max_daily_output_tokens)
    VALUES (?, ?, 1000, 1000)
  `).run(
    `quota-user-${fixtureId}`,
    `sha256:${crypto.randomBytes(32).toString('hex')}`
  );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.lastInsertRowid);
}

test('reserveQuota uses the supplied request lifetime for reservation expiry', () => {
  const user = createQuotaUser();
  const lifetimeMs = 600000;
  const before = Date.now();
  const reservation = reserveQuota(user, 1, 4, lifetimeMs);
  const after = Date.now();

  try {
    const row = db.prepare('SELECT expires_at FROM quota_reservations WHERE request_id = ?')
      .get(reservation.requestId);
    const expiresAt = Date.parse(row.expires_at);
    assert.ok(expiresAt >= before + lifetimeMs + 30000);
    assert.ok(expiresAt <= after + lifetimeMs + 30000);
  } finally {
    releaseReservation(reservation.requestId);
  }
});

test('reserveQuota rejects an invalid request lifetime without a reservation', () => {
  const user = createQuotaUser();

  assert.throws(
    () => reserveQuota(user, 1, 4, 0),
    (error) => error.status === 500 && error.message === 'Request lifetime is invalid'
  );
  const reservations = db.prepare(
    'SELECT COUNT(*) AS count FROM quota_reservations WHERE user_id = ?'
  ).get(user.id).count;
  assert.equal(reservations, 0);
});

test('recordUsage keeps the legacy success outcome when no result is supplied', () => {
  const fixture = createFixture();

  recordUsage(fixture.requestId, fixture.userId, fixture.model, 3, 2, 7);

  const rows = storedRows(fixture);
  assert.deepEqual(
    [rows.usage.input_tokens, rows.usage.output_tokens, rows.usage.total_tokens],
    [3, 2, 5]
  );
  assert.deepEqual(
    [rows.request.input_tokens, rows.request.output_tokens, rows.request.total_tokens],
    [3, 2, 5]
  );
  assert.equal(rows.request.status, 'success');
  assert.equal(rows.request.error_type, null);
  assert.equal(rows.request.response_time_ms, 7);
  assert.equal(rows.request.cost_configured, 1);
  assert.ok(Math.abs(rows.request.estimated_cost_usd - 0.000012) < 1e-12);
  assert.equal(rows.reservations, 0);
});

test('recordUsage accepts an explicit success outcome', () => {
  const fixture = createFixture();

  recordUsage(
    fixture.requestId,
    fixture.userId,
    fixture.model,
    1,
    1,
    9,
    { status: 'success', errorType: null }
  );

  const rows = storedRows(fixture);
  assert.equal(rows.request.status, 'success');
  assert.equal(rows.request.error_type, null);
  assert.equal(rows.reservations, 0);
});

test('recordUsage charges provider usage while recording a filter failure', () => {
  const fixture = createFixture();

  recordUsage(
    fixture.requestId,
    fixture.userId,
    fixture.model,
    4,
    2,
    11,
    { status: 'failure', errorType: 'filter' }
  );

  const rows = storedRows(fixture);
  assert.deepEqual(
    [rows.usage.input_tokens, rows.usage.output_tokens, rows.usage.total_tokens],
    [4, 2, 6]
  );
  assert.deepEqual(
    [rows.request.input_tokens, rows.request.output_tokens, rows.request.total_tokens],
    [4, 2, 6]
  );
  assert.equal(rows.request.status, 'failure');
  assert.equal(rows.request.error_type, 'filter');
  assert.equal(rows.request.response_time_ms, 11);
  assert.equal(rows.request.cost_configured, 1);
  assert.ok(Math.abs(rows.request.estimated_cost_usd - 0.000014) < 1e-12);
  assert.equal(rows.reservations, 0);
});

test('recordUsage rejects every outcome other than success/null and failure/filter', () => {
  for (const outcome of [
    { status: 'success', errorType: 'filter' },
    { status: 'failure', errorType: null },
    { status: 'failure', errorType: 'provider_http' }
  ]) {
    const fixture = createFixture();

    assert.throws(
      () => recordUsage(fixture.requestId, fixture.userId, fixture.model, 1, 1, 1, outcome),
      (error) => error.status === 500 && error.message === 'Usage outcome is invalid'
    );

    const rows = storedRows(fixture);
    assert.equal(rows.usage, undefined);
    assert.equal(rows.request, undefined);
    assert.equal(rows.reservations, 1);
  }
});

test('recordFailure preserves the filter error classification', () => {
  const fixture = createFixture();

  recordFailure(fixture.requestId, fixture.userId, fixture.model, 'filter', 13);

  const rows = storedRows(fixture);
  assert.equal(rows.usage, undefined);
  assert.equal(rows.request.status, 'failure');
  assert.equal(rows.request.error_type, 'filter');
  assert.deepEqual(
    [rows.request.input_tokens, rows.request.output_tokens, rows.request.total_tokens],
    [0, 0, 0]
  );
  assert.equal(rows.reservations, 0);
});

test('recordUsage rolls back usage, request log, and reservation deletion together', (t) => {
  const fixture = createFixture();
  db.exec(`
    CREATE TRIGGER fail_filter_usage_request_log
    BEFORE INSERT ON request_logs
    WHEN NEW.model_name = '${fixture.model.model_name}'
    BEGIN SELECT RAISE(ABORT, 'forced usage transaction failure'); END;
  `);
  t.after(() => db.exec('DROP TRIGGER IF EXISTS fail_filter_usage_request_log'));

  assert.throws(
    () => recordUsage(
      fixture.requestId,
      fixture.userId,
      fixture.model,
      4,
      2,
      17,
      { status: 'failure', errorType: 'filter' }
    ),
    /forced usage transaction failure/
  );

  const rows = storedRows(fixture);
  assert.equal(rows.usage, undefined);
  assert.equal(rows.request, undefined);
  assert.equal(rows.reservations, 1);
});
