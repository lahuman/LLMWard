const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../db/database');
const config = require('../config');
const { SCHEMA_VERSION } = require('../db/migrations');
const { audit } = require('./audit');

async function createBackup() {
  if (config.databasePath === ':memory:') throw new Error('In-memory databases cannot be backed up');
  const directory = path.join(path.dirname(config.databasePath), 'backups');
  fs.mkdirSync(directory, { recursive: true });
  const createdAt = new Date().toISOString();
  const filename = `gateway-${createdAt.replace(/[:.]/g, '-')}.db`;
  const destination = path.join(directory, filename);
  try {
    await db.backup(destination);
    const backup = new Database(destination);
    const integrity = backup.pragma('integrity_check')[0].integrity_check;
    if (integrity !== 'ok') throw new Error('Backup integrity check failed');
    backup.prepare(`
      INSERT INTO backup_history (filename, schema_version, created_at, integrity_status)
      VALUES (?, ?, ?, 'ok')
    `).run(filename, SCHEMA_VERSION, createdAt);
    backup.close();
    db.prepare(`
      INSERT INTO backup_history (filename, schema_version, created_at, integrity_status)
      VALUES (?, ?, ?, 'ok')
    `).run(filename, SCHEMA_VERSION, createdAt);
    audit('backup.create', 'database', null, true, []);
    return { filename, created_at: createdAt, schema_version: SCHEMA_VERSION, integrity: 'ok' };
  } catch (error) {
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    audit('backup.create', 'database', null, false, []);
    throw error;
  }
}

module.exports = { createBackup };
