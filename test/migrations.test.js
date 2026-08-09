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
    database.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sentinel VALUES (1, 'keep'); PRAGMA user_version = 2;");
    if (database.pragma('wal_checkpoint(TRUNCATE)')[0].busy !== 0) process.exit(3);
    database.exec("UPDATE sentinel SET value = 'future' WHERE id = 1; PRAGMA user_version = 3;");
    if (database.pragma('user_version', { simple: true }) !== 3) process.exit(4);
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root, encoding: 'utf8', env: { ...process.env, DATABASE_PATH: file }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(file).readUInt32BE(60) <= 2, true);
  assert.equal(fs.statSync(`${file}-wal`).size > 0, true);
  assert.equal(fs.existsSync(`${file}-shm`), true);
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

test('existing zero-length database initializes to schema 2 without sidecars', () => {
  const file = databasePath('zero-length');
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
  assert.equal(fs.statSync(file).size, 0);
  assert.deepEqual(['-wal', '-shm', '-journal'].map((suffix) => fs.existsSync(`${file}${suffix}`)), [false, false, false]);

  assertMigrated(migrate(file));

  const database = open(file, { readonly: true });
  assert.equal(database.pragma('user_version', { simple: true }), 2);
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
  assert.equal(database.pragma('journal_mode', { simple: true }), 'delete');
  database.close();
  const bytesBefore = fs.readFileSync(file);
  const hashBefore = crypto.createHash('sha256').update(bytesBefore).digest('hex');

  const result = migrate(file);
  assert.notEqual(result.status, 0);
  const checked = open(file, { readonly: true });
  assert.equal(checked.pragma('user_version', { simple: true }), 3);
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
  database.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sentinel VALUES (1, 'keep'); PRAGMA user_version = 3;");
  assert.equal(database.pragma('wal_checkpoint(TRUNCATE)')[0].busy, 0);
  database.close();
  const bytesBefore = fs.readFileSync(file);
  const hashBefore = crypto.createHash('sha256').update(bytesBefore).digest('hex');
  assert.deepEqual([...bytesBefore.subarray(18, 20)], [2, 2]);
  assert.equal(bytesBefore.readUInt32BE(60), 3);
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
