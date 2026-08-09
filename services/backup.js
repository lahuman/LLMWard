const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const db = require('../db/database');
const config = require('../config');
const { SCHEMA_VERSION } = require('../db/schema');
const { verifyDatabase } = require('../db/verify');
const { audit } = require('./audit');

function recordHistory(database, filename, createdAt) {
  database.prepare(`
    INSERT INTO backup_history (filename, schema_version, created_at, integrity_status)
    VALUES (?, ?, ?, 'ok')
  `).run(filename, SCHEMA_VERSION, createdAt);
}

async function createBackup() {
  let temporaryPath;
  let destination;
  let ownsTemporary = false;
  let ownsDestination = false;
  try {
    if (config.databasePath === ':memory:') throw new Error('In-memory databases cannot be backed up');
    const directory = path.join(path.dirname(config.databasePath), 'backups');
    fs.mkdirSync(directory, { recursive: true });
    const createdAt = new Date().toISOString();
    const attemptId = crypto.randomUUID();
    const filename = `gateway-${createdAt.replace(/[:.]/g, '-')}-${attemptId}.db`;
    destination = path.join(directory, filename);
    temporaryPath = path.join(directory, `.${filename}.${crypto.randomUUID()}.tmp`);

    let descriptor;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      ownsTemporary = true;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }

    await db.backup(temporaryPath);
    let backup;
    let artifactError;
    try {
      backup = new Database(temporaryPath, { fileMustExist: true });
      recordHistory(backup, filename, createdAt);
      const checkpoint = backup.pragma('wal_checkpoint(TRUNCATE)')[0];
      if (checkpoint && checkpoint.busy) {
        throw new Error('Backup WAL checkpoint could not complete');
      }
      if (backup.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
        throw new Error('Backup journal could not be finalized');
      }
    } catch (error) {
      artifactError = error;
      throw error;
    } finally {
      if (backup && backup.open) {
        try {
          backup.close();
        } catch (closeError) {
          if (artifactError) artifactError.cleanupIncomplete = true;
          else {
            closeError.cleanupIncomplete = true;
            throw closeError;
          }
        }
      }
    }

    for (const sidecar of [`${temporaryPath}-wal`, `${temporaryPath}-shm`]) {
      try { fs.unlinkSync(sidecar); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    const verification = verifyDatabase(temporaryPath);
    fs.linkSync(temporaryPath, destination);
    ownsDestination = true;
    fs.unlinkSync(temporaryPath);
    ownsTemporary = false;

    db.transaction(() => {
      recordHistory(db, filename, createdAt);
      audit('backup.create', 'database', null, true, []);
    }).immediate();

    return {
      filename,
      created_at: createdAt,
      schema_version: verification.schemaVersion,
      integrity: verification.integrity
    };
  } catch (error) {
    const ownedFiles = [];
    if (ownsTemporary && temporaryPath) {
      ownedFiles.push(temporaryPath, `${temporaryPath}-wal`, `${temporaryPath}-shm`);
    }
    if (ownsDestination && destination) ownedFiles.push(destination);

    let cleanupIncomplete = error.cleanupIncomplete === true;
    for (const ownedFile of ownedFiles) {
      try {
        fs.unlinkSync(ownedFile);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') cleanupIncomplete = true;
      }
    }
    if (cleanupIncomplete) error.cleanupIncomplete = true;

    try {
      audit('backup.create', 'database', null, false, cleanupIncomplete ? ['cleanupIncomplete'] : []);
    } catch {
      error.failureAuditFailed = true;
    }
    throw error;
  }
}

module.exports = { createBackup };
