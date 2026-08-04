const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');
const { SCHEMA_VERSION } = require('../db/migrations');
const { retentionDays } = require('../services/retention');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, status: ok ? 'ok' : 'fail', detail });
}

const major = Number(process.versions.node.split('.')[0]);
check('Node.js version', major >= 20, `major=${major}`);
check('Required environment', Boolean(config.adminKey), 'ADMIN_SECRET_KEY configured');
check('Administrator key safety', config.adminKey.length >= 32 && new Set(config.adminKey).size >= 8, 'length and entropy checks');
check('Database connection', db.open, 'open');
check('Database schema version', db.pragma('user_version', { simple: true }) === SCHEMA_VERSION, `expected=${SCHEMA_VERSION}, actual=${db.pragma('user_version', { simple: true })}`);
check('SQLite integrity', db.pragma('integrity_check')[0].integrity_check === 'ok', db.pragma('integrity_check')[0].integrity_check);
check('WAL mode', db.pragma('journal_mode', { simple: true }) === 'wal', db.pragma('journal_mode', { simple: true }));

const dataDirectory = config.databasePath === ':memory:' ? null : path.dirname(config.databasePath);
if (dataDirectory) {
  try {
    fs.accessSync(dataDirectory, fs.constants.W_OK);
    check('Data directory writable', true, 'writable');
  } catch { check('Data directory writable', false, 'not writable'); }
  if (typeof fs.statfsSync === 'function') {
    const disk = fs.statfsSync(dataDirectory);
    check('Disk free space', disk.bavail > 0, `${Math.floor((disk.bavail * disk.bsize) / 1048576)} MiB free`);
  }
}

const providers = db.prepare('SELECT COUNT(*) AS count FROM providers WHERE is_active = 1').get().count;
const models = db.prepare('SELECT COUNT(*) AS count FROM models WHERE is_active = 1').get().count;
check('Active providers and models', providers > 0 && models > 0, `providers=${providers}, models=${models}`);
const expired = db.prepare('SELECT COUNT(*) AS count FROM quota_reservations WHERE expires_at <= ?').get(new Date().toISOString()).count;
check('Expired quota reservations', expired === 0, `expired=${expired}`);
check('Request log retention', true, `days=${retentionDays()} (0 disables cleanup)`);

for (const result of checks) process.stdout.write(`[${result.status.toUpperCase()}] ${result.name}: ${result.detail}\n`);
process.exitCode = checks.some((result) => result.status === 'fail') ? 1 : 0;
