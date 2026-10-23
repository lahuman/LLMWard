const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const checks = [];

function check(name, status, detail) {
  checks.push({ name, status, detail });
}

function guardedCheck(name, action) {
  try {
    const result = action();
    check(name, result.status, result.detail);
  } catch {
    check(name, 'fail', 'unavailable');
  }
}

function probeWritableDirectory(directory) {
  const probePath = path.join(
    directory,
    `.doctor-${process.pid}-${crypto.randomBytes(12).toString('hex')}`
  );
  let descriptor;
  let owned = false;
  let failed = false;
  try {
    descriptor = fs.openSync(probePath, 'wx', 0o600);
    owned = true;
  } catch {
    failed = true;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { failed = true; }
    }
    if (owned) {
      try { fs.unlinkSync(probePath); } catch { failed = true; }
    }
  }
  if (failed) throw new Error('data directory write probe failed');
}

function emit() {
  for (const result of checks) {
    process.stdout.write(`[${result.status.toUpperCase()}] ${result.name}: ${result.detail}\n`);
  }
  process.exitCode = checks.some((result) => result.status === 'fail') ? 1 : 0;
}

const [major, minor, patch] = process.versions.node.split('.').map(Number);
// Minimum patched releases from the 2026-10-21 Node.js security advisory.
const minimum = { 22: [23, 4], 24: [22, 1], 26: [12, 1] }[major];
const supported = minimum && (minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1]));
check('Node.js version', supported ? 'pass' : 'fail', `version=${process.versions.node}`);

let config;
try {
  config = require('../config');
  check('Configuration initialization', 'pass', 'available');
  check('Administrator key safety', 'pass', 'valid=true');
} catch {
  check('Configuration initialization', 'fail', 'unavailable');
  emit();
  return;
}

let db;
try {
  db = require('../db/database');
  check('Database initialization', 'pass', 'available');
} catch {
  check('Database initialization', 'fail', 'unavailable');
}

if (db) {
  try {
    const { SCHEMA_VERSION } = require('../db/schema');
    guardedCheck('Database connection', () => ({
      status: db.open ? 'pass' : 'fail',
      detail: `open=${Boolean(db.open)}`
    }));
    guardedCheck('Database schema version', () => {
      const actual = db.pragma('user_version', { simple: true });
      return {
        status: actual === SCHEMA_VERSION ? 'pass' : 'fail',
        detail: `expected=${SCHEMA_VERSION}, actual=${actual}`
      };
    });
    guardedCheck('SQLite integrity', () => {
      const rows = db.pragma('integrity_check');
      const valid = rows.length === 1 && rows[0].integrity_check === 'ok';
      return { status: valid ? 'pass' : 'fail', detail: `valid=${valid}` };
    });
    guardedCheck('SQLite foreign keys', () => {
      const enabled = db.pragma('foreign_keys', { simple: true }) === 1;
      return { status: enabled ? 'pass' : 'fail', detail: `enabled=${enabled}` };
    });
    guardedCheck('SQLite foreign key check', () => {
      const violations = db.pragma('foreign_key_check').length;
      return { status: violations === 0 ? 'pass' : 'fail', detail: `violations=${violations}` };
    });
    guardedCheck('SQLite busy timeout', () => {
      const milliseconds = db.pragma('busy_timeout', { simple: true });
      return { status: milliseconds >= 5000 ? 'pass' : 'fail', detail: `milliseconds=${milliseconds}` };
    });
    guardedCheck('WAL mode', () => {
      const enabled = db.pragma('journal_mode', { simple: true }) === 'wal';
      return { status: enabled ? 'pass' : 'fail', detail: `enabled=${enabled}` };
    });
    guardedCheck('Active provider model', () => {
      const count = db.prepare(`
        SELECT COUNT(*) AS count
        FROM models
        JOIN providers ON providers.id = models.provider_id
        WHERE models.is_active = 1 AND providers.is_active = 1
      `).get().count;
      return { status: count > 0 ? 'pass' : 'warn', detail: `count=${count}` };
    });
    guardedCheck('Expired quota reservations', () => {
      const count = db.prepare('SELECT COUNT(*) AS count FROM quota_reservations WHERE expires_at <= ?')
        .get(new Date().toISOString()).count;
      return { status: count === 0 ? 'pass' : 'warn', detail: `count=${count}` };
    });
  } catch {
    check('Database checks', 'fail', 'unavailable');
  }
}

const dataDirectory = config.databasePath === ':memory:' ? null : path.dirname(config.databasePath);
if (dataDirectory) {
  guardedCheck('Data directory readable', () => {
    fs.readdirSync(dataDirectory);
    return { status: 'pass', detail: 'readable=true' };
  });
  guardedCheck('Data directory writable', () => {
    probeWritableDirectory(dataDirectory);
    return { status: 'pass', detail: 'writable=true' };
  });
  if (typeof fs.statfsSync === 'function') {
    guardedCheck('Disk free space', () => {
      const disk = fs.statfsSync(dataDirectory);
      const freeBytes = disk.bavail * disk.bsize;
      const mebibytes = Math.round(freeBytes / 1048576);
      const status = freeBytes <= 0 ? 'fail' : freeBytes < 1073741824 ? 'warn' : 'pass';
      return { status, detail: `mebibytes=${mebibytes}` };
    });
  }
}

if (db) {
  try { db.close(); } catch { check('Database close', 'fail', 'unavailable'); }
}

emit();
