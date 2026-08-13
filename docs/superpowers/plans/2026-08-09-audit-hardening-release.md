# Audit Hardening Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close LLW-001 through LLW-008 with regression tests, preserve the single-process SQLite product boundary, and prepare a verified `1.0.1` release pull request.

**Architecture:** Keep the existing Express, CommonJS, and SQLite structure. Add only two side-effect-free database helpers for schema identity and backup verification; all other fixes stay in their current modules. Separate migration, backup, setup, server, and operations tests into focused files while leaving end-to-end Gateway behavior in `test/gateway.test.js`.

**Tech Stack:** Node.js 22+, CommonJS, `node:test`, Express 5, `better-sqlite3`, standard-library `fetch`/`AbortController`/`URL`, Docker Compose, GitHub Actions.

## Global Constraints

- Do not add runtime dependencies, external databases, Redis, telemetry, prompt storage, provider SDKs, generic conversion, fallback routing, or a plugin framework.
- Never persist or log prompts, responses, provider error bodies, raw user tokens, administrator keys, or provider credentials.
- Use prepared statements for values and preserve `foreign_keys = ON`, WAL, `busy_timeout = 5000`, transaction safety, and fail-closed behavior.
- Migration and backup tests use only explicit temporary SQLite files; never open or mutate `data/gateway.db`.
- Do not run automatic startup `VACUUM` or restore a backup over a live database.
- Keep `createBackup()`, `recordUsage(...)`, `hashToken(...)`, and existing HTTP response shapes backward-compatible.
- Maintain one non-root Docker service with exactly one persistent `/app/data` mount.
- Do not merge `main` or create `v1.0.1` until the release PR is reviewed.

## File Map

- Create `test/migrations.test.js`: isolated schema and legacy-token fixtures.
- Create `test/backup.test.js`: side-effect-free verifier, artifact publication, and restore-copy tests.
- Create `test/setup.test.js`: concurrent setup and existing-configuration preservation tests.
- Create `test/server.test.js`: process-level graceful shutdown test.
- Create `test/operations.test.js`: doctor, CI, Dockerfile, and Compose release guards.
- Create `db/schema.js`: sole side-effect-free owner of `SCHEMA_VERSION`.
- Create `db/verify.js`: readonly `verifyDatabase(filePath)` implementation.
- Create `scripts/verify-backup.js`: explicit-path verification CLI.
- Create `public/admin-dashboard.css` and `public/admin-dashboard.js`: mechanical extraction of existing inline assets.
- Create `.github/workflows/ci.yml`: minimal Node 22 release checks.
- Modify `db/migrations.js`, `services/usage.js`, `services/provider-router.js`, `routes/admin.js`, `routes/v1.js`, `server.js`, `services/backup.js`, `scripts/setup.js`, `scripts/doctor.js`, `app.js`, `public/admin-dashboard.html`, `Dockerfile`, `docker-compose.yml`, package metadata, release docs, and audit docs.

---

### Task 1: Fail-closed and repeatable SQLite migration

**Files:**
- Create: `test/migrations.test.js`
- Modify: `db/migrations.js:4-291`
- Modify: `docs/MIGRATIONS.md`

**Interfaces:**
- Consumes: `DATABASE_PATH` and `ADMIN_SECRET_KEY` set before requiring the database singleton.
- Produces: unchanged `runMigrations(): void`, `hashToken(token): string`, and `SCHEMA_VERSION = 2` exports.
- Guarantees: empty, legacy, partial, repeated, and already-current databases converge; future-version, foreign-key-invalid, and orphaned hash-marker databases fail without mutation.

- [ ] **Step 1: Add isolated migration fixtures and the failing marker test**

```javascript
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-migrations-'));
const adminKey = crypto.randomBytes(32).toString('base64url');

function migrate(databasePath) {
  return spawnSync(process.execPath, ['-e',
    "const {runMigrations}=require('./db/migrations');runMigrations();require('./db/database').close()"
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: databasePath, ADMIN_SECRET_KEY: adminKey, LOG_LEVEL: 'silent' }
  });
}

after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
```

Add tests named exactly:

- `empty database migrates to schema 2`: assert version 2, required tables/indexes, integrity `ok`, and zero FK rows.
- `legacy and partial schemas migrate without data loss`: omit additive columns, insert real rows, then assert preserved IDs/data/defaults and one correct token hash.
- `migration is repeatable on an already-current database`: migrate twice and assert stable version, table/index set, token count, and marker.
- `future schema is rejected without mutation`: create a sentinel row and `user_version = 3`; assert nonzero child status, version 3, sentinel retained, and no application tables added.
- `foreign-key-invalid schema is rejected before mutation`: create an orphan with foreign keys disabled; assert nonzero child status and unchanged version/data.
- `orphaned legacy hash marker fails closed`: create `users.api_token` as `sha256:` followed by 64 lowercase `a` characters without the matching `user_tokens` row; assert nonzero child status and unchanged marker/version.
- `legacy plaintext is absent from database and WAL after repeated migration`: assert token row count 1 and raw token bytes absent from DB/WAL after two runs.
- `startup migration source contains no VACUUM statement`: inspect only the migration source and assert no executable `VACUUM` token.

- [ ] **Step 2: Run the focused migration tests and capture the red result**

Run: `node --test test/migrations.test.js`

Expected: FAIL at `orphaned legacy hash marker fails closed` because the current WIP re-hashes the marker string when its token row is missing. Existing WIP protections may already make the future-version, FK, and no-VACUUM tests pass; record that distinction.

- [ ] **Step 3: Make orphaned hash markers fail before any write**

Change the token loop in `runMigrations()` to distinguish a valid migrated marker from plaintext:

```javascript
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
```

Keep the existing future-version, pre/post-FK, required-column, secure-delete, transaction, checkpoint, and no-`VACUUM` WIP changes. Do not introduce a migration framework for schema version 2.

- [ ] **Step 4: Run focused and existing migration coverage**

Run: `node --test test/migrations.test.js`

Expected: PASS, all fixture files removed by teardown.

Run: `node --test --test-name-pattern "database integrity|legacy plaintext" test/gateway.test.js`

Expected: PASS.

- [ ] **Step 5: Update migration policy and commit**

Document future-version/FK rejection, secure legacy redaction, repeated convergence, and the manual-only `VACUUM` policy in `docs/MIGRATIONS.md`.

```powershell
git add db/migrations.js test/migrations.test.js docs/MIGRATIONS.md
git commit -m "fix: harden SQLite migrations"
```

---

### Task 2: Charge usage to the quota reservation date

**Files:**
- Modify: `test/gateway.test.js:272-311`
- Modify: `services/usage.js:103-154`

**Interfaces:**
- Consumes: existing `quota_reservations.request_date`.
- Produces: unchanged `recordUsage(requestId, userId, model, inputTokens, outputTokens, durationMs): void`.

- [ ] **Step 1: Add the failing UTC-boundary regression**

```javascript
test('recordUsage applies tokens to the reservation UTC date', async () => {
  const user = await createUser('reservation-date-user', ['standard']);
  const model = db.prepare("SELECT * FROM models WHERE model_name = 'standard'").get();
  const { reserveQuota, recordUsage } = require('../services/usage');
  const reservation = reserveQuota(
    db.prepare('SELECT * FROM users WHERE id = ?').get(user.id),
    2,
    model.max_tokens
  );
  const reservedDate = '2001-02-03';
  db.prepare('UPDATE quota_reservations SET request_date = ? WHERE request_id = ?')
    .run(reservedDate, reservation.requestId);
  recordUsage(reservation.requestId, user.id, model, 2, 1, 5);
  const fixed = db.prepare('SELECT * FROM usage_logs WHERE user_id = ? AND request_date = ?')
    .get(user.id, reservedDate);
  assert.equal(fixed.input_tokens, 2);
  assert.equal(fixed.output_tokens, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM quota_reservations WHERE request_id = ?')
    .get(reservation.requestId).count, 0);
});
```

- [ ] **Step 2: Verify the test fails**

Run: `node --test --test-name-pattern "reservation UTC date" test/gateway.test.js`

Expected: FAIL because `fixed` is undefined and usage was written under the current UTC date.

- [ ] **Step 3: Use the authoritative reservation date**

```javascript
const reservation = db.prepare(
  'SELECT output_tokens, request_date FROM quota_reservations WHERE request_id = ? AND user_id = ?'
).get(requestId, userId);
// Keep the existing transaction and use reservation.request_date as the usage_logs upsert key.
```

Replace only the fresh `utcDate()` argument in the usage upsert with `reservation.request_date`.

- [ ] **Step 4: Verify focused and quota tests pass**

Run: `node --test --test-name-pattern "reservation UTC date|quota|usage summary" test/gateway.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add services/usage.js test/gateway.test.js
git commit -m "fix: preserve quota reservation date"
```

---

### Task 3: Canonical provider URLs and fixed endpoints

**Files:**
- Modify: `test/gateway.test.js:82-151,339-409,488-505,613-628`
- Modify: `services/provider-router.js:43-110`
- Modify: `routes/admin.js:247-258,543-591`
- Modify: `routes/v1.js:110`

**Interfaces:**
- Produces: `normalizeProviderBaseUrl(value): string` and `buildProviderEndpoint(baseUrl, relativePath): string` exported from `services/provider-router.js`.
- Consumers: admin create/update validation, provider test/discovery, and chat completion fetch.

- [ ] **Step 1: Add URL rejection and base-path integration tests**

Add `provider Base URLs reject query fragment traversal and encoded separators`. Submit create requests for:

```javascript
const unsafeUrls = [
  `${providerBaseUrl}?mode=unsafe`,
  `${providerBaseUrl}#fragment`,
  `${providerBaseUrl}/../escape`,
  `${providerBaseUrl}/%2e%2e/escape`,
  `${providerBaseUrl}/openai%2fv1`,
  `${providerBaseUrl}/openai%5cv1`
];
for (const [index, base_url] of unsafeUrls.entries()) {
  const response = await admin('/admin/providers', {
    method: 'POST',
    body: { provider_name: `unsafe-${index}`, display_name: 'Unsafe', base_url, auth_type: 'none' }
  });
  assert.equal(response.status, 400);
}
```

Add `provider Base URLs are canonical and fixed endpoints preserve the base path`. Extend the mock provider to record exact paths and accept `/openai/v1/models` and `/openai/v1/chat/completions`. Register ``HTTP://127.0.0.1:${providerServer.address().port}/openai/v1/``, assert the stored URL is canonical without a trailing slash, then assert discovery and chat use those two exact paths.

- [ ] **Step 2: Verify the new tests fail**

Run: `node --test --test-name-pattern "provider Base URLs" test/gateway.test.js`

Expected: FAIL because unsafe forms are accepted or normalized into unintended paths, and endpoints are still built by string concatenation.

- [ ] **Step 3: Implement standard-library URL normalization and joining**

```javascript
const { ApiError } = require('./errors');
const ENCODED_SEPARATOR = /%2f|%5c/i;
const DOT_SEGMENT = /(?:^|\/)(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i;

function normalizeProviderBaseUrl(value) {
  const raw = String(value).trim();
  if (ENCODED_SEPARATOR.test(raw) || DOT_SEGMENT.test(raw)) {
    throw new ApiError(400, 'base_url contains an unsafe path', 'invalid_request');
  }
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash) {
    throw new ApiError(400, 'base_url must be an HTTP(S) URL without credentials, query, or fragment', 'invalid_request');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.href.replace(/\/$/, '');
}

function buildProviderEndpoint(baseUrl, relativePath) {
  const endpoint = new URL(normalizeProviderBaseUrl(baseUrl));
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${String(relativePath).replace(/^\/+/, '')}`;
  return endpoint.href;
}
```

Use the existing project error type and message conventions. `validateUrl()` delegates to the normalizer. Replace all three string endpoint constructions with `buildProviderEndpoint(...)`. Preserve `redirect: 'manual'`.

- [ ] **Step 4: Run provider and full Gateway coverage**

Run: `node --test --test-name-pattern "provider|redirect|Base URL|streaming" test/gateway.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add services/provider-router.js routes/admin.js routes/v1.js test/gateway.test.js
git commit -m "fix: constrain provider endpoints"
```

---

### Task 4: Idempotent request cleanup and graceful shutdown

**Files:**
- Modify: `routes/v1.js:91-207,236-237`
- Modify: `server.js:1-47`
- Modify: `test/gateway.test.js:82-151,569-647`
- Create: `test/server.test.js`

**Interfaces:**
- Produces: `abortInFlight(): void` exported as a property of the existing v1 router.
- Consumes: idempotent release closure from `services/limits.acquire(...)` and existing quota release/record functions.

- [ ] **Step 1: Add streaming backpressure and abort-hook regressions**

Add a mock model that writes SSE chunks until its response closes. Use a raw HTTP client that does not consume the response body, destroy it after headers, then assert:

```javascript
assert.ok(upstreamDisconnects > before);
assert.equal(db.prepare(
  'SELECT COUNT(*) AS count FROM quota_reservations WHERE user_id = ?'
).get(user.id).count, 0);
const { state } = require('../services/limits');
assert.equal(state().users[user.id], undefined);
assert.equal(state().models[modelId], undefined);
assert.equal(state().providers[providerId], undefined);
```

Add `abortInFlight aborts active requests and cleanup is idempotent`: start a held request, call `require('../routes/v1').abortInFlight()` twice, and assert one upstream close plus zero reservation/limit state.

- [ ] **Step 2: Verify the Gateway lifecycle tests fail**

Run: `node --test --test-name-pattern "backpressure|abortInFlight" test/gateway.test.js`

Expected: FAIL because `abortInFlight` is not exported and the drain-only promise can remain pending.

- [ ] **Step 3: Track controllers and make drain waiting abortable**

```javascript
const { once } = require('node:events');
const activeControllers = new Set();

function abortInFlight() {
  for (const controller of activeControllers) controller.abort();
}
```

Add each request controller to the set before acquiring resources and delete it in the existing `finally` block. Pass `controller.signal` into `relayStream(...)` and replace the drain promise with:

```javascript
if (!res.write(chunk)) await once(res, 'drain', { signal });
```

Keep reservation and limit releases in the single existing `finally` path; do not add a second resource-release path.

- [ ] **Step 4: Add and pass the process-level shutdown test**

In `test/server.test.js`, create a temporary DB and local held provider, spawn `server.js` with a free port, wait for `/health`, start a held request, send `SIGTERM`, and assert exit code 0 before 10 seconds. The child environment contains only generated test credentials and the explicit temporary DB path.

Run: `node --test test/server.test.js`

Expected before the server change: FAIL or forced exit 1 because shutdown imports a no-op hook.

Change `server.js` so `server.close(callback)` is initiated before `abortInFlight()`, retaining the idempotent shutdown flag, 10-second force limit, passive checkpoint, DB close, and sanitized logging.

Run: `node --test test/server.test.js`

Expected: PASS.

- [ ] **Step 5: Run lifecycle coverage and commit**

Run: `node --test --test-name-pattern "streaming|disconnect|backpressure|abortInFlight" test/gateway.test.js`

Expected: PASS.

```powershell
git add routes/v1.js server.js test/gateway.test.js test/server.test.js
git commit -m "fix: unify request lifecycle cleanup"
```

---

### Task 5: Independently verifiable backups

**Files:**
- Create: `db/schema.js`
- Create: `db/verify.js`
- Create: `scripts/verify-backup.js`
- Create: `test/backup.test.js`
- Modify: `db/migrations.js:4,291`
- Modify: `services/backup.js:1-39`
- Modify: `package.json`
- Modify: `docs/BACKUP_RESTORE.md`

**Interfaces:**
- Produces: `verifyDatabase(filePath): { integrity: 'ok', schemaVersion: number }` with no config or live-DB import side effect.
- Preserves: `createBackup(): Promise<{ filename, created_at, schema_version, integrity }>` and `SCHEMA_VERSION` re-export from migrations.

- [ ] **Step 1: Add failing verifier and restore-copy tests**

```javascript
test('verifyDatabase rejects foreign-key violations', () => {
  const file = fixturePath('foreign-key-invalid.db');
  const fixture = new Database(file);
  createCurrentSchema(fixture);
  fixture.pragma('foreign_keys = OFF');
  fixture.exec("INSERT INTO usage_logs (user_id, request_date) VALUES (999, '2001-01-01')");
  fixture.close();
  assert.throws(() => verifyDatabase(file), /foreign key/i);
});

test('verifyDatabase rejects non-current schema version', () => {
  const file = fixturePath('future.db');
  const fixture = new Database(file);
  fixture.pragma('user_version = 3');
  fixture.close();
  assert.throws(() => verifyDatabase(file), /schema version/i);
});
```

Also add:

- `verifyDatabase rejects corrupt SQLite`.
- `createBackup publishes only a fully verified artifact`: assert the returned file exists, has integrity `ok`, version 2, zero FK rows, and a matching history row.
- `verify-backup validates an independently copied restore`: copy a normal backup to `restoreCopyPath` and spawn `scripts/verify-backup.js` with `restoreCopyPath` as its sole argument; assert exit 0 and no live DB mutation.
- Invalid artifact tests assert no final backup filename and no success history/audit entry.

- [ ] **Step 2: Verify tests fail because the verifier is absent**

Run: `node --test test/backup.test.js`

Expected: FAIL with module-not-found for `db/verify.js` or missing `verify-backup` behavior.

- [ ] **Step 3: Add the side-effect-free schema and verifier modules**

```javascript
// db/schema.js
const SCHEMA_VERSION = 2;
module.exports = { SCHEMA_VERSION };

// db/verify.js
const Database = require('better-sqlite3');
const { SCHEMA_VERSION } = require('./schema');

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
    return { integrity: 'ok', schemaVersion };
  } finally {
    if (database && database.open) database.close();
  }
}

module.exports = { verifyDatabase };
```

Import `SCHEMA_VERSION` into migrations and re-export it to preserve consumers.

- [ ] **Step 4: Publish only after final-file verification**

In `createBackup()`:

1. Generate a collision-resistant temporary filename in the backup directory.
2. Run `db.backup(tempPath)`.
3. Add the backup's self-history row, close that writable connection in `finally`, then call `verifyDatabase(tempPath)`.
4. Rename the verified temporary file to the unique final filename.
5. Only then insert live history and success audit rows.
6. On failure, close handles, remove only the exact temporary/final file created by this attempt, write a failure audit entry, and rethrow.

The verification CLI accepts exactly one explicit path, imports only `db/verify.js`, prints `Backup verified: integrity=ok schema=2`, and exits nonzero on validation failure without printing database content.

- [ ] **Step 5: Run backup coverage, document, and commit**

Run: `node --test test/backup.test.js`

Expected: PASS.

Run: `node --test --test-name-pattern "online backup" test/gateway.test.js`

Expected: PASS with the existing API response shape.

Add `"verify-backup": "node scripts/verify-backup.js"` to package scripts and document explicit restore-copy verification in `docs/BACKUP_RESTORE.md`.

```powershell
git add db/schema.js db/verify.js db/migrations.js services/backup.js scripts/verify-backup.js test/backup.test.js package.json docs/BACKUP_RESTORE.md
git commit -m "fix: verify backup artifacts"
```

---

### Task 6: Browser security headers and CSP-compatible dashboard

**Files:**
- Modify: `app.js:14-25`
- Modify: `public/admin-dashboard.html:7-91`
- Create: `public/admin-dashboard.css`
- Create: `public/admin-dashboard.js`
- Modify: `test/gateway.test.js:183-190,413-422`

**Interfaces:**
- Produces: global browser security headers and `Cache-Control: no-store` for `/admin` and direct dashboard HTML.
- Preserves: existing dashboard DOM behavior and session-only administrator key handling.

- [ ] **Step 1: Add failing response-header tests**

```javascript
test('security headers and no-store protect browser and admin responses', async () => {
  const health = await request('/health');
  const dashboard = await request('/admin/');
  const users = await admin('/admin/users');
  for (const response of [health, dashboard, users]) {
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const csp = response.headers.get('content-security-policy');
    for (const directive of [
      "default-src 'self'", "script-src 'self'", "style-src 'self'",
      "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"
    ]) assert.ok(csp.includes(directive));
  }
  assert.equal(dashboard.headers.get('cache-control'), 'no-store');
  assert.equal(users.headers.get('cache-control'), 'no-store');
});
```

Expected current behavior: header assertions receive `null`.

- [ ] **Step 2: Add failing external-asset and safe-sink tests**

Update the dashboard static test to assert HTML references `/admin-dashboard.css` and `/admin-dashboard.js`, contains no `<style>`, executable inline `<script>`, or inline event handler, and that `admin-dashboard.js`:

```javascript
assert.doesNotThrow(() => new vm.Script(script));
for (const sink of [/\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /\blocalStorage\b/]) {
  assert.equal(sink.test(script), false);
}
assert.ok(/\btextContent\b/.test(script));
assert.ok(/createTextNode/.test(script));
```

Run: `node --test --test-name-pattern "security headers|dashboard" test/gateway.test.js`

Expected: FAIL because headers and external files are absent.

- [ ] **Step 3: Add the minimal middleware and mechanically extract assets**

Add one middleware before static files and routes:

```javascript
const contentSecurityPolicy = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'",
  "img-src 'self' data:", "connect-src 'self'", "object-src 'none'",
  "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', contentSecurityPolicy);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path === '/admin-dashboard.html' || req.path === '/admin' || req.path.startsWith('/admin/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
```

Move the existing style block unchanged into `public/admin-dashboard.css` and the existing script body unchanged into `public/admin-dashboard.js`. Replace the blocks with external `link` and `script src` tags; do not refactor dashboard logic.

- [ ] **Step 4: Verify and commit**

Run: `node --test --test-name-pattern "security headers|dashboard|admin authentication" test/gateway.test.js`

Expected: PASS.

```powershell
git add app.js public/admin-dashboard.html public/admin-dashboard.css public/admin-dashboard.js test/gateway.test.js
git commit -m "fix: harden admin browser responses"
```

---

### Task 7: Race-safe setup without secret overwrite

**Files:**
- Create: `test/setup.test.js`
- Modify: `scripts/setup.js:20-38`

**Interfaces:**
- Consumes: optional `LLMWARD_SETUP_ROOT` test override.
- Produces: exactly one `.env` created with exclusive semantics; later invocations preserve it and never print its existing key.

- [ ] **Step 1: Add concurrent setup regression**

Use asynchronous `spawn`, start eight setup processes against one temporary root, then assert all exit 0, exactly one valid `.env` exists, one generated key appears in output once, subsequent output never contains that key, and no `.tmp` file remains.

```javascript
function runSetup(root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'setup.js')], {
      env: { ...process.env, LLMWARD_SETUP_ROOT: root }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
```

- [ ] **Step 2: Run the setup test**

Run: `node --test test/setup.test.js`

Expected against committed baseline: at least one process can fail with `EEXIST` or overwrite disclosure. The existing WIP hard-link implementation may already pass; if so, treat the test as validation of inherited WIP and do not add more abstraction.

- [ ] **Step 3: Keep the smallest passing implementation and commit**

Retain the current temporary-file plus exclusive `fs.linkSync(temp, envPath)` publication, clear the unused generated key on `EEXIST`, and remove the exact temporary file in `finally`. Add no lockfile or dependency.

Run: `node --test test/setup.test.js`

Expected: PASS repeatedly.

```powershell
git add scripts/setup.js test/setup.test.js
git commit -m "fix: make setup secret creation race safe"
```

---

### Task 8: Actionable doctor, minimal CI, and hardened Compose

**Files:**
- Create: `test/operations.test.js`
- Modify: `scripts/doctor.js:8-42`
- Create: `.github/workflows/ci.yml`
- Modify: `Dockerfile:1`
- Modify: `docker-compose.yml`
- Modify: `package.json:6-8`
- Modify: `package-lock.json:18-20`

**Interfaces:**
- Doctor output: every line starts with `[PASS]`, `[WARN]`, or `[FAIL]`; only FAIL sets exit 1.
- Runtime floor: Node.js 22 or newer, matching `better-sqlite3@13.0.2`.

- [ ] **Step 1: Add failing doctor and container guard tests**

Create a temporary current-schema DB, active provider/model, and generated secrets. Spawn doctor and assert:

```javascript
assert.equal(result.status, 0);
assert.equal(result.stdout.includes(adminKey), false);
assert.equal(result.stdout.includes(providerKey), false);
for (const name of [
  'Database schema version', 'SQLite integrity', 'SQLite foreign keys',
  'SQLite foreign key check', 'SQLite busy timeout', 'WAL mode',
  'Data directory readable', 'Data directory writable'
]) assert.ok(result.stdout.includes(name));
for (const line of result.stdout.trim().split(/\r?\n/)) {
  assert.match(line, /^\[(PASS|WARN|FAIL)\] /);
}
```

Run a second fixture with no active providers/models and one expired reservation; assert `[WARN]` and exit 0. Add static assertions that:

- `.github/workflows/ci.yml` has `permissions: contents: read`, checkout, setup-node 22, `npm ci`, `npm test`, and `npm audit --omit=dev`.
- Dockerfile uses `node:22-bookworm-slim`, `USER node`, `/app/data`, and healthcheck.
- Compose contains one service, one `/app/data` mount, `cap_drop: [ALL]`, `no-new-privileges:true`, restart policy, and no extra infrastructure.

- [ ] **Step 2: Verify the operations tests fail**

Run: `node --test test/operations.test.js`

Expected: FAIL because doctor emits `[OK]`/`[FAIL]` only, required DB checks are absent, workflow is absent, Docker uses Node 20, and Compose lacks hardening keys.

- [ ] **Step 3: Implement PASS/WARN/FAIL doctor checks**

```javascript
function check(name, status, detail) {
  checks.push({ name, status, detail });
}

check('SQLite foreign keys',
  db.pragma('foreign_keys', { simple: true }) === 1 ? 'pass' : 'fail',
  'enabled');
check('SQLite foreign key check',
  db.pragma('foreign_key_check').length === 0 ? 'pass' : 'fail',
  'violations checked');
check('SQLite busy timeout',
  db.pragma('busy_timeout', { simple: true }) >= 5000 ? 'pass' : 'fail',
  'configured');
```

Use WARN for missing active provider/model configuration, expired reservations, and low but nonzero disk space. Use FAIL for runtime floor, key safety, DB open/schema/integrity/FK/WAL/busy-timeout, and inaccessible data directory. Output only boolean state, counts, schema numbers, timeout, and capacity; never output values from keys, credentials, environment variables, or provider rows.

- [ ] **Step 4: Add minimal CI and Compose hardening**

```yaml
name: CI
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm audit --omit=dev
```

Update the package engine and lock root engine to `>=22`, Docker base to Node 22, and Compose service with:

```yaml
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
```

Do not add `read_only`, `tmpfs`, additional services, named databases, or network policy without Docker runtime evidence.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/operations.test.js`

Expected: PASS.

Run when Docker CLI exists: `docker compose config`

Expected: exit 0. If Docker CLI is absent, record the limitation later without claiming runtime verification.

```powershell
git add scripts/doctor.js test/operations.test.js .github/workflows/ci.yml Dockerfile docker-compose.yml package.json package-lock.json
git commit -m "ci: add release safety checks"
```

---

### Task 9: Release metadata, full verification, and PR-ready branch

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `docs/audit/FINDINGS.md`
- Modify: `docs/audit/WORKLOG.md`
- Modify: `docs/audit/THREAT_REVIEW.md` to record the completed controls while preserving intentional residual risks.
- Add: `AGENTS.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: package version `1.0.1`, closed findings with named tests, fresh verification evidence, and a ready-for-review branch.
- Preserves: `docs/audit/BASELINE.md` as the historical 2026-08-04 baseline.

- [ ] **Step 1: Run every focused suite before versioning**

Run separately and require exit 0:

```powershell
node --test test/migrations.test.js
node --test test/backup.test.js
node --test test/setup.test.js
node --test test/server.test.js
node --test test/operations.test.js
node --test test/gateway.test.js
```

- [ ] **Step 2: Run the full release verification matrix**

Run and read the complete output:

```powershell
npm.cmd test
npm.cmd run doctor
npm.cmd run benchmark
npm.cmd audit --omit=dev
git diff --check
```

Run `npm.cmd run backup` only with a generated administrator key and an explicit temporary `DATABASE_PATH`. Parse the exact backup path from that temporary directory and pass it as the sole argument to `npm.cmd run verify-backup --`. Run startup health through the process-level temporary-DB server test. Do not point either command at `data/gateway.db`.

If Docker CLI exists, run `docker compose config`, `docker compose build`, `docker compose up -d`, wait for healthy `docker compose ps`, then `docker compose down`. If absent, record “Docker CLI unavailable; runtime image/Compose verification not executed” in the worklog.

- [ ] **Step 3: Set patch version and changelog**

Run: `npm.cmd version 1.0.1 --no-git-tag-version`

Expected: `package.json` and both root version fields in `package-lock.json` become `1.0.1`; no Git tag is created.

Restructure `CHANGELOG.md` into:

```markdown
# Changelog

## Unreleased

## 1.0.1 - 2026-08-09

- Hardened streaming cleanup, provider URL handling, SQLite migration, quota dates, backups, browser headers, setup, diagnostics, CI, and Compose.

## 1.0.0 - 2026-08-04
```

Append the existing initial-feature bullets verbatim under `1.0.0`.

- [ ] **Step 4: Close audit findings with evidence**

For LLW-001 through LLW-008, set status to `수정 완료` and name the exact regression test file/test. Update `WORKLOG.md` with commit IDs, fresh command counts/durations, audit result, benchmark result, startup result, and Docker availability. Keep residual risks that remain intentional: plaintext provider credentials in DB, deployment TLS/network control, in-memory limit reset, and missing provider usage.

Track `AGENTS.md` by retaining the existing `.gitignore` removal. Do not include `.env`, `data/`, logs, backups, coverage, or generated DB/WAL/SHM files.

- [ ] **Step 5: Review, commit, and hand off to branch finishing**

Run:

```powershell
git status --short
git diff --check
git diff --stat
npm.cmd test
```

Expected: only intentional source, test, workflow, documentation, and metadata files; full suite exits 0.

```powershell
git add .gitignore AGENTS.md package.json package-lock.json CHANGELOG.md docs/audit
git commit -m "release: prepare 1.0.1"
```

Invoke `superpowers:requesting-code-review` for a final requirements/security review, address findings through the original task implementers, rerun the complete verification matrix, then invoke `superpowers:finishing-a-development-branch`. Push `audit/codex-hardening-release` and create a ready-for-review release PR. Do not merge `main` or create `v1.0.1` in this task.
