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
  fixture.pragma('user_version = 5');
  fixture.close();

  assert.throws(() => verifyDatabase(file), /schema version/i);
});

test('verifyDatabase rejects current schema missing the content filter join table or model index', () => {
  for (const missing of ['join-table', 'model-index']) {
    const file = fixturePath('current-missing-' + missing + '.db');
    createCurrentSchema(file);
    const fixture = new Database(file);
    fixture.exec(missing === 'join-table'
      ? 'DROP TABLE content_filter_models'
      : 'DROP INDEX idx_content_filter_models_model_id');
    fixture.close();

    assert.throws(() => verifyDatabase(file), /content_filter|schema/i);
  }
});

test('createBackup publishes only a fully verified artifact', () => {
  const livePath = fixturePath(path.join('successful', 'live.db'));
  createCurrentSchema(livePath);

  const result = createBackup(livePath);
  assert.equal(result.integrity, 'ok');
  assert.equal(result.schema_version, 4);
  assert.equal(typeof result.filename, 'string');
  assert.equal(typeof result.created_at, 'string');

  const backupPath = path.join(path.dirname(livePath), 'backups', result.filename);
  assert.equal(fs.existsSync(backupPath), true);
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  assert.deepEqual(backup.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  assert.deepEqual(backup.pragma('foreign_key_check'), []);
  assert.equal(backup.pragma('user_version', { simple: true }), 4);
  assert.deepEqual(
    backup.prepare('SELECT filename, schema_version, created_at, integrity_status FROM backup_history').all(),
    [{
      filename: result.filename,
      schema_version: 4,
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
      schema_version: 4,
      created_at: result.created_at,
      integrity_status: 'ok'
    }]
  );
  assert.equal(successAuditCount(live), 1);
  live.close();
});

test('createBackup requests owner-only permissions for its artifact', () => {
  const livePath = fixturePath(path.join('owner-only', 'live.db'));
  createCurrentSchema(livePath);
  const script = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const db=require('./db/database')",
    "const originalOpen=fs.openSync",
    "let observedMode",
    "fs.openSync=function(file,flags,mode){if(flags==='wx'&&path.basename(file).startsWith('.'))observedMode=mode;return originalOpen.call(this,file,flags,mode)}",
    "require('./services/backup').createBackup().then(result=>process.stdout.write(JSON.stringify({filename:result.filename,observedMode}))).catch(error=>{process.stderr.write(error.message);process.exitCode=1}).finally(()=>db.close())"
  ].join(';');
  const result = child(script, livePath);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.observedMode, 0o600);

  if (process.platform !== 'win32') {
    const backupPath = path.join(path.dirname(livePath), 'backups', observed.filename);
    assert.equal(fs.statSync(backupPath).mode & 0o077, 0);
  }
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
  assert.equal(verification.stdout, 'Backup verified: integrity=ok schema=4\n');
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

test('backup initialization failure writes a sanitized failure audit', () => {
  const livePath = fixturePath(path.join('mkdir-failure', 'live.db'));
  createCurrentSchema(livePath);
  const script = [
    "const fs=require('node:fs')",
    "const db=require('./db/database')",
    "const originalMkdir=fs.mkdirSync",
    "fs.mkdirSync=function(directory,options){if(directory.endsWith('backups'))throw new Error('mkdir-primary-marker');return originalMkdir.call(this,directory,options)}",
    "require('./services/backup').createBackup().then(()=>{process.stderr.write('unexpected success');process.exitCode=1}).catch(error=>process.stdout.write(JSON.stringify({message:error.message,cleanupIncomplete:error.cleanupIncomplete===true,failureAuditFailed:error.failureAuditFailed===true}))).finally(()=>db.close())"
  ].join(';');
  const result = child(script, livePath);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    message: 'mkdir-primary-marker', cleanupIncomplete: false, failureAuditFailed: false
  });
  assert.equal(fs.existsSync(path.join(path.dirname(livePath), 'backups')), false);

  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  const history = historyCount(live);
  const successAudits = successAuditCount(live);
  const failure = live.prepare(`
    SELECT target_type, target_id, changed_fields FROM audit_logs
    WHERE action = 'backup.create' AND success = 0
  `).get();
  live.close();

  assert.equal(history, 0);
  assert.equal(successAudits, 0);
  assert.deepEqual(failure, { target_type: 'database', target_id: null, changed_fields: '[]' });
  assert.equal(JSON.stringify(failure).includes('mkdir-primary-marker'), false);
});

test('post-publication failure reports incomplete exact-final cleanup without masking the primary error', () => {
  const livePath = fixturePath(path.join('cleanup-failure', 'live.db'));
  createCurrentSchema(livePath);
  const script = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const db=require('./db/database')",
    "const originalPrepare=db.prepare.bind(db)",
    "db.prepare=function(sql){const statement=originalPrepare(sql);if(sql.includes('INSERT INTO audit_logs'))return{run(...args){if(args[3]===1)throw new Error('live-transaction-primary-marker');return statement.run(...args)}};return statement}",
    "const originalUnlink=fs.unlinkSync",
    "let cleanupAttempts=0",
    "fs.unlinkSync=function(file){if(!path.basename(file).startsWith('.')&&file.endsWith('.db')){cleanupAttempts++;const error=new Error('cleanup-path-must-not-escape');error.code='EPERM';throw error}return originalUnlink.call(this,file)}",
    "require('./services/backup').createBackup().then(()=>{process.stderr.write('unexpected success');process.exitCode=1}).catch(error=>process.stdout.write(JSON.stringify({message:error.message,cleanupIncomplete:error.cleanupIncomplete===true,failureAuditFailed:error.failureAuditFailed===true,cleanupAttempts}))).finally(()=>db.close())"
  ].join(';');
  const result = child(script, livePath);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    message: 'live-transaction-primary-marker',
    cleanupIncomplete: true,
    failureAuditFailed: false,
    cleanupAttempts: 1
  });

  const backupDirectory = path.join(path.dirname(livePath), 'backups');
  const remaining = fs.readdirSync(backupDirectory);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].startsWith('gateway-'), true);
  assert.deepEqual(verifyDatabase(path.join(backupDirectory, remaining[0])), { integrity: 'ok', schemaVersion: 4 });

  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  assert.equal(historyCount(live), 0);
  assert.equal(successAuditCount(live), 0);
  assert.deepEqual(
    live.prepare("SELECT changed_fields FROM audit_logs WHERE action = 'backup.create' AND success = 0").get(),
    { changed_fields: '[\"cleanupIncomplete\"]' }
  );
  live.close();
});

test('failure-audit errors are reported without masking the post-publication primary error', () => {
  const livePath = fixturePath(path.join('failure-audit-failure', 'live.db'));
  createCurrentSchema(livePath);
  const script = [
    "const db=require('./db/database')",
    "const originalPrepare=db.prepare.bind(db)",
    "db.prepare=function(sql){const statement=originalPrepare(sql);if(sql.includes('INSERT INTO audit_logs'))return{run(...args){if(args[3]===1)throw new Error('live-transaction-primary-marker');throw new Error('failure-audit-secondary-marker')}};return statement}",
    "require('./services/backup').createBackup().then(()=>{process.stderr.write('unexpected success');process.exitCode=1}).catch(error=>process.stdout.write(JSON.stringify({message:error.message,cleanupIncomplete:error.cleanupIncomplete===true,failureAuditFailed:error.failureAuditFailed===true}))).finally(()=>db.close())"
  ].join(';');
  const result = child(script, livePath);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    message: 'live-transaction-primary-marker', cleanupIncomplete: false, failureAuditFailed: true
  });
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(livePath), 'backups')), []);

  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  assert.equal(historyCount(live), 0);
  assert.equal(successAuditCount(live), 0);
  assert.equal(
    live.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'backup.create'").get().count,
    0
  );
  live.close();
});

test('backup publication never replaces an existing collision target', () => {
  const livePath = fixturePath(path.join('collision', 'live.db'));
  createCurrentSchema(livePath);
  const finalUuid = '11111111-1111-4111-8111-111111111111';
  const tempUuid = '22222222-2222-4222-8222-222222222222';
  const fixedTime = '2026-01-02T03:04:05.678Z';
  const filename = `gateway-2026-01-02T03-04-05-678Z-${finalUuid}.db`;
  const backupDirectory = path.join(path.dirname(livePath), 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const collisionPath = path.join(backupDirectory, filename);
  fs.writeFileSync(collisionPath, 'collision-target-must-survive');

  const script = [
    "const fs=require('node:fs')",
    "const crypto=require('node:crypto')",
    "const db=require('./db/database')",
    `const uuids=['${finalUuid}','${tempUuid}']`,
    "crypto.randomUUID=()=>uuids.shift()",
    `const fixedTime='${fixedTime}'`,
    "const OriginalDate=Date",
    "global.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[fixedTime]))}static now(){return new OriginalDate(fixedTime).valueOf()}}",
    "fs.renameSync=function(source,destination){fs.copyFileSync(source,destination);fs.unlinkSync(source)}",
    "require('./services/backup').createBackup().then(result=>process.stdout.write(JSON.stringify({ok:true,result}))).catch(error=>process.stdout.write(JSON.stringify({ok:false,code:error.code}))).finally(()=>db.close())"
  ].join(';');
  const result = child(script, livePath);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: 'EEXIST' });
  assert.equal(fs.readFileSync(collisionPath, 'utf8'), 'collision-target-must-survive');
  assert.deepEqual(fs.readdirSync(backupDirectory), [filename]);

  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  assert.equal(historyCount(live), 0);
  assert.equal(successAuditCount(live), 0);
  assert.equal(
    live.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'backup.create' AND success = 0").get().count,
    1
  );
  live.close();
});

test('writable artifact close failure preserves the body error and generic cleanup status', () => {
  const livePath = fixturePath(path.join('body-close-failure', 'live.db'));
  createCurrentSchema(livePath);
  const script = [
    "const path=require('node:path')",
    "const Database=require('better-sqlite3')",
    "const db=require('./db/database')",
    "const originalPragma=Database.prototype.pragma",
    "Database.prototype.pragma=function(sql,options){if(path.basename(this.name).startsWith('.')&&sql==='wal_checkpoint(TRUNCATE)')throw new Error('artifact-body-primary-marker');return originalPragma.call(this,sql,options)}",
    "const originalClose=Database.prototype.close",
    "Database.prototype.close=function(){const hidden=path.basename(this.name).startsWith('.');const result=originalClose.call(this);if(hidden)throw new Error('artifact-close-secondary-marker');return result}",
    "require('./services/backup').createBackup().then(()=>{process.stderr.write('unexpected success');process.exitCode=1}).catch(error=>process.stdout.write(JSON.stringify({message:error.message,cleanupIncomplete:error.cleanupIncomplete===true,failureAuditFailed:error.failureAuditFailed===true}))).finally(()=>db.close())"
  ].join(';');
  const result = child(script, livePath);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    message: 'artifact-body-primary-marker', cleanupIncomplete: true, failureAuditFailed: false
  });
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(livePath), 'backups')), []);

  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  const history = historyCount(live);
  const successAudits = successAuditCount(live);
  const failure = live.prepare(`
    SELECT target_type, target_id, changed_fields FROM audit_logs
    WHERE action = 'backup.create' AND success = 0
  `).get();
  live.close();
  assert.equal(history, 0);
  assert.equal(successAudits, 0);
  assert.deepEqual(failure, {
    target_type: 'database', target_id: null, changed_fields: '[\"cleanupIncomplete\"]'
  });
  const serializedFailure = JSON.stringify(failure);
  assert.equal(serializedFailure.includes('artifact-body-primary-marker'), false);
  assert.equal(serializedFailure.includes('artifact-close-secondary-marker'), false);
  assert.equal(serializedFailure.includes(temporaryDirectory), false);
});

test('writable artifact close-only failure is primary and marks cleanup incomplete', () => {
  const livePath = fixturePath(path.join('close-only-failure', 'live.db'));
  createCurrentSchema(livePath);
  const script = [
    "const path=require('node:path')",
    "const Database=require('better-sqlite3')",
    "const db=require('./db/database')",
    "const originalClose=Database.prototype.close",
    "Database.prototype.close=function(){const hidden=path.basename(this.name).startsWith('.');const result=originalClose.call(this);if(hidden)throw new Error('artifact-close-primary-marker');return result}",
    "require('./services/backup').createBackup().then(()=>{process.stderr.write('unexpected success');process.exitCode=1}).catch(error=>process.stdout.write(JSON.stringify({message:error.message,cleanupIncomplete:error.cleanupIncomplete===true,failureAuditFailed:error.failureAuditFailed===true}))).finally(()=>db.close())"
  ].join(';');
  const result = child(script, livePath);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    message: 'artifact-close-primary-marker', cleanupIncomplete: true, failureAuditFailed: false
  });
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(livePath), 'backups')), []);

  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  const failure = live.prepare(`
    SELECT changed_fields FROM audit_logs WHERE action = 'backup.create' AND success = 0
  `).get();
  live.close();
  assert.deepEqual(failure, { changed_fields: '[\"cleanupIncomplete\"]' });
});

test('temp unlink failure after link cleans both owned main names and preserves final sidecars', () => {
  const livePath = fixturePath(path.join('temp-unlink-failure', 'live.db'));
  createCurrentSchema(livePath);
  const finalUuid = '33333333-3333-4333-8333-333333333333';
  const tempUuid = '44444444-4444-4444-8444-444444444444';
  const fixedTime = '2026-02-03T04:05:06.789Z';
  const filename = `gateway-2026-02-03T04-05-06-789Z-${finalUuid}.db`;
  const backupDirectory = path.join(path.dirname(livePath), 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const finalWal = path.join(backupDirectory, `${filename}-wal`);
  const finalShm = path.join(backupDirectory, `${filename}-shm`);
  const sentinel = path.join(backupDirectory, 'unrelated-sentinel.txt');
  fs.writeFileSync(finalWal, 'final-wal-must-survive');
  fs.writeFileSync(finalShm, 'final-shm-must-survive');
  fs.writeFileSync(sentinel, 'unrelated-must-survive');

  const script = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const crypto=require('node:crypto')",
    "const db=require('./db/database')",
    `const filename='${filename}'`,
    `const uuids=['${finalUuid}','${tempUuid}']`,
    "crypto.randomUUID=()=>uuids.shift()",
    `const fixedTime='${fixedTime}'`,
    "const OriginalDate=Date",
    "global.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[fixedTime]))}static now(){return new OriginalDate(fixedTime).valueOf()}}",
    "const originalUnlink=fs.unlinkSync",
    "let tempMainAttempts=0",
    "let finalMainAttempts=0",
    "let finalSidecarAttempts=0",
    "fs.unlinkSync=function(file){const name=path.basename(file);if(name.startsWith('.')&&name.endsWith('.tmp')){tempMainAttempts++;if(tempMainAttempts===1){const error=new Error('temp-unlink-primary-marker');error.code='EBUSY';throw error}}if(name===filename)finalMainAttempts++;if(name===filename+'-wal'||name===filename+'-shm')finalSidecarAttempts++;return originalUnlink.call(this,file)}",
    "require('./services/backup').createBackup().then(()=>{process.stderr.write('unexpected success');process.exitCode=1}).catch(error=>process.stdout.write(JSON.stringify({message:error.message,cleanupIncomplete:error.cleanupIncomplete===true,failureAuditFailed:error.failureAuditFailed===true,tempMainAttempts,finalMainAttempts,finalSidecarAttempts}))).finally(()=>db.close())"
  ].join(';');
  const result = child(script, livePath);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    message: 'temp-unlink-primary-marker',
    cleanupIncomplete: false,
    failureAuditFailed: false,
    tempMainAttempts: 2,
    finalMainAttempts: 1,
    finalSidecarAttempts: 0
  });
  assert.deepEqual(fs.readdirSync(backupDirectory).sort(), [
    `${filename}-shm`, `${filename}-wal`, 'unrelated-sentinel.txt'
  ].sort());
  assert.equal(fs.readFileSync(finalWal, 'utf8'), 'final-wal-must-survive');
  assert.equal(fs.readFileSync(finalShm, 'utf8'), 'final-shm-must-survive');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unrelated-must-survive');

  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  const history = historyCount(live);
  const successAudits = successAuditCount(live);
  const failure = live.prepare(`
    SELECT changed_fields FROM audit_logs WHERE action = 'backup.create' AND success = 0
  `).get();
  live.close();
  assert.equal(history, 0);
  assert.equal(successAudits, 0);
  assert.deepEqual(failure, { changed_fields: '[]' });
});
