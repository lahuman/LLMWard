const Database = require('better-sqlite3');
const { SCHEMA_VERSION, assertContentFilterSchema } = require('./schema');

function verifyDatabase(filePath) {
  let database;
  try {
    database = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = database.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('Database integrity check failed');
    }
    if (database.pragma('foreign_key_check').length !== 0) {
      throw new Error('Database foreign key check failed');
    }
    const schemaVersion = database.pragma('user_version', { simple: true });
    if (schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`Database schema version ${schemaVersion} is not supported`);
    }
    assertContentFilterSchema(database);
    return { integrity: 'ok', schemaVersion };
  } finally {
    if (database && database.open) database.close();
  }
}

module.exports = { verifyDatabase };
