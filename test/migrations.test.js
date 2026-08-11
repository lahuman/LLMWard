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
  const { forbidVacuum = false, failPostIntegrityCheck = false, failPreflightCleanup = false, preflightControlPath } = options;
  const observers = [
    forbidVacuum && "const exec=Database.prototype.exec;Database.prototype.exec=function(sql){if(/\\bVACUUM\\b/i.test(sql))throw new Error('VACUUM invoked');return exec.call(this,sql)};",
    failPostIntegrityCheck && "const pragma=Database.prototype.pragma;let integrityChecks=0;Database.prototype.pragma=function(sql,options){if(sql==='integrity_check'&&++integrityChecks===2)return [{integrity_check:'corrupt'}];return pragma.call(this,sql,options)};",
    failPreflightCleanup && "const fs=require('node:fs');const path=require('node:path');const rmSync=fs.rmSync;const mkdtempSync=fs.mkdtempSync;const isPreflight=(target)=>path.basename(target).startsWith('.llmward-schema-preflight-');fs.mkdtempSync=function(prefix,options){const directory=mkdtempSync.call(this,prefix,options);if(isPreflight(prefix)){try{fs.writeFileSync(process.env.PREFLIGHT_CONTROL_PATH,directory,{flag:'wx',mode:0o600})}catch(error){rmSync.call(fs,directory,{recursive:true,force:true});throw error}}return directory};fs.rmSync=function(target,options){if(isPreflight(target))throw new Error('private-cleanup-marker');return rmSync.call(this,target,options)};"
  ].filter(Boolean).join('');
  const script = observers
    ? `const Database=require('better-sqlite3');${observers}const {runMigrations}=require('./db/migrations');runMigrations();require('./db/database').close()`
    : "const {runMigrations}=require('./db/migrations');runMigrations();require('./db/database').close()";
  return spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_PATH: file,
      ADMIN_SECRET_KEY: adminKey,
      LOG_LEVEL: 'silent',
      ...(preflightControlPath ? { PREFLIGHT_CONTROL_PATH: preflightControlPath } : {})
    }
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

function createDirtyFutureWal(file) {
  const script = `
    const Database = require('better-sqlite3');
    const database = new Database(process.env.DATABASE_PATH);
    if (database.pragma('journal_mode = WAL', { simple: true }) !== 'wal') process.exit(2);
    database.pragma('wal_autocheckpoint = 0');
    database.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sentinel VALUES (1, 'keep'); PRAGMA user_version = 3;");
    if (database.pragma('wal_checkpoint(TRUNCATE)')[0].busy !== 0) process.exit(3);
    database.exec("UPDATE sentinel SET value = 'future' WHERE id = 1; PRAGMA user_version = 4;");
    if (database.pragma('user_version', { simple: true }) !== 4) process.exit(4);
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root, encoding: 'utf8', env: { ...process.env, DATABASE_PATH: file }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(file).readUInt32BE(60) <= 3, true);
  assert.equal(fs.statSync(`${file}-wal`).size > 0, true);
  assert.equal(fs.existsSync(`${file}-shm`), true);
}

after(() => {
  for (const database of openDatabases) {
    try { database.close(); } catch {}
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('empty database migrates to schema 3', () => {
  const file = databasePath('empty');
  assertMigrated(migrate(file));
  const database = open(file, { readonly: true });
  assert.equal(database.pragma('user_version', { simple: true }), 3);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all(), [
    'app_settings', 'audit_logs', 'backup_history', 'content_filter_models', 'content_filters', 'models', 'providers', 'quota_reservations',
    'request_logs', 'usage_logs', 'user_tokens', 'users'
  ]);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").pluck().all(), [
    'idx_audit_logs_created_at', 'idx_content_filter_models_model_id', 'idx_quota_reservations_user_date', 'idx_request_logs_created_at',
    'idx_request_logs_model_name', 'idx_request_logs_provider_id', 'idx_request_logs_status',
    'idx_request_logs_user_id', 'idx_user_tokens_active_hash', 'idx_user_tokens_user_id'
  ]);
  assert.equal(database.pragma('integrity_check')[0].integrity_check, 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  database.close();
});

test('existing zero-length database initializes to schema 3 without sidecars', () => {
  const file = databasePath('zero-length');
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
  assert.equal(fs.statSync(file).size, 0);
  assert.deepEqual(['-wal', '-shm', '-journal'].map((suffix) => fs.existsSync(`${file}${suffix}`)), [false, false, false]);

  assertMigrated(migrate(file));

  const database = open(file, { readonly: true });
  assert.equal(database.pragma('user_version', { simple: true }), 3);
  assert.equal(database.pragma('integrity_check')[0].integrity_check, 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  database.close();
});

test('existing zero-length database with any SQLite sidecar fails closed', () => {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const name = suffix.slice(1);
    const file = databasePath(`zero-length-with-${name}`);
    const sidecar = `${file}${suffix}`;
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
    fs.closeSync(fs.openSync(sidecar, 'wx', 0o600));

    const result = migrate(file);

    assert.notEqual(result.status, 0);
    assert.equal(`${result.stdout}${result.stderr}`.includes('Database schema preflight failed'), true);
    assert.equal(fs.statSync(file).size, 0);
    assert.equal(fs.statSync(sidecar).size, 0);
    for (const otherSuffix of ['-wal', '-shm', '-journal']) {
      assert.equal(fs.existsSync(`${file}${otherSuffix}`), otherSuffix === suffix);
    }
  }
});

test('missing database with any orphaned SQLite sidecar fails closed without mutation', () => {
  const suffixes = ['-wal', '-shm', '-journal'];
  for (const suffix of suffixes) {
    const name = suffix.slice(1);
    const file = databasePath(`missing-with-${name}`);
    const sidecar = `${file}${suffix}`;
    const privateBytes = Buffer.from(crypto.randomBytes(32).toString('base64url'));
    fs.writeFileSync(sidecar, privateBytes, { flag: 'wx', mode: 0o600 });
    assert.equal(fs.existsSync(file), false);

    const result = migrate(file);
    const output = `${result.stdout}${result.stderr}`;
    const sidecarExists = fs.existsSync(sidecar);

    assert.deepEqual({
      failed: result.status !== 0,
      genericFailure: output.includes('Database schema preflight failed'),
      pathPrivate: !output.includes(file) && !output.includes(sidecar),
      contentPrivate: !output.includes(privateBytes.toString()),
      mainAbsent: !fs.existsSync(file),
      sidecarUnchanged: sidecarExists && fs.readFileSync(sidecar).equals(privateBytes),
      sidecarsPresent: suffixes.map((candidate) => fs.existsSync(`${file}${candidate}`))
    }, {
      failed: true,
      genericFailure: true,
      pathPrivate: true,
      contentPrivate: true,
      mainAbsent: true,
      sidecarUnchanged: true,
      sidecarsPresent: suffixes.map((candidate) => candidate === suffix)
    });
  }
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
  assert.equal(database.pragma('user_version', { simple: true }), 3);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'content_filters'").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'content_filter_models'").get().count, 1);
  database.close();
});

test('version 2 schema upgrades to version 3 without losing model data', () => {
  const file = databasePath('version-two');
  assertMigrated(migrate(file));
  const versionTwo = open(file);
  versionTwo.exec(`
    DROP INDEX idx_content_filter_models_model_id;
    DROP TABLE content_filter_models;
    DROP TABLE content_filters;
    PRAGMA user_version = 2;
  `);
  versionTwo.prepare(`
    INSERT INTO models (model_name, display_name) VALUES ('v2-model', 'Version two model')
  `).run();
  versionTwo.close();

  assertMigrated(migrate(file));
  const database = open(file, { readonly: true });
  assert.equal(database.pragma('user_version', { simple: true }), 3);
  assert.deepEqual(database.prepare(`
    SELECT model_name, display_name FROM models WHERE model_name = 'v2-model'
  `).get(), { model_name: 'v2-model', display_name: 'Version two model' });
  assert.deepEqual(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('content_filters', 'content_filter_models')
    ORDER BY name
  `).pluck().all(), ['content_filter_models', 'content_filters']);
  database.close();
});

test('version 2 with a preexisting exact active filter table fails before adoption', () => {
  const file = databasePath('version-two-preexisting-content-filter');
  assertMigrated(migrate(file));
  const versionTwo = open(file);
  versionTwo.exec("DROP INDEX idx_content_filter_models_model_id; DROP TABLE content_filter_models; INSERT INTO content_filters (name, patterns, input_action, is_active, created_at, updated_at) VALUES ('keep-active', '[]', 'block', 1, '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z'); PRAGMA user_version = 2;");
  versionTwo.close();

  const result = migrate(file);

  assert.notEqual(result.status, 0);
  const checked = open(file, { readonly: true });
  assert.equal(checked.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(
    checked.prepare('SELECT name, patterns, input_action, is_active FROM content_filters').get(),
    { name: 'keep-active', patterns: '[]', input_action: 'block', is_active: 1 }
  );
  assert.deepEqual(checked.prepare(
    "SELECT type, name FROM sqlite_master WHERE name IN ('content_filter_models', 'idx_content_filter_models_model_id') ORDER BY name"
  ).all(), []);
  checked.close();
});

test('version 2 partial content filter schema with missing constraints fails closed', () => {
  const file = databasePath('version-two-partial-content-filters');
  assertMigrated(migrate(file));
  const partial = open(file);
  partial.exec(`
    DROP INDEX idx_content_filter_models_model_id;
    DROP TABLE content_filter_models;
    DROP TABLE content_filters;

    CREATE TABLE content_filters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      patterns TEXT NOT NULL,
      input_action TEXT,
      output_action TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      is_global INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE content_filter_models (
      filter_id INTEGER NOT NULL,
      model_id INTEGER NOT NULL
    );

    INSERT INTO content_filters
      (id, name, patterns, input_action, output_action, is_active, is_global, created_at, updated_at)
    VALUES
      (7, 'partial-filter', '[]', NULL, NULL, 2, 2, '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z');
    INSERT INTO content_filter_models (filter_id, model_id) VALUES (7, 999);
    PRAGMA user_version = 2;
  `);
  partial.close();

  const result = migrate(file);

  assert.notEqual(result.status, 0);
  const checked = open(file, { readonly: true });
  assert.equal(checked.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(checked.prepare(`
    SELECT id, name, patterns, input_action, output_action, is_active, is_global
    FROM content_filters
  `).get(), {
    id: 7, name: 'partial-filter', patterns: '[]', input_action: null, output_action: null,
    is_active: 2, is_global: 2
  });
  assert.deepEqual(checked.prepare('SELECT filter_id, model_id FROM content_filter_models').get(), {
    filter_id: 7, model_id: 999
  });
  checked.close();
});

test('version 2 content filter schema with uppercase action literals fails closed', () => {
  const file = databasePath('version-two-uppercase-content-filter-actions');
  assertMigrated(migrate(file));
  const partial = open(file);
  partial.exec(`
    DROP INDEX idx_content_filter_models_model_id;
    DROP TABLE content_filter_models;
    DROP TABLE content_filters;

    CREATE TABLE content_filters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      patterns TEXT NOT NULL,
      input_action TEXT CHECK(input_action IN ('BLOCK', 'MASK') OR input_action IS NULL),
      output_action TEXT CHECK(output_action = 'MASK' OR output_action IS NULL),
      is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0, 1)),
      is_global INTEGER NOT NULL DEFAULT 0 CHECK(is_global IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(input_action IS NOT NULL OR output_action IS NOT NULL)
    );

    CREATE TABLE content_filter_models (
      filter_id INTEGER NOT NULL,
      model_id INTEGER NOT NULL,
      PRIMARY KEY(filter_id, model_id),
      FOREIGN KEY(filter_id) REFERENCES content_filters(id) ON DELETE CASCADE,
      FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE
    );

    INSERT INTO content_filters
      (name, patterns, input_action, created_at, updated_at)
    VALUES
      ('uppercase-action', '[]', 'BLOCK', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z');
    PRAGMA user_version = 2;
  `);
  partial.close();

  const result = migrate(file);

  assert.notEqual(result.status, 0);
  const checked = open(file, { readonly: true });
  assert.equal(checked.pragma('user_version', { simple: true }), 2);
  assert.equal(checked.prepare('SELECT input_action FROM content_filters').pluck().get(), 'BLOCK');
  checked.close();
});

test('version 2 content filter model index on the wrong column fails closed', () => {
  const file = databasePath('version-two-wrong-content-filter-model-index');
  assertMigrated(migrate(file));
  const partial = open(file);
  partial.exec(`
    DROP INDEX idx_content_filter_models_model_id;
    CREATE INDEX idx_content_filter_models_model_id ON content_filter_models(filter_id);
    PRAGMA user_version = 2;
  `);
  partial.close();

  const result = migrate(file);

  assert.notEqual(result.status, 0);
  const checked = open(file, { readonly: true });
  assert.equal(checked.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(
    checked.prepare("SELECT name FROM pragma_index_info('idx_content_filter_models_model_id') ORDER BY seqno").pluck().all(),
    ['filter_id']
  );
  checked.close();
});

test('content filter tables enforce actions, flags, and cascading model assignments', () => {
  const file = databasePath('content-filter-schema');
  assertMigrated(migrate(file));
  const database = open(file);
  assert.deepEqual(
    database.prepare('SELECT name, type, "notnull" AS is_not_null, pk FROM pragma_table_info(\'content_filters\')').all(),
    [
      { name: 'id', type: 'INTEGER', is_not_null: 0, pk: 1 },
      { name: 'name', type: 'TEXT', is_not_null: 1, pk: 0 },
      { name: 'patterns', type: 'TEXT', is_not_null: 1, pk: 0 },
      { name: 'input_action', type: 'TEXT', is_not_null: 0, pk: 0 },
      { name: 'output_action', type: 'TEXT', is_not_null: 0, pk: 0 },
      { name: 'is_active', type: 'INTEGER', is_not_null: 1, pk: 0 },
      { name: 'is_global', type: 'INTEGER', is_not_null: 1, pk: 0 },
      { name: 'created_at', type: 'TEXT', is_not_null: 1, pk: 0 },
      { name: 'updated_at', type: 'TEXT', is_not_null: 1, pk: 0 }
    ]
  );
  const insertFilter = database.prepare(`
    INSERT INTO content_filters (name, patterns, input_action, output_action, created_at, updated_at)
    VALUES (?, ?, ?, ?, '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z')
  `);
  const filterId = Number(insertFilter.run('sensitive-input', '["secret"]', 'block', null).lastInsertRowid);
  assert.deepEqual(database.prepare('SELECT is_active, is_global FROM content_filters WHERE id = ?').get(filterId), {
    is_active: 0,
    is_global: 0
  });
  assert.throws(() => insertFilter.run('no-action', '["secret"]', null, null), /CHECK constraint failed/);
  assert.throws(() => insertFilter.run('bad-input', '["secret"]', 'allow', null), /CHECK constraint failed/);
  assert.throws(() => insertFilter.run('bad-output', '["secret"]', null, 'block'), /CHECK constraint failed/);
  assert.throws(() => database.prepare(`
    INSERT INTO content_filters (name, patterns, input_action, is_active, created_at, updated_at)
    VALUES ('bad-active', '["secret"]', 'block', 2, '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z')
  `).run(), /CHECK constraint failed/);
  assert.throws(() => database.prepare(`
    INSERT INTO content_filters (name, patterns, input_action, is_global, created_at, updated_at)
    VALUES ('bad-global', '["secret"]', 'block', 2, '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z')
  `).run(), /CHECK constraint failed/);
  assert.throws(() => insertFilter.run('sensitive-input', '["other"]', 'mask', null), /UNIQUE constraint failed/);

  const modelId = Number(database.prepare(`
    INSERT INTO models (model_name, display_name) VALUES ('filter-model', 'Filter model')
  `).run().lastInsertRowid);
  database.prepare('INSERT INTO content_filter_models (filter_id, model_id) VALUES (?, ?)').run(filterId, modelId);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_content_filter_models_model_id'").pluck().all(), [
    'idx_content_filter_models_model_id'
  ]);
  database.prepare('DELETE FROM models WHERE id = ?').run(modelId);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_filter_models').get().count, 0);

  assert.deepEqual(
    database.prepare("SELECT name FROM pragma_index_info('idx_content_filter_models_model_id') ORDER BY seqno").pluck().all(),
    ['model_id']
  );
  const secondModelId = Number(database.prepare(`
    INSERT INTO models (model_name, display_name) VALUES ('second-filter-model', 'Second filter model')
  `).run().lastInsertRowid);
  database.prepare('INSERT INTO content_filter_models (filter_id, model_id) VALUES (?, ?)').run(filterId, secondModelId);
  database.prepare('DELETE FROM content_filters WHERE id = ?').run(filterId);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_filter_models').get().count, 0);
  database.close();
});


test('current schema missing the content filter join table or model index fails without repair', () => {
  const outcomes = [];
  for (const missing of ['join-table', 'model-index']) {
    const file = databasePath('current-missing-' + missing);
    assertMigrated(migrate(file));
    const malformed = open(file);
    malformed.prepare(
      "INSERT INTO content_filters (name, patterns, input_action, is_active, created_at, updated_at) VALUES (?, '[]', 'block', 1, '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z')"
    ).run('keep-' + missing);
    malformed.exec(missing === 'join-table'
      ? 'DROP TABLE content_filter_models'
      : 'DROP INDEX idx_content_filter_models_model_id');
    malformed.close();

    const result = migrate(file);
    const checked = open(file, { readonly: true });
    outcomes.push({
      missing,
      failed: result.status !== 0,
      schemaVersion: checked.pragma('user_version', { simple: true }),
      filter: checked.prepare(
        'SELECT name, patterns, input_action, is_active FROM content_filters'
      ).get(),
      joinTableExists: checked.prepare(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'content_filter_models'"
      ).pluck().get() === 1,
      modelIndexExists: checked.prepare(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_content_filter_models_model_id'"
      ).pluck().get() === 1
    });
    checked.close();
  }

  assert.deepEqual(outcomes, [
    {
      missing: 'join-table',
      failed: true,
      schemaVersion: 3,
      filter: { name: 'keep-join-table', patterns: '[]', input_action: 'block', is_active: 1 },
      joinTableExists: false,
      modelIndexExists: false
    },
    {
      missing: 'model-index',
      failed: true,
      schemaVersion: 3,
      filter: { name: 'keep-model-index', patterns: '[]', input_action: 'block', is_active: 1 },
      joinTableExists: true,
      modelIndexExists: false
    }
  ]);
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

  const current = open(file);
  const modelId = Number(current.prepare(`
    INSERT INTO models (model_name, display_name) VALUES ('current-model', 'Current model')
  `).run().lastInsertRowid);
  const filterId = Number(current.prepare(`
    INSERT INTO content_filters (name, patterns, output_action, created_at, updated_at)
    VALUES ('current-filter', '["current"]', 'mask', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z')
  `).run().lastInsertRowid);
  current.prepare('INSERT INTO content_filter_models (filter_id, model_id) VALUES (?, ?)').run(filterId, modelId);
  current.close();

  assertMigrated(migrate(file));
  assertMigrated(migrate(file));
  const database = open(file, { readonly: true });
  assert.equal(database.pragma('user_version', { simple: true }), 3);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM user_tokens').get().count, 1);
  assert.deepEqual(database.prepare(`
    SELECT filter_id, model_id FROM content_filter_models
  `).get(), { filter_id: filterId, model_id: modelId });
  assert.equal(database.prepare('SELECT api_token FROM users WHERE username = ?').pluck().get('repeatable-user'),
    'sha256:e2b387d319648f1ad7ed6608b2ad03580652fd49794407a83d5184a6f3a58636');
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all(), [
    'app_settings', 'audit_logs', 'backup_history', 'content_filter_models', 'content_filters', 'models', 'providers', 'quota_reservations',
    'request_logs', 'usage_logs', 'user_tokens', 'users'
  ]);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").pluck().all(), [
    'idx_audit_logs_created_at', 'idx_content_filter_models_model_id', 'idx_quota_reservations_user_date', 'idx_request_logs_created_at',
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
test('future v4 schema is rejected without mutation', () => {
  const file = databasePath('future');
  const database = open(file);
  database.exec('CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sentinel VALUES (1, \'keep\'); PRAGMA user_version = 4;');
  assert.equal(database.pragma('journal_mode', { simple: true }), 'delete');
  database.close();
  const bytesBefore = fs.readFileSync(file);
  const hashBefore = crypto.createHash('sha256').update(bytesBefore).digest('hex');

  const result = migrate(file);
  assert.notEqual(result.status, 0);
  const checked = open(file, { readonly: true });
  assert.equal(checked.pragma('user_version', { simple: true }), 4);
  assert.equal(checked.pragma('journal_mode', { simple: true }), 'delete');
  assert.equal(checked.prepare('SELECT value FROM sentinel WHERE id = 1').pluck().get(), 'keep');
  assert.equal(checked.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().count, 0);
  checked.close();
  const bytesAfter = fs.readFileSync(file);
  assert.deepEqual(bytesAfter, bytesBefore);
  assert.equal(crypto.createHash('sha256').update(bytesAfter).digest('hex'), hashBefore);
  assert.equal(fs.existsSync(`${file}-wal`), false);
  assert.equal(fs.existsSync(`${file}-shm`), false);
});

test('checkpointed WAL future schema is rejected without creating sidecars', () => {
  const file = databasePath('future-clean-wal');
  const database = open(file);
  assert.equal(database.pragma('journal_mode = WAL', { simple: true }), 'wal');
  database.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sentinel VALUES (1, 'keep'); PRAGMA user_version = 4;");
  assert.equal(database.pragma('wal_checkpoint(TRUNCATE)')[0].busy, 0);
  database.close();
  const bytesBefore = fs.readFileSync(file);
  const hashBefore = crypto.createHash('sha256').update(bytesBefore).digest('hex');
  assert.deepEqual([...bytesBefore.subarray(18, 20)], [2, 2]);
  assert.equal(bytesBefore.readUInt32BE(60), 4);
  assert.equal(fs.existsSync(`${file}-wal`), false);
  assert.equal(fs.existsSync(`${file}-shm`), false);

  const result = migrate(file);

  assert.notEqual(result.status, 0);
  const bytesAfter = fs.readFileSync(file);
  assert.equal(bytesAfter.equals(bytesBefore), true);
  assert.equal(crypto.createHash('sha256').update(bytesAfter).digest('hex'), hashBefore);
  assert.deepEqual([...bytesAfter.subarray(18, 20)], [2, 2]);
  assert.equal(fs.existsSync(`${file}-wal`), false);
  assert.equal(fs.existsSync(`${file}-shm`), false);
});

test('uncheckpointed WAL future schema is rejected without mutating database files', () => {
  const file = databasePath('future-dirty-wal');
  createDirtyFutureWal(file);
  const targets = [file, `${file}-wal`, `${file}-shm`];
  const before = targets.map((target) => fs.readFileSync(target));

  const result = migrate(file);

  assert.notEqual(result.status, 0);
  assert.deepEqual(targets.map((target) => fs.existsSync(target)), [true, true, true]);
  for (const [index, target] of targets.entries()) {
    assert.equal(fs.readFileSync(target).equals(before[index]), true);
  }
});

test('WAL schema preflight cleanup failure fails closed without private details', () => {
  const file = databasePath('future-cleanup-failure');
  const controlPath = `${file}.preflight-control`;
  createDirtyFutureWal(file);
  const targets = [file, `${file}-wal`, `${file}-shm`];
  const before = targets.map((target) => fs.readFileSync(target));
  let privateDirectory;
  let ownsPrivateDirectory = false;

  try {
    const result = migrate(file, { failPreflightCleanup: true, preflightControlPath: controlPath });
    if (fs.existsSync(controlPath)) privateDirectory = fs.readFileSync(controlPath, 'utf8');
    ownsPrivateDirectory = typeof privateDirectory === 'string'
      && path.dirname(path.resolve(privateDirectory)) === path.resolve(path.dirname(file))
      && path.basename(privateDirectory).startsWith('.llmward-schema-preflight-');

    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(output.includes('Database schema preflight failed'), true);
    assert.equal(output.includes('private-cleanup-marker'), false);
    assert.equal(ownsPrivateDirectory, true);
    assert.equal(output.includes(privateDirectory), false);
    assert.equal(fs.existsSync(path.join(privateDirectory, 'database.db')), true);
    assert.equal(fs.existsSync(path.join(privateDirectory, 'database.db-wal')), true);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(privateDirectory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(privateDirectory, 'database.db')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(privateDirectory, 'database.db-wal')).mode & 0o777, 0o600);
    }
    for (const [index, target] of targets.entries()) {
      assert.equal(fs.readFileSync(target).equals(before[index]), true);
    }
  } finally {
    if (ownsPrivateDirectory) fs.rmSync(privateDirectory, { recursive: true, force: true });
    fs.rmSync(controlPath, { force: true });
  }
  assert.equal(privateDirectory === undefined || !fs.existsSync(privateDirectory), true);
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
