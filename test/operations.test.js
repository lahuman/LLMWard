const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const repositoryRoot = path.join(__dirname, '..');
const doctorPath = path.join(repositoryRoot, 'scripts', 'doctor.js');

function environment(overrides) {
  return {
    ...process.env,
    LOG_LEVEL: 'silent',
    CORS_ORIGIN: 'http://127.0.0.1',
    ...overrides
  };
}

function initializeDatabase(databasePath, adminKey) {
  const result = spawnSync(process.execPath, ['-e', [
    "const db = require('./db/database');",
    "require('./db/migrations').runMigrations();",
    'db.close();'
  ].join(' ')], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment({ DATABASE_PATH: databasePath, ADMIN_SECRET_KEY: adminKey })
  });
  assert.equal(result.status, 0, result.stderr);
}

function runDoctor(databasePath, adminKey) {
  return spawnSync(process.execPath, [doctorPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment({ DATABASE_PATH: databasePath, ADMIN_SECRET_KEY: adminKey })
  });
}

function assertPrefixedOutput(result) {
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.notEqual(lines.length, 0);
  for (const line of lines) assert.match(line, /^\[(PASS|WARN|FAIL)\] /);
  assert.equal(result.stderr, '');
}

test('doctor reports current database safety checks without exposing keys', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-operations-'));
  const databasePath = path.join(temporaryDirectory, 'gateway.db');
  const adminKey = `admin-${crypto.randomBytes(32).toString('base64url')}`;
  const providerKey = `provider-${crypto.randomBytes(32).toString('base64url')}`;
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  initializeDatabase(databasePath, adminKey);
  const db = new Database(databasePath);
  const provider = db.prepare(`
    INSERT INTO providers (provider_name, display_name, base_url, auth_type, stored_api_key, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run('operations-provider', 'Operations provider', 'https://provider.invalid/v1', 'bearer', providerKey);
  db.prepare(`
    INSERT INTO models (model_name, display_name, model_type, provider_id, is_active)
    VALUES (?, ?, ?, ?, 1)
  `).run('operations-model', 'Operations model', 'chat', provider.lastInsertRowid);
  db.close();

  const result = runDoctor(databasePath, adminKey);

  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout.includes(adminKey), false);
  assert.equal(result.stdout.includes(providerKey), false);
  for (const name of [
    'Administrator key safety', 'Database connection', 'Database schema version',
    'SQLite integrity', 'SQLite foreign keys', 'SQLite foreign key check',
    'SQLite busy timeout', 'WAL mode', 'Data directory readable',
    'Data directory writable'
  ]) assert.ok(result.stdout.includes(name), `missing check: ${name}`);
  assertPrefixedOutput(result);
});

test('doctor warns without failing for missing active configuration and expired reservations', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-operations-warn-'));
  const databasePath = path.join(temporaryDirectory, 'gateway.db');
  const adminKey = `admin-${crypto.randomBytes(32).toString('base64url')}`;
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  initializeDatabase(databasePath, adminKey);
  const db = new Database(databasePath);
  const user = db.prepare('INSERT INTO users (username, api_token) VALUES (?, ?)')
    .run('operations-user', `sha256:${crypto.randomBytes(32).toString('hex')}`);
  db.prepare(`
    INSERT INTO quota_reservations (request_id, user_id, request_date, output_tokens, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('expired-operation', user.lastInsertRowid, '2000-01-01', 1, '2000-01-01T00:00:00.000Z');
  db.close();

  const result = runDoctor(databasePath, adminKey);

  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^\[WARN\] Active provider model:/m);
  assert.match(result.stdout, /^\[WARN\] Expired quota reservations:/m);
  assertPrefixedOutput(result);
});

test('doctor prefixes initialization failures and does not print exception details', () => {
  const marker = `unsafe-${crypto.randomBytes(12).toString('hex')}`;
  const result = runDoctor(path.join(os.tmpdir(), marker, 'gateway.db'), marker);

  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes(marker), false);
  assert.match(result.stdout, /^\[FAIL\] Configuration initialization: unavailable$/m);
  assertPrefixedOutput(result);
});

test('CI uses read-only contents permission, Node 22, install, test, and production audit', () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /^permissions:\r?\n  contents: read\s*$/m);
  assert.match(workflow, /^\s+- uses: actions\/checkout@v4\s*$/m);
  assert.match(workflow, /^\s+- uses: actions\/setup-node@v4\s*$/m);
  assert.match(workflow, /^\s+node-version: 22\s*$/m);
  assert.match(workflow, /^\s+cache: npm\s*$/m);
  for (const command of ['npm ci', 'npm test', 'npm audit --omit=dev']) {
    assert.match(workflow, new RegExp(`^\\s+- run: ${command.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`, 'm'));
  }
});

test('container artifacts use Node 22 and a single hardened gateway service', () => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM node:22-bookworm-slim\s*$/m);
  assert.match(dockerfile, /^USER node\s*$/m);
  assert.match(dockerfile, /^VOLUME \["\/app\/data"\]\s*$/m);
  assert.match(dockerfile, /^HEALTHCHECK\s+/m);

  const compose = fs.readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8');
  const serviceBlock = compose.match(/^services:\s*\r?\n([\s\S]*)$/m)?.[1] || '';
  assert.deepEqual([...serviceBlock.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)].map((match) => match[1]), ['gateway']);
  assert.equal((compose.match(/^\s+- .*:\/app\/data\s*$/gm) || []).length, 1);
  assert.match(compose, /^\s+restart: \S+\s*$/m);
  assert.match(compose, /^\s+cap_drop:\s*\r?\n\s+- ALL\s*$/m);
  assert.match(compose, /^\s+security_opt:\s*\r?\n\s+- no-new-privileges:true\s*$/m);
  assert.doesNotMatch(compose, /^\s+(read_only|tmpfs):/m);
});
