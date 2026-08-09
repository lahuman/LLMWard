const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-migrations-'));
const adminKey = crypto.randomBytes(32).toString('base64url');
const openDatabases = new Set();

function databasePath(name) {
  return path.join(temporaryDirectory, `${name}.db`);
}

function migrate(file, options = {}) {
  const { forbidVacuum = false, failPostIntegrityCheck = false } = options;
  const observers = [
    forbidVacuum && "const exec=Database.prototype.exec;Database.prototype.exec=function(sql){if(/\\bVACUUM\\b/i.test(sql))throw new Error('VACUUM invoked');return exec.call(this,sql)};",
    failPostIntegrityCheck && "const pragma=Database.prototype.pragma;let integrityChecks=0;Database.prototype.pragma=function(sql,options){if(sql==='integrity_check'&&++integrityChecks===2)return [{integrity_check:'corrupt'}];return pragma.call(this,sql,options)};"
  ].filter(Boolean).join('');
  const script = observers
    ? `const Database=require('better-sqlite3');${observers}const {runMigrations}=require('./db/migrations');runMigrations();require('./db/database').close()`
    : "const {runMigrations}=require('./db/migrations');runMigrations();require('./db/database').close()";
  return spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: file, ADMIN_SECRET_KEY: adminKey, LOG_LEVEL: 'silent' }
  });
}
function open(file, options) {
  const database = new Database(file, options);
  openDatabases.add(database);
  return database;
}

function legacyUsers(database) {
  database.exec(`
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
}

function assertMigrated(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

after(() => {
  for (const database of openDatabases) {
    try { database.close(); } catch {}
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('empty database migrates to schema 2', () => {
  const file = databasePath('empty');
  assertMigrated(migrate(file));
  const database = open(file, { readonly: true });
  assert.equal(database.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all(), [
    'app_settings', 'audit_logs', 'backup_history', 'models', 'providers', 'quota_reservations',
    'request_logs', 'usage_logs', 'user_tokens', 'users'
  ]);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").pluck().all(), [
    'idx_audit_logs_created_at', 'idx_quota_reservations_user_date', 'idx_request_logs_created_at',
    'idx_request_logs_model_name', 'idx_request_logs_provider_id', 'idx_request_logs_status',
    'idx_request_logs_user_id', 'idx_user_tokens_active_hash', 'idx_user_tokens_user_id'
  ]);
  assert.equal(database.pragma('integrity_check')[0].integrity_check, 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  database.close();
});

test('legacy and partial schemas migrate without data loss', () => {
  const file = databasePath('legacy-partial');
  const legacy = open(file);
  legacyUsers(legacy);
  legacy.prepare('INSERT INTO users (id, username, api_token, created_at) VALUES (?, ?, ?, ?)').run(
    7, 'legacy-user', 'legacy-token-kept-off-disk', '2025-01-02T03:04:05.000Z'
  );
  legacy.close();

  assertMigrated(migrate(file));
  const database = open(file, { readonly: true });
  const user = database.prepare('SELECT * FROM users WHERE id = 7').get();
  const token = database.prepare('SELECT * FROM user_tokens WHERE user_id = 7').get();
  assert.equal(user.username, 'legacy-user');
  assert.equal(user.max_requests_per_minute, 60);
  assert.equal(user.max_concurrent_requests, 2);
  assert.equal(user.created_at, '2025-01-02T03:04:05.000Z');
  assert.equal(user.api_token, 'sha256:0ea8942f0663169dd69497241ac0e44b59dfae0233d8e22fd2a6c6c9b93dd45b');
  assert.equal(token.token_hash, '0ea8942f0663169dd69497241ac0e44b59dfae0233d8e22fd2a6c6c9b93dd45b');
  assert.equal(token.token_prefix, 'legacy-t');
  assert.equal(token.created_at, '2025-01-02T03:04:05.000Z');
  database.close();
});

test('migration is repeatable on an already-current database', () => {
  const file = databasePath('repeatable');
  const legacy = open(file);
  legacyUsers(legacy);
  legacy.prepare('INSERT INTO users (username, api_token, created_at) VALUES (?, ?, ?)').run(
    'repeatable-user', 'repeatable-token', '2025-01-02T03:04:05.000Z'
  );
  legacy.close();

  assertMigrated(migrate(file));
  assertMigrated(migrate(file));
  const database = open(file, { readonly: true });
  assert.equal(database.pragma('user_version', { simple: true }), 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM user_tokens').get().count, 1);
  assert.equal(database.prepare('SELECT api_token FROM users WHERE username = ?').pluck().get('repeatable-user'),
    'sha256:e2b387d319648f1ad7ed6608b2ad03580652fd49794407a83d5184a6f3a58636');
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all(), [
    'app_settings', 'audit_logs', 'backup_history', 'models', 'providers', 'quota_reservations',
    'request_logs', 'usage_logs', 'user_tokens', 'users'
  ]);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").pluck().all(), [
    'idx_audit_logs_created_at', 'idx_quota_reservations_user_date', 'idx_request_logs_created_at',
    'idx_request_logs_model_name', 'idx_request_logs_provider_id', 'idx_request_logs_status',
    'idx_request_logs_user_id', 'idx_user_tokens_active_hash', 'idx_user_tokens_user_id'
  ]);
  database.close();
});

test('post-migration integrity failure rolls back changes', () => {
  const file = databasePath('post-integrity-failure');
  const result = migrate(file, { failPostIntegrityCheck: true });
  assert.notEqual(result.status, 0);
  const database = open(file, { readonly: true });
  assert.equal(database.pragma('user_version', { simple: true }), 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().count, 0);
  database.close();
});
test('future schema is rejected without mutation', () => {
  const file = databasePath('future');
  const database = open(file);
  database.exec('CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sentinel VALUES (1, \'keep\'); PRAGMA user_version = 3;');
  database.close();

  const result = migrate(file);
  assert.notEqual(result.status, 0);
  const checked = open(file, { readonly: true });
  assert.equal(checked.pragma('user_version', { simple: true }), 3);
  assert.equal(checked.prepare('SELECT value FROM sentinel WHERE id = 1').pluck().get(), 'keep');
  assert.equal(checked.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().count, 0);
  checked.close();
});

test('foreign-key-invalid schema is rejected before mutation', () => {
  const file = databasePath('foreign-key-invalid');
  const database = open(file);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent(id));
    INSERT INTO child VALUES (99);
  `);
  database.close();

  const result = migrate(file);
  assert.notEqual(result.status, 0);
  const checked = open(file, { readonly: true });
  assert.equal(checked.pragma('user_version', { simple: true }), 0);
  assert.equal(checked.prepare('SELECT parent_id FROM child').pluck().get(), 99);
  assert.equal(checked.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().count, 0);
  checked.close();
});

test('orphaned legacy hash marker fails closed', () => {
  const file = databasePath('orphaned-marker');
  const database = open(file);
  legacyUsers(database);
  database.prepare('INSERT INTO users (username, api_token, created_at) VALUES (?, ?, ?)').run(
    'orphaned-marker-user', `sha256:${'a'.repeat(64)}`, '2025-01-02T03:04:05.000Z'
  );
  database.close();

  const result = migrate(file);
  assert.notEqual(result.status, 0);
  const checked = open(file, { readonly: true });
  assert.equal(checked.pragma('user_version', { simple: true }), 0);
  assert.equal(checked.prepare('SELECT api_token FROM users WHERE username = ?').pluck().get('orphaned-marker-user'), `sha256:${'a'.repeat(64)}`);
  assert.equal(checked.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'user_tokens'").get().count, 0);
  checked.close();
});

test('legacy plaintext is absent from database and WAL after repeated migration', () => {
  const file = databasePath('redacted');
  const token = crypto.randomBytes(32).toString('base64url');
  const legacy = open(file);
  legacyUsers(legacy);
  legacy.prepare('INSERT INTO users (username, api_token, created_at) VALUES (?, ?, ?)').run(
    'redacted-user', token, '2025-01-02T03:04:05.000Z'
  );
  legacy.close();

  assertMigrated(migrate(file));
  assertMigrated(migrate(file));
  const database = open(file, { readonly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM user_tokens').get().count, 1);
  database.close();
  assert.equal(fs.readFileSync(file).includes(Buffer.from(token)), false);
  if (fs.existsSync(`${file}-wal`)) {
    assert.equal(fs.readFileSync(`${file}-wal`).includes(Buffer.from(token)), false);
  }
});

test('startup migration does not invoke VACUUM', () => {
  const file = databasePath('no-vacuum');
  const legacy = open(file);
  legacyUsers(legacy);
  legacy.prepare('INSERT INTO users (username, api_token, created_at) VALUES (?, ?, ?)').run(
    'vacuum-observer-user', 'vacuum-observer-token', '2025-01-02T03:04:05.000Z'
  );
  legacy.close();

  assertMigrated(migrate(file, { forbidVacuum: true }));
});
