const crypto = require('crypto');
const db = require('./database');
const {
  SCHEMA_VERSION,
  CONTENT_FILTER_SCHEMA_VERSION,
  assertContentFilterSchema,
  assertContentFilterSchemaAbsent
} = require('./schema');

const REQUIRED_COLUMNS = {
  users: [
    'id', 'username', 'api_token', 'max_daily_input_tokens', 'max_daily_output_tokens',
    'is_active', 'allowed_models', 'created_at', 'max_requests_per_minute',
    'max_concurrent_requests'
  ],
  providers: [
    'id', 'provider_name', 'display_name', 'base_url', 'auth_type', 'api_key_env_name',
    'stored_api_key', 'is_active', 'last_health_check', 'health_status',
    'last_health_latency_ms', 'created_at', 'max_concurrent_requests'
  ],
  models: [
    'id', 'model_name', 'display_name', 'model_type', 'provider_id', 'is_active',
    'max_tokens', 'input_cost_per_million', 'output_cost_per_million', 'model_config',
    'context_window', 'default_temperature', 'default_top_p', 'default_presence_penalty',
    'default_frequency_penalty', 'default_seed',
    'created_at', 'max_concurrent_requests'
  ],
  usage_logs: ['id', 'user_id', 'request_date', 'input_tokens', 'output_tokens', 'total_tokens'],
  content_filters: [
    'id', 'name', 'patterns', 'input_action', 'output_action', 'is_active', 'is_global',
    'created_at', 'updated_at'
  ],
  content_filter_models: ['filter_id', 'model_id'],
  request_logs: [
    'id', 'user_id', 'model_name', 'provider_id', 'input_tokens', 'output_tokens',
    'total_tokens', 'status', 'error_type', 'response_time_ms', 'estimated_cost_usd',
    'cost_configured', 'created_at'
  ],
  quota_reservations: ['request_id', 'user_id', 'request_date', 'output_tokens', 'expires_at'],
  user_tokens: [
    'id', 'user_id', 'name', 'token_prefix', 'token_hash', 'created_at', 'expires_at',
    'last_used_at', 'revoked_at', 'is_active'
  ],
  audit_logs: ['id', 'action', 'target_type', 'target_id', 'success', 'changed_fields', 'created_at'],
  app_settings: ['setting_key', 'setting_value', 'updated_at'],
  backup_history: ['id', 'filename', 'schema_version', 'created_at', 'integrity_status']
};

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function addMissingColumns(table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function assertRequiredColumns() {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    const missing = required.filter((name) => !existing.has(name));
    if (missing.length) {
      throw new Error(`Database table ${table} is missing required columns: ${missing.join(', ')}`);
    }
  }
}

function assertForeignKeys(stage) {
  if (db.pragma('foreign_key_check').length) {
    throw new Error(`Database foreign key check failed ${stage} migrations`);
  }
}

function legacyCreatedAt(value) {
  if (typeof value !== 'string' || !value) {
    throw new Error('Legacy user data contains an invalid created_at value');
  }
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error('Legacy user data contains an invalid created_at value');
  }
  return parsed.toISOString();
}

function assertLegacyUsers() {
  const invalid = db.prepare(`
    SELECT 1 FROM users
    WHERE username IS NULL OR trim(username) = ''
       OR api_token IS NULL OR api_token = ''
       OR typeof(max_daily_input_tokens) != 'integer' OR max_daily_input_tokens < 0
       OR typeof(max_daily_output_tokens) != 'integer' OR max_daily_output_tokens < 0
       OR typeof(max_requests_per_minute) != 'integer' OR max_requests_per_minute <= 0
       OR typeof(max_concurrent_requests) != 'integer' OR max_concurrent_requests <= 0
       OR is_active NOT IN (0, 1)
       OR created_at IS NULL
    LIMIT 1
  `).get();
  if (invalid) throw new Error('Legacy user data contains invalid or NULL required values');
}

function runMigrations() {
  const integrity = db.pragma('integrity_check')[0].integrity_check;
  if (integrity !== 'ok') throw new Error('Database integrity check failed; migrations were not started');

  const currentVersion = db.pragma('user_version', { simple: true });
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(`Database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}`);
  }
  assertForeignKeys('before');
  if (currentVersion < CONTENT_FILTER_SCHEMA_VERSION) {
    assertContentFilterSchemaAbsent(db);
  } else {
    assertContentFilterSchema(db);
  }

  const previousSecureDelete = db.pragma('secure_delete', { simple: true });
  db.pragma('secure_delete = ON');
  try {
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
        context_window INTEGER,
        default_temperature REAL,
        default_top_p REAL,
        default_presence_penalty REAL,
        default_frequency_penalty REAL,
        default_seed INTEGER,
        model_config TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(provider_id) REFERENCES providers(id)
      );
      CREATE TABLE IF NOT EXISTS content_filters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        patterns TEXT NOT NULL,
        input_action TEXT CHECK(input_action IN ('block', 'mask') OR input_action IS NULL),
        output_action TEXT CHECK(output_action = 'mask' OR output_action IS NULL),
        is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0, 1)),
        is_global INTEGER NOT NULL DEFAULT 0 CHECK(is_global IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(input_action IS NOT NULL OR output_action IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS content_filter_models (
        filter_id INTEGER NOT NULL,
        model_id INTEGER NOT NULL,
        PRIMARY KEY(filter_id, model_id),
        FOREIGN KEY(filter_id) REFERENCES content_filters(id) ON DELETE CASCADE,
        FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE
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
        max_concurrent_requests: 'INTEGER NOT NULL DEFAULT 4',
        context_window: 'INTEGER',
        default_temperature: 'REAL',
        default_top_p: 'REAL',
        default_presence_penalty: 'REAL',
        default_frequency_penalty: 'REAL',
        default_seed: 'INTEGER'
      });
      addMissingColumns('request_logs', {
        error_type: 'TEXT',
        response_time_ms: 'INTEGER NOT NULL DEFAULT 0',
        estimated_cost_usd: 'REAL',
        cost_configured: 'INTEGER NOT NULL DEFAULT 0'
      });

      assertRequiredColumns();
      assertLegacyUsers();

      const findToken = db.prepare('SELECT 1 FROM user_tokens WHERE user_id = ? AND token_hash = ?');
      const insertToken = db.prepare(`
        INSERT INTO user_tokens
          (user_id, name, token_prefix, token_hash, created_at, is_active)
        VALUES (?, 'Migrated legacy token', ?, ?, ?, 1)
      `);
      const redactLegacy = db.prepare('UPDATE users SET api_token = ? WHERE id = ?');
      for (const user of db.prepare('SELECT id, api_token, created_at FROM users').all()) {
        const marker = /^sha256:([a-f0-9]{64})$/.exec(user.api_token);
        if (marker) {
          if (!findToken.get(user.id, marker[1])) {
            throw new Error('Legacy token hash marker has no matching token record');
          }
          continue;
        }

        const tokenHash = hashToken(user.api_token);
        if (!findToken.get(user.id, tokenHash)) {
          insertToken.run(user.id, user.api_token.slice(0, 8), tokenHash, legacyCreatedAt(user.created_at));
        }
        redactLegacy.run(`sha256:${tokenHash}`, user.id);
      }

      db.exec(`
      CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_request_logs_model_name ON request_logs(model_name);
      CREATE INDEX IF NOT EXISTS idx_request_logs_provider_id ON request_logs(provider_id);
      CREATE INDEX IF NOT EXISTS idx_content_filter_models_model_id ON content_filter_models(model_id);
      CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status);
      CREATE INDEX IF NOT EXISTS idx_quota_reservations_user_date ON quota_reservations(user_id, request_date);
      CREATE INDEX IF NOT EXISTS idx_user_tokens_user_id ON user_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_tokens_active_hash ON user_tokens(token_hash, is_active);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
      `);
      const postMigrationIntegrity = db.pragma('integrity_check')[0].integrity_check;
      assertContentFilterSchema(db);
      if (postMigrationIntegrity !== 'ok') {
        throw new Error('Database integrity check failed after migrations');
      }
      assertForeignKeys('after');
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }).immediate();

    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)')[0];
    if (checkpoint && checkpoint.busy) {
      throw new Error('Database WAL checkpoint could not complete after migrations');
    }
  } finally {
    db.pragma(`secure_delete = ${previousSecureDelete}`);
  }
}

module.exports = { runMigrations, hashToken, SCHEMA_VERSION };
