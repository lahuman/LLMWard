const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const { SCHEMA_VERSION } = require('./schema');

const SQLITE_HEADER_SIZE = 100;
const SQLITE_SIGNATURE = Buffer.from('SQLite format 3\0', 'ascii');
const SCHEMA_TOO_NEW = 'LLMWARD_SCHEMA_TOO_NEW';
const PREFLIGHT_FAILURE = 'Database schema preflight failed';

function preflightFailure() {
  return new Error(PREFLIGHT_FAILURE);
}

function assertSupportedVersion(version) {
  if (version > SCHEMA_VERSION) {
    const error = new Error(`Database schema version ${version} is newer than supported version ${SCHEMA_VERSION}`);
    error.code = SCHEMA_TOO_NEW;
    throw error;
  }
}

function assertSupportedSchema(database) {
  assertSupportedVersion(database.pragma('user_version', { simple: true }));
}

function readDatabaseHeader(databasePath) {
  let descriptor;
  let header;
  let failure;
  try {
    descriptor = fs.openSync(databasePath, fs.constants.O_RDONLY);
    header = Buffer.alloc(SQLITE_HEADER_SIZE);
    let offset = 0;
    while (offset < header.length) {
      const bytesRead = fs.readSync(descriptor, header, offset, header.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== header.length || !header.subarray(0, SQLITE_SIGNATURE.length).equals(SQLITE_SIGNATURE)) {
      failure = preflightFailure();
    }
  } catch {
    failure = preflightFailure();
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { failure = preflightFailure(); }
    }
  }
  if (failure) throw failure;
  return {
    version: header.readUInt32BE(60),
    usesWal: header[18] === 2 && header[19] === 2
  };
}

function privateWalPreflight(databasePath, walPath) {
  let temporaryDirectory;
  let privateDatabase;
  let failure;
  try {
    temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(databasePath), '.llmward-schema-preflight-'));
    if (process.platform !== 'win32') fs.chmodSync(temporaryDirectory, 0o700);
    const privatePath = path.join(temporaryDirectory, 'database.db');
    const privateWalPath = `${privatePath}-wal`;
    fs.copyFileSync(databasePath, privatePath, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(walPath, privateWalPath, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') {
      fs.chmodSync(privatePath, 0o600);
      fs.chmodSync(privateWalPath, 0o600);
    }
    privateDatabase = new Database(privatePath, { readonly: true, fileMustExist: true });
    assertSupportedSchema(privateDatabase);
  } catch (error) {
    failure = error && error.code === SCHEMA_TOO_NEW ? error : preflightFailure();
  } finally {
    if (privateDatabase && privateDatabase.open) {
      try { privateDatabase.close(); } catch { failure = preflightFailure(); }
    }
    if (temporaryDirectory) {
      try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); } catch { failure = preflightFailure(); }
    }
  }
  if (failure) throw failure;
}

function preflightExistingDatabase(databasePath) {
  const header = readDatabaseHeader(databasePath);
  assertSupportedVersion(header.version);
  if (!header.usesWal) return;

  const walPath = `${databasePath}-wal`;
  let wal;
  try {
    wal = fs.statSync(walPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw preflightFailure();
  }
  if (!wal.isFile()) throw preflightFailure();
  if (wal.size > 0) privateWalPreflight(databasePath, walPath);
}

function assertNoSqliteSidecars(databasePath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      fs.lstatSync(`${databasePath}${suffix}`);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
    }
    throw preflightFailure();
  }
}

function preflightZeroLengthDatabase(databasePath) {
  assertNoSqliteSidecars(databasePath);
  let target;
  try {
    target = fs.lstatSync(databasePath);
  } catch {
    throw preflightFailure();
  }
  if (!target.isFile()) throw preflightFailure();
  if (target.size > 0) return preflightExistingDatabase(databasePath);
  assertNoSqliteSidecars(databasePath);
}

if (config.databasePath !== ':memory:') {
  let target;
  try {
    target = fs.lstatSync(config.databasePath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw preflightFailure();
  }
  if (target) {
    if (!target.isFile()) throw preflightFailure();
    if (target.size === 0) {
      preflightZeroLengthDatabase(config.databasePath);
    } else {
      preflightExistingDatabase(config.databasePath);
    }
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
