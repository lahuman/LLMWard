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
const environmentMarker = '8675309';

function environment(overrides) {
  return {
    ...process.env,
    LOG_LEVEL: 'silent',
    CORS_ORIGIN: 'http://127.0.0.1',
    REQUEST_LOG_RETENTION_DAYS: environmentMarker,
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
  assert.equal(result.status, 0);
}

function runDoctor(databasePath, adminKey, options = {}) {
  const args = options.preloadPath ? ['--require', options.preloadPath, doctorPath] : [doctorPath];
  return spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment({
      DATABASE_PATH: databasePath,
      ADMIN_SECRET_KEY: adminKey,
      ...(options.environment || {})
    })
  });
}

function writePreload(directory, name, source) {
  const preloadPath = path.join(directory, name);
  fs.writeFileSync(preloadPath, source, { mode: 0o600 });
  return preloadPath;
}

function assertPrivate(result, markers) {
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  for (const marker of [environmentMarker, ...markers]) assert.equal(output.includes(marker), false);
}

function assertPrefixedOutput(result) {
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.notEqual(lines.length, 0);
  for (const line of lines) assert.equal(/^\[(PASS|WARN|FAIL)\] /.test(line), true);
  assert.equal(result.stderr.length, 0);
}

function matchesDockerIgnore(pattern, candidate) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 2;
    } else if (pattern[index] === '*') {
      source += '[^/]*';
    } else {
      source += /[\\^$.*+?()[\]{}|]/.test(pattern[index]) ? `\\${pattern[index]}` : pattern[index];
    }
  }
  return new RegExp(`${source}$`).test(candidate);
}

test('doctor reports current database safety checks without exposing keys', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-operations-'));
  const databasePath = path.join(temporaryDirectory, 'gateway.db');
  const adminKey = `admin-${crypto.randomBytes(32).toString('base64url')}`;
  const providerKey = `provider-${crypto.randomBytes(32).toString('base64url')}`;
  const providerName = 'operations-provider-marker';
  const providerDisplay = 'Operations provider display marker';
  const providerBaseUrl = 'https://provider-marker.invalid/v1';
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  initializeDatabase(databasePath, adminKey);
  const db = new Database(databasePath);
  const provider = db.prepare(`
    INSERT INTO providers (provider_name, display_name, base_url, auth_type, stored_api_key, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(providerName, providerDisplay, providerBaseUrl, 'bearer', providerKey);
  db.prepare(`
    INSERT INTO models (model_name, display_name, model_type, provider_id, is_active)
    VALUES (?, ?, ?, ?, 1)
  `).run('operations-model', 'Operations model', 'chat', provider.lastInsertRowid);
  db.close();

  const result = runDoctor(databasePath, adminKey);

  assertPrivate(result, [adminKey, providerKey, providerName, providerDisplay, providerBaseUrl]);
  assert.equal(result.status, 0);
  for (const name of [
    'Node.js version', 'Configuration initialization', 'Administrator key safety',
    'Database initialization', 'Database connection', 'Database schema version',
    'SQLite integrity', 'SQLite foreign keys', 'SQLite foreign key check',
    'SQLite busy timeout', 'WAL mode', 'Active provider model',
    'Expired quota reservations', 'Data directory readable',
    'Data directory writable', 'Disk free space'
  ]) assert.equal(result.stdout.includes(`[PASS] ${name}:`), true);
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

  assertPrivate(result, [adminKey]);
  assert.equal(result.status, 0);
  assert.equal(/^\[WARN\] Active provider model:/m.test(result.stdout), true);
  assert.equal(/^\[WARN\] Expired quota reservations:/m.test(result.stdout), true);
  assertPrefixedOutput(result);
});

test('doctor prefixes initialization failures and does not print exception details', () => {
  const marker = `unsafe-${crypto.randomBytes(12).toString('hex')}`;
  const result = runDoctor(path.join(os.tmpdir(), marker, 'gateway.db'), marker);

  assertPrivate(result, [marker]);
  assert.equal(result.status, 1);
  assert.equal(/^\[FAIL\] Configuration initialization: unavailable$/m.test(result.stdout), true);
  assertPrefixedOutput(result);
});

test('doctor fails when the data directory cannot be read', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-operations-read-'));
  const databasePath = path.join(temporaryDirectory, 'gateway.db');
  const adminKey = `admin-${crypto.randomBytes(32).toString('base64url')}`;
  const failureMarker = `read-marker-${crypto.randomBytes(12).toString('hex')}`;
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  initializeDatabase(databasePath, adminKey);
  const preloadPath = writePreload(temporaryDirectory, 'fail-read.cjs', `
    const fs = require('node:fs');
    fs.readdirSync = function () {
      const error = new Error(process.env.DOCTOR_FAILURE_MARKER);
      error.code = 'EACCES';
      throw error;
    };
  `);

  const result = runDoctor(databasePath, adminKey, {
    preloadPath,
    environment: { DOCTOR_FAILURE_MARKER: failureMarker }
  });

  assertPrivate(result, [adminKey, failureMarker]);
  assert.equal(result.status, 1);
  assert.equal(/^\[FAIL\] Data directory readable: unavailable$/m.test(result.stdout), true);
  assertPrefixedOutput(result);
});

test('doctor fails when an exclusive data-directory write probe cannot open', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-operations-write-'));
  const databasePath = path.join(temporaryDirectory, 'gateway.db');
  const adminKey = `admin-${crypto.randomBytes(32).toString('base64url')}`;
  const failureMarker = `write-marker-${crypto.randomBytes(12).toString('hex')}`;
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  initializeDatabase(databasePath, adminKey);
  const preloadPath = writePreload(temporaryDirectory, 'fail-write.cjs', `
    const fs = require('node:fs');
    const openSync = fs.openSync;
    fs.openSync = function (file, flags, mode) {
      if (flags === 'wx' && mode === 0o600) {
        const error = new Error(process.env.DOCTOR_FAILURE_MARKER);
        error.code = 'EROFS';
        throw error;
      }
      return openSync.call(this, file, flags, mode);
    };
  `);

  const result = runDoctor(databasePath, adminKey, {
    preloadPath,
    environment: { DOCTOR_FAILURE_MARKER: failureMarker }
  });

  assertPrivate(result, [adminKey, failureMarker]);
  assert.equal(result.status, 1);
  assert.equal(/^\[FAIL\] Data directory writable: unavailable$/m.test(result.stdout), true);
  assertPrefixedOutput(result);
});

test('doctor warns without failing for low nonzero disk space', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-operations-disk-'));
  const databasePath = path.join(temporaryDirectory, 'gateway.db');
  const adminKey = `admin-${crypto.randomBytes(32).toString('base64url')}`;
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  initializeDatabase(databasePath, adminKey);
  const preloadPath = writePreload(temporaryDirectory, 'low-disk.cjs', `
    require('node:fs').statfsSync = () => ({ bavail: 1, bsize: 524288 });
  `);

  const result = runDoctor(databasePath, adminKey, { preloadPath });

  assertPrivate(result, [adminKey]);
  assert.equal(result.status, 0);
  assert.equal(/^\[WARN\] Disk free space:/m.test(result.stdout), true);
  assertPrefixedOutput(result);
});

test('doctor rejects vulnerable and unsupported Node versions at each security patch boundary', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-node-version-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [version, status] of [
    ['20.20.2', 'FAIL'], ['22.23.3', 'FAIL'], ['22.23.4', 'PASS'], ['22.24.0', 'PASS'],
    ['23.11.0', 'FAIL'], ['24.22.0', 'FAIL'], ['24.22.1', 'PASS'], ['24.23.0', 'PASS'],
    ['25.9.0', 'FAIL'], ['26.12.0', 'FAIL'], ['26.12.1', 'PASS'], ['26.13.0', 'PASS']
  ]) {
    const preloadPath = writePreload(directory, `${version}.cjs`,
      `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });`);
    // Invalid configuration exits before opening any database; only the runtime probe is exercised.
    const result = runDoctor(path.join(directory, 'unused.db'), 'invalid', { preloadPath });
    assert.equal(result.stdout.includes(`[${status}] Node.js version: version=${version}`), true, version);
    assert.equal(fs.existsSync(path.join(directory, 'unused.db')), false);
  }
});

test('CI uses read-only contents permission, patched Node 22, install, test, and production audit', () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /^permissions:\r?\n  contents: read\s*$/m);
  assert.match(workflow, /^\s+- uses: actions\/checkout@v4\s*$/m);
  assert.match(workflow, /^\s+- uses: actions\/setup-node@v4\s*$/m);
  assert.match(workflow, /^\s+node-version: 22\.23\.4\s*$/m);
  assert.match(workflow, /^\s+cache: npm\s*$/m);
  for (const command of ['npm ci', 'npm test', 'npm audit --omit=dev']) {
    assert.match(workflow, new RegExp(`^\\s+- run: ${command.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`, 'm'));
  }
});

test('package metadata requires patched supported Node releases', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));

  assert.equal(packageJson.engines.node, '^22.23.4 || ^24.22.1 || ^26.12.1');
  assert.equal(packageLock.packages[''].engines.node, packageJson.engines.node);
});

test('container artifacts use a supported Node 22 runtime and a single hardened gateway service', () => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM node:22\.23\.4-trixie-slim\s*$/m);
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

test('Docker installs native addon build prerequisites before production dependencies', () => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8')
    .replace(/\\\r?\n/g, ' ');
  const buildTools = dockerfile.indexOf('apt-get install -y --no-install-recommends python3 make g++');
  const productionDependencies = dockerfile.indexOf('npm ci --omit=dev');

  assert.notEqual(buildTools, -1);
  assert.equal(buildTools < productionDependencies, true);
  assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists\/\*/);
});

test('Docker build context excludes secrets, runtime data, and local artifacts', () => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');
  assert.equal((dockerfile.match(/^COPY \. \.\s*$/gm) || []).length, 1);

  const ignored = new Set(fs.readFileSync(path.join(repositoryRoot, '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith('#')));
  for (const entry of [
    'node_modules', '.git', 'data', '.env', '.env.*',
    'coverage', '.nyc_output', '*.db', '*.sqlite', '*.sqlite3',
    '*.db-wal', '*.db-shm', '*-wal', '*-shm', '*-journal', '*.bak', '*.backup', 'backups',
    '*.log', '*.out', '*.err', '*.mp4', 'npm-debug.log*',
    '.agents', '.codex', '.superpowers', '.idea', '.vscode',
    '**/node_modules', '**/.git', '**/data', '**/.env', '**/.env.*',
    '**/coverage', '**/.nyc_output', '**/*.db', '**/*.sqlite', '**/*.sqlite3',
    '**/*.db-wal', '**/*.db-shm', '**/*-wal', '**/*-shm', '**/*-journal', '**/*.bak', '**/*.backup',
    '**/backups', '**/*.log', '**/*.out', '**/*.err', '**/*.mp4', '**/npm-debug.log*',
    '**/.agents', '**/.codex', '**/.superpowers', '**/.idea', '**/.vscode'
  ]) {
    assert.equal(ignored.has(entry), true, `.dockerignore must exclude ${entry}`);
  }
  for (const candidate of [
    'gateway.sqlite', 'cache/gateway.sqlite',
    'gateway.sqlite3', 'cache/live.sqlite3',
    'gateway.db-journal', 'cache/gateway.db-journal',
    'gateway.sqlite-wal', 'cache/live.sqlite3-wal',
    'gateway.sqlite-shm', 'cache/live.sqlite3-shm',
    'gateway.bak', 'archive/gateway.bak',
    'gateway.backup', 'archive/gateway.backup'
  ]) {
    assert.equal([...ignored].some((pattern) => matchesDockerIgnore(pattern, candidate)), true,
      `.dockerignore must exclude representative artifact ${candidate}`);
  }
});
