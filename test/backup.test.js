const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { verifyDatabase } = require('../db/verify');

const root = path.join(__dirname, '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-backup-'));
const adminKey = crypto.randomBytes(32).toString('base64url');

function fixturePath(name) {
  return path.join(temporaryDirectory, name);
}

function child(script, databasePath, extraEnvironment = {}) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      ADMIN_SECRET_KEY: adminKey,
      LOG_LEVEL: 'silent',
      ...extraEnvironment
    }
  });
}

function createCurrentSchema(file) {
  const result = child(
    "const {runMigrations}=require('./db/migrations');runMigrations();require('./db/database').close()",
    file
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function createBackup(file) {
  const script = [
    "const {runMigrations}=require('./db/migrations')",
    "const db=require('./db/database')",
    "runMigrations()",
    "require('./services/backup').createBackup().then(result=>process.stdout.write(JSON.stringify(result))).catch(error=>{process.stderr.write(error.message);process.exitCode=1}).finally(()=>db.close())"
  ].join(';');
  const result = child(script, file);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

function historyCount(database) {
  return database.prepare('SELECT COUNT(*) AS count FROM backup_history').get().count;
}

function successAuditCount(database) {
  return database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'backup.create' AND success = 1").get().count;
}

after(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('verifyDatabase rejects corrupt SQLite', () => {
  const file = fixturePath('corrupt.db');
  fs.writeFileSync(file, Buffer.from('not a sqlite database'));

  assert.throws(() => verifyDatabase(file), /database|integrity/i);
});

test('verifyDatabase rejects foreign-key violations', () => {
  const file = fixturePath('foreign-key-invalid.db');
  createCurrentSchema(file);
  const fixture = new Database(file);
  fixture.pragma('foreign_keys = OFF');
  fixture.exec("INSERT INTO usage_logs (user_id, request_date) VALUES (999, '2001-01-01')");
  fixture.close();

  assert.throws(() => verifyDatabase(file), /foreign key/i);
});

test('verifyDatabase rejects non-current schema version', () => {
  const file = fixturePath('future.db');
  const fixture = new Database(file);
  fixture.pragma('user_version = 3');
  fixture.close();

  assert.throws(() => verifyDatabase(file), /schema version/i);
});

test('createBackup publishes only a fully verified artifact', () => {
  const livePath = fixturePath(path.join('successful', 'live.db'));
  createCurrentSchema(livePath);

  const result = createBackup(livePath);
  assert.equal(result.integrity, 'ok');
  assert.equal(result.schema_version, 2);
  assert.equal(typeof result.filename, 'string');
  assert.equal(typeof result.created_at, 'string');

  const backupPath = path.join(path.dirname(livePath), 'backups', result.filename);
  assert.equal(fs.existsSync(backupPath), true);
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  assert.deepEqual(backup.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  assert.deepEqual(backup.pragma('foreign_key_check'), []);
  assert.equal(backup.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(
    backup.prepare('SELECT filename, schema_version, created_at, integrity_status FROM backup_history').all(),
    [{
      filename: result.filename,
      schema_version: 2,
      created_at: result.created_at,
      integrity_status: 'ok'
    }]
  );
  backup.close();
  assert.deepEqual(
    fs.readdirSync(path.dirname(backupPath)), [result.filename]
  );

  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  assert.deepEqual(
    live.prepare('SELECT filename, schema_version, created_at, integrity_status FROM backup_history').all(),
    [{
      filename: result.filename,
      schema_version: 2,
      created_at: result.created_at,
      integrity_status: 'ok'
    }]
  );
  assert.equal(successAuditCount(live), 1);
  live.close();
});

test('verify-backup validates an independently copied restore without opening the live database', () => {
  const livePath = fixturePath(path.join('restore-source', 'live.db'));
  createCurrentSchema(livePath);
  const result = createBackup(livePath);
  const backupPath = path.join(path.dirname(livePath), 'backups', result.filename);
  const restoreCopyPath = fixturePath('independent-restore-copy.db');
  fs.copyFileSync(backupPath, restoreCopyPath);

  const liveBefore = new Database(livePath, { readonly: true, fileMustExist: true });
  const beforeHistory = historyCount(liveBefore);
  const beforeSuccessAudits = successAuditCount(liveBefore);
  liveBefore.close();
  const liveFiles = [livePath, `${livePath}-wal`, `${livePath}-shm`];
  const snapshot = () => liveFiles.map((file) => fs.existsSync(file)
    ? { size: fs.statSync(file).size, modified: fs.statSync(file).mtimeMs }
    : null);
  const filesBefore = snapshot();

  const verification = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-backup.js'), restoreCopyPath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: livePath }
  });
  assert.equal(verification.status, 0, verification.stdout + verification.stderr);
  assert.equal(verification.stdout, 'Backup verified: integrity=ok schema=2\n');
  assert.equal(verification.stderr, '');

  assert.deepEqual(snapshot(), filesBefore);
  const liveAfter = new Database(livePath, { readonly: true, fileMustExist: true });
  assert.equal(historyCount(liveAfter), beforeHistory);
  assert.equal(successAuditCount(liveAfter), beforeSuccessAudits);
  liveAfter.close();
});

test('verify-backup requires exactly one explicit path and does not create DATABASE_PATH', () => {
  const restoreCopyPath = fixturePath('cli-restore-copy.db');
  createCurrentSchema(restoreCopyPath);
  const sentinelPath = fixturePath('must-not-be-opened.db');
  const scriptPath = path.join(root, 'scripts', 'verify-backup.js');
  const environment = { ...process.env, DATABASE_PATH: sentinelPath };

  const missing = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8', env: environment });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /^Usage:/);

  const extra = spawnSync(process.execPath, [scriptPath, restoreCopyPath, 'extra.db'], {
    cwd: root, encoding: 'utf8', env: environment
  });
  assert.notEqual(extra.status, 0);
  assert.equal(extra.stdout, '');
  assert.match(extra.stderr, /^Usage:/);
  assert.equal(fs.existsSync(sentinelPath), false);
});

test('invalid backup artifact leaves no published file or success record', () => {
  const livePath = fixturePath(path.join('invalid-artifact', 'live.db'));
  createCurrentSchema(livePath);
  const script = [
    "const path=require('node:path')",
    "const Database=require('better-sqlite3')",
    "const db=require('./db/database')",
    "const original=Database.prototype.pragma",
    "Database.prototype.pragma=function(sql,options){if(sql==='integrity_check'&&this.readonly&&path.basename(this.name).startsWith('.'))return [{integrity_check:'invalid'}];return original.call(this,sql,options)}",
    "require('./services/backup').createBackup().then(()=>{process.stderr.write('unexpected success');process.exitCode=1}).catch(()=>process.stdout.write('rejected')).finally(()=>db.close())"
  ].join(';');
  const result = child(script, livePath);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, 'rejected');

  const backupDirectory = path.join(path.dirname(livePath), 'backups');
  assert.deepEqual(fs.readdirSync(backupDirectory), []);
  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  assert.equal(historyCount(live), 0);
  assert.equal(successAuditCount(live), 0);
  assert.equal(
    live.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'backup.create' AND success = 0").get().count,
    1
  );
  live.close();
});
