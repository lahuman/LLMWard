const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const { SCHEMA_VERSION } = require('./schema');

function assertSupportedSchema(database) {
  const version = database.pragma('user_version', { simple: true });
  if (version > SCHEMA_VERSION) {
    throw new Error(`Database schema version ${version} is newer than supported version ${SCHEMA_VERSION}`);
  }
}

if (config.databasePath !== ':memory:' && fs.existsSync(config.databasePath)) {
  let preflight;
  try {
    preflight = new Database(config.databasePath, { readonly: true, fileMustExist: true });
    assertSupportedSchema(preflight);
  } finally {
    if (preflight && preflight.open) preflight.close();
  }
}

if (config.databasePath !== ':memory:') {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
}

let db;
try {
  db = new Database(config.databasePath);
  assertSupportedSchema(db);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
} catch (error) {
  if (db && db.open) {
    try { db.close(); } catch {}
  }
  throw error;
}

module.exports = db;
