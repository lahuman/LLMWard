const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

if (config.databasePath !== ':memory:') {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
}

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

module.exports = db;
