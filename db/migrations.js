const crypto = require('crypto');
const db = require('./database');

const SCHEMA_VERSION = 2;

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function addMissingColumns(table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function runMigrations() {
  const integrity = db.pragma('integrity_check')[0].integrity_check;
  if (integrity !== 'ok') throw new Error('Database integrity check failed; migrations were not started');

  let migratedLegacyTokens = 0;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        api_token TEXT UNIQUE NOT NULL,
        max_daily_input_tokens INTEGER NOT NULL DEFAULT 100000,
        max_daily_output_tokens INTEGER NOT NULL DEFAULT 50000,
        is_active INTEGER NOT NULL DEFAULT 1,
        allowed_models TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS providers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_name TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'api_key',
        api_key_env_name TEXT,
        stored_api_key TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_health_check TEXT,
        health_status TEXT NOT NULL DEFAULT 'unknown',
        last_health_latency_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_name TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        model_type TEXT NOT NULL DEFAULT 'chat',
        provider_id INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1,
        max_tokens INTEGER NOT NULL DEFAULT 4096,
        input_cost_per_million REAL,
        output_cost_per_million REAL,
        model_config TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(provider_id) REFERENCES providers(id)
      );

      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        request_date TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id),
        UNIQUE(user_id, request_date)
      );

      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        model_name TEXT NOT NULL,
        provider_id INTEGER,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'success',
        error_type TEXT,
        response_time_ms INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL,
        cost_configured INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS quota_reservations (
        request_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        request_date TEXT NOT NULL,
        output_tokens INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        success INTEGER NOT NULL,
        changed_fields TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS backup_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        integrity_status TEXT NOT NULL
      );
    `);

    addMissingColumns('users', {
      allowed_models: 'TEXT',
      max_requests_per_minute: 'INTEGER NOT NULL DEFAULT 60',
      max_concurrent_requests: 'INTEGER NOT NULL DEFAULT 2'
    });
    addMissingColumns('providers', {
      last_health_latency_ms: 'INTEGER',
      max_concurrent_requests: 'INTEGER NOT NULL DEFAULT 8'
    });
    addMissingColumns('models', {
      input_cost_per_million: 'REAL',
      output_cost_per_million: 'REAL',
      max_concurrent_requests: 'INTEGER NOT NULL DEFAULT 4'
    });
    addMissingColumns('request_logs', {
      error_type: 'TEXT',
      response_time_ms: 'INTEGER NOT NULL DEFAULT 0',
      estimated_cost_usd: 'REAL',
      cost_configured: 'INTEGER NOT NULL DEFAULT 0'
    });

    const insertToken = db.prepare(`
      INSERT OR IGNORE INTO user_tokens
        (user_id, name, token_prefix, token_hash, created_at, is_active)
      VALUES (?, 'Migrated legacy token', ?, ?, ?, 1)
    `);
    const redactLegacy = db.prepare('UPDATE users SET api_token = ? WHERE id = ?');
    for (const user of db.prepare('SELECT id, api_token, created_at FROM users').all()) {
      if (user.api_token.startsWith('sha256:')) continue;
      const tokenHash = hashToken(user.api_token);
      insertToken.run(user.id, user.api_token.slice(0, 8), tokenHash, new Date(user.created_at).toISOString());
      redactLegacy.run(`sha256:${tokenHash}`, user.id);
      migratedLegacyTokens += 1;
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_request_logs_model_name ON request_logs(model_name);
      CREATE INDEX IF NOT EXISTS idx_request_logs_provider_id ON request_logs(provider_id);
      CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status);
      CREATE INDEX IF NOT EXISTS idx_quota_reservations_user_date ON quota_reservations(user_id, request_date);
      CREATE INDEX IF NOT EXISTS idx_user_tokens_user_id ON user_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_tokens_active_hash ON user_tokens(token_hash, is_active);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    `);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }).immediate();
  if (migratedLegacyTokens > 0) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
  }
}

module.exports = { runMigrations, hashToken, SCHEMA_VERSION };
