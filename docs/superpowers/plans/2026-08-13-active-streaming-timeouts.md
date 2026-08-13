# Active Streaming Timeouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow progressing SSE responses to run for up to 30 minutes while aborting a response that does not start within 60 seconds or becomes idle for two minutes.

**Architecture:** Keep one AbortController and the existing idempotent request cleanup path. Non-streaming requests retain one whole-response deadline; streaming requests transition from a response-start deadline to a resettable raw-chunk idle deadline while a separate hard deadline never resets. Record the first abort cause so shutdown, client disconnect, and Gateway deadlines cannot be confused.

**Tech Stack:** CommonJS, Node.js 22 standard library fetch/AbortController/timers, Express 5, better-sqlite3, node:test

## Global Constraints

- Use only `LLMWARD_PROVIDER_TIMEOUT_MS=60000`, `LLMWARD_STREAM_IDLE_TIMEOUT_MS=120000`, and `LLMWARD_STREAM_MAX_DURATION_MS=1800000`. Do not read a legacy product-prefixed alias.
- Reject timeout values outside `1..2147483647` milliseconds because Node.js clamps larger timer delays.
- Preserve CommonJS, current dependencies, and the single-process/single-SQLite product boundary. Add no dependency or schema migration.
- Never log or persist prompts, message arrays, generated content, provider error bodies, credentials, administrator keys, or raw user tokens.
- Preserve prepared statements, transaction safety, authorization, request-size validation, content-filter fail-closed behavior, redirect rejection, and one idempotent quota/concurrency cleanup path.
- Do not edit an existing `.env` automatically. Setup must continue to preserve it.
- Do not alter unrelated PII design or implementation work.
- Every task commit must use `git commit --only` with that task's exact paths so unrelated staged work remains untouched.
- Follow TDD for behavior changes. Before a completion claim, use `superpowers:requesting-code-review` and `superpowers:verification-before-completion`.

## File Map

- `config/index.js`: validate and expose the three LLMWard timeout settings.
- `routes/v1.js`: own response-start, streaming idle, streaming maximum, abort-cause, and cleanup state.
- `services/usage.js`: expire quota reservations according to the request's maximum lifetime.
- `services/provider-router.js`: consume the renamed provider timeout for provider tests and discovery.
- `test/config.test.js`: isolate timeout configuration parsing from a repository `.env`.
- `test/usage.test.js`: prove caller-selected reservation lifetime and validation.
- `test/gateway.test.js`: prove route-selected reservation lifetime, response-start/non-streaming deadlines, shutdown attribution, and cleanup.
- `test/filter-streaming.test.js`: prove raw-chunk progress, filtered pre-header 504, idle/hard expiration, backpressure behavior, and cleanup.
- `.env.example`, `scripts/benchmark.js`, `test/filter-runtime.test.js`, `test/server.test.js`: adopt LLMWard configuration names and preserve lifecycle coverage.
- `README.md`, `docs/COMPATIBILITY.md`: document the runtime, client-visible, migration, and reverse-proxy contract.

---

### Task 1: Replace the legacy timeout setting with bounded LLMWard settings

**Files:**
- Create: `test/config.test.js`
- Modify: `config/index.js` at `positiveInteger` and the exported timeout property
- Modify: `.env.example` at the timeout entry
- Modify: `routes/v1.js` at the provider timer read
- Modify: `services/usage.js` at the default reservation lifetime
- Modify: `services/provider-router.js` at both provider timeout reads
- Modify: `scripts/benchmark.js` at its environment bootstrap
- Modify: `test/gateway.test.js`, `test/filter-runtime.test.js`, `test/filter-streaming.test.js`, and `test/server.test.js` at their environment bootstraps

**Interfaces:**
- Produces: `config.providerTimeoutMs`, `config.streamIdleTimeoutMs`, and `config.streamMaxDurationMs` as integer milliseconds in `1..2147483647`.
- Produces: `timeoutInteger(value, fallback, name)` as a private configuration helper.
- Preserves: existing runtime behavior until Task 4 changes streaming timer transitions.

- [ ] **Step 1: Create failing configuration tests**

Create `test/config.test.js`:

```javascript
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-config-'));
const configPath = path.join(__dirname, '..', 'config');
const timeoutNames = [
  'LLMWARD_PROVIDER_TIMEOUT_MS',
  'LLMWARD_STREAM_IDLE_TIMEOUT_MS',
  'LLMWARD_STREAM_MAX_DURATION_MS'
];

after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

function loadConfig(overrides = {}) {
  const environment = {
    ADMIN_SECRET_KEY: `admin-${crypto.randomBytes(32).toString('base64url')}`,
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    ...overrides
  };
  if (process.platform === 'win32') {
    environment.SystemRoot = process.env.SystemRoot;
    environment.WINDIR = process.env.WINDIR;
  }
  const source = [
    `const config = require(${JSON.stringify(configPath)});`,
    'process.stdout.write(JSON.stringify({',
    '  providerTimeoutMs: config.providerTimeoutMs,',
    '  streamIdleTimeoutMs: config.streamIdleTimeoutMs,',
    '  streamMaxDurationMs: config.streamMaxDurationMs',
    '}));'
  ].join('\n');
  return spawnSync(process.execPath, ['-e', source], {
    cwd: temporaryDirectory,
    env: environment,
    encoding: 'utf8'
  });
}

test('LLMWard timeout settings use documented defaults', () => {
  const result = loadConfig();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    providerTimeoutMs: 60000,
    streamIdleTimeoutMs: 120000,
    streamMaxDurationMs: 1800000
  });
});

test('LLMWard timeout settings accept explicit millisecond values', () => {
  const result = loadConfig({
    LLMWARD_PROVIDER_TIMEOUT_MS: '111',
    LLMWARD_STREAM_IDLE_TIMEOUT_MS: '222',
    LLMWARD_STREAM_MAX_DURATION_MS: '333'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    providerTimeoutMs: 111,
    streamIdleTimeoutMs: 222,
    streamMaxDurationMs: 333
  });
});

test('LLMWard timeout settings reject non-positive or non-integer values', () => {
  for (const name of timeoutNames) {
    for (const value of ['0', '-1', '1.5', '9007199254740992']) {
      const result = loadConfig({ [name]: value });
      assert.notEqual(result.status, 0, `${name}=${value}`);
      assert.match(result.stderr, new RegExp(`${name} must be a positive integer`));
    }
  }
});

test('LLMWard timeout settings reject delays above the Node timer limit', () => {
  for (const name of timeoutNames) {
    const result = loadConfig({ [name]: '2147483648' });
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, new RegExp(`${name} must not exceed 2147483647`));
  }
});
```

- [ ] **Step 2: Run the new test and verify the red state**

Run:

```powershell
node --test test/config.test.js
```

Expected: the defaults and explicit-value tests fail because the three exported properties do not exist.

- [ ] **Step 3: Add bounded timeout parsing and the three properties**

Add below `positiveInteger` in `config/index.js`:

```javascript
function timeoutInteger(value, fallback, name) {
  const parsed = positiveInteger(value, fallback, name);
  if (parsed > 2147483647) {
    throw new Error(`${name} must not exceed 2147483647`);
  }
  return parsed;
}
```

Replace the single exported timeout property with:

```javascript
providerTimeoutMs: timeoutInteger(
  process.env.LLMWARD_PROVIDER_TIMEOUT_MS,
  60000,
  'LLMWARD_PROVIDER_TIMEOUT_MS'
),
streamIdleTimeoutMs: timeoutInteger(
  process.env.LLMWARD_STREAM_IDLE_TIMEOUT_MS,
  120000,
  'LLMWARD_STREAM_IDLE_TIMEOUT_MS'
),
streamMaxDurationMs: timeoutInteger(
  process.env.LLMWARD_STREAM_MAX_DURATION_MS,
  1800000,
  'LLMWARD_STREAM_MAX_DURATION_MS'
),
```

Replace the timeout entry in `.env.example` with:

```dotenv
LLMWARD_PROVIDER_TIMEOUT_MS=60000
LLMWARD_STREAM_IDLE_TIMEOUT_MS=120000
LLMWARD_STREAM_MAX_DURATION_MS=1800000
```

Rename internal reads to `config.providerTimeoutMs` in `routes/v1.js`, `services/usage.js`, and both `Math.min` calls in `services/provider-router.js`. Rename bootstrap assignments in the benchmark and four test files to `process.env.LLMWARD_PROVIDER_TIMEOUT_MS` or `LLMWARD_PROVIDER_TIMEOUT_MS` without a fallback alias.

- [ ] **Step 4: Run focused configuration and setup tests**

Run:

```powershell
node --test test/config.test.js test/setup.test.js
```

Expected: all tests pass, including setup's exact `.env.example` copy and existing `.env` preservation assertions.

- [ ] **Step 5: Run every test file whose bootstrap changed**

Run:

```powershell
node --test test/gateway.test.js test/filter-runtime.test.js test/filter-streaming.test.js test/server.test.js
```

Expected: all tests pass with unchanged request behavior.

- [ ] **Step 6: Verify the old product prefix is absent from tracked files without printing file contents**

Run:

```powershell
$legacyPattern = ('KER' + 'NEXA|Ker' + 'nexa|ker' + 'nexa')
git grep -q -I -E $legacyPattern -- .
if ($LASTEXITCODE -eq 0) {
  git grep -l -I -E $legacyPattern -- .
  throw 'Legacy product prefix remains in tracked files'
}
if ($LASTEXITCODE -ne 1) { exit $LASTEXITCODE }
```

Expected: no filenames and exit code 1 from `git grep`. This intentionally does not inspect or print the ignored live `.env`.

- [ ] **Step 7: Commit only the configuration paths**

```powershell
git add -- .env.example config/index.js routes/v1.js services/usage.js services/provider-router.js scripts/benchmark.js test/config.test.js test/gateway.test.js test/filter-runtime.test.js test/filter-streaming.test.js test/server.test.js
git diff --cached --check -- .env.example config/index.js routes/v1.js services/usage.js services/provider-router.js scripts/benchmark.js test/config.test.js test/gateway.test.js test/filter-runtime.test.js test/filter-streaming.test.js test/server.test.js
git commit --only -m "refactor: use LLMWard timeout settings" -- .env.example config/index.js routes/v1.js services/usage.js services/provider-router.js scripts/benchmark.js test/config.test.js test/gateway.test.js test/filter-runtime.test.js test/filter-streaming.test.js test/server.test.js
```

---

### Task 2: Give quota reservations the request's actual maximum lifetime

**Files:**
- Modify: `services/usage.js` at `reserveQuota`
- Modify: `routes/v1.js` before `reserveQuota` and at the streaming branch
- Test: `test/usage.test.js` after `storedRows`
- Test: `test/gateway.test.js` beside existing disconnect and `abort-in-flight` lifecycle coverage

**Interfaces:**
- Produces: `reserveQuota(user, requestedMaxTokens, modelMaxTokens, requestLifetimeMs = config.providerTimeoutMs)`.
- Returns: unchanged `{ requestId, maxTokens }`.
- Route rule: streaming requests pass `config.streamMaxDurationMs`; non-streaming requests pass `config.providerTimeoutMs`.

- [ ] **Step 1: Write failing service lifetime tests**

Extend the import in `test/usage.test.js`:

```javascript
const {
  reserveQuota,
  releaseReservation,
  recordUsage,
  recordFailure
} = require('../services/usage');
```

Add after `storedRows`:

```javascript
function createQuotaUser() {
  fixtureId += 1;
  const result = db.prepare(`
    INSERT INTO users
      (username, api_token, max_daily_input_tokens, max_daily_output_tokens)
    VALUES (?, ?, 1000, 1000)
  `).run(
    `quota-lifetime-user-${fixtureId}`,
    `sha256:${crypto.randomBytes(32).toString('hex')}`
  );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

test('reserveQuota uses the caller-provided request lifetime', () => {
  const user = createQuotaUser();
  const lifetimeMs = 600000;
  const before = Date.now();
  const reservation = reserveQuota(user, 1, 4, lifetimeMs);
  const after = Date.now();
  const row = db.prepare(
    'SELECT expires_at FROM quota_reservations WHERE request_id = ?'
  ).get(reservation.requestId);
  const expiresAt = Date.parse(row.expires_at);

  assert.ok(expiresAt >= before + lifetimeMs + 30000);
  assert.ok(expiresAt <= after + lifetimeMs + 30000);
  releaseReservation(reservation.requestId);
});

test('reserveQuota rejects an invalid request lifetime before writing', () => {
  const user = createQuotaUser();
  assert.throws(
    () => reserveQuota(user, 1, 4, 0),
    (error) => error.status === 500 && error.message === 'Request lifetime is invalid'
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM quota_reservations WHERE user_id = ?')
      .pluck().get(user.id),
    0
  );
});
```

- [ ] **Step 2: Run the new service tests and verify red**

Run:

```powershell
node --test --test-name-pattern="request lifetime" test/usage.test.js
```

Expected: the fourth argument is ignored and invalid lifetime is not rejected.

- [ ] **Step 3: Implement the lifetime parameter**

Change the start of `reserveQuota` in `services/usage.js`:

```javascript
function reserveQuota(
  user,
  requestedMaxTokens,
  modelMaxTokens,
  requestLifetimeMs = config.providerTimeoutMs
) {
  if (!Number.isSafeInteger(requestLifetimeMs) || requestLifetimeMs <= 0) {
    throw new ApiError(500, 'Request lifetime is invalid');
  }
```

Keep the existing checks and `BEGIN IMMEDIATE` transaction. Replace only the expiry calculation:

```javascript
const expiresAt = new Date(
  now.getTime() + requestLifetimeMs + 30000
).toISOString();
```

In `routes/v1.js`, derive the mode once and pass its lifetime:

```javascript
const streaming = req.body.stream === true;
const requestLifetimeMs = streaming
  ? config.streamMaxDurationMs
  : config.providerTimeoutMs;
reservation = reserveQuota(
  req.user,
  req.body.max_tokens,
  req.gatewayModel.max_tokens,
  requestLifetimeMs
);
```

Use `streaming` for the later streaming branch.

- [ ] **Step 4: Add a route integration test for both selected lifetimes**

After the timeout environment assignment in `test/gateway.test.js`, load:

```javascript
const config = require('../config');
```

Add this helper beside `waitFor`:

```javascript
async function assertRouteReservationLifetime(t, stream, expectedMs, username) {
  const user = await createUser(username, ['abort-in-flight']);
  const started = once(providerEvents, 'abort-in-flight:started', {
    signal: AbortSignal.timeout(3000)
  });
  const closed = once(providerEvents, 'abort-in-flight:closed', {
    signal: AbortSignal.timeout(3000)
  });
  const client = http.request(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json'
    }
  });
  client.on('error', () => {});
  t.after(() => client.destroy());
  const before = Date.now();
  client.end(JSON.stringify({
    model: 'abort-in-flight',
    stream,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'reservation-lifetime' }]
  }));

  await started;
  const after = Date.now();
  const row = db.prepare(
    'SELECT expires_at FROM quota_reservations WHERE user_id = ?'
  ).get(user.id);
  const expiresAt = Date.parse(row.expires_at);
  assert.ok(expiresAt >= before + expectedMs + 30000);
  assert.ok(expiresAt <= after + expectedMs + 30000);

  client.destroy();
  await closed;
  await waitFor(
    () => db.prepare('SELECT COUNT(*) FROM quota_reservations WHERE user_id = ?')
      .pluck().get(user.id) === 0,
    'reservation lifetime request cleanup did not finish'
  );
}
```

Add the integration test beside the existing `abortInFlight` lifecycle test:

```javascript
test('route selects provider or stream maximum reservation lifetime', async (t) => {
  const original = {
    providerTimeoutMs: config.providerTimeoutMs,
    streamMaxDurationMs: config.streamMaxDurationMs
  };
  config.providerTimeoutMs = 5000;
  config.streamMaxDurationMs = 15000;
  t.after(() => Object.assign(config, original));

  await assertRouteReservationLifetime(t, false, 5000, 'nonstream-reservation-user');
  await assertRouteReservationLifetime(t, true, 15000, 'stream-reservation-user');
});
```

- [ ] **Step 5: Run usage and route lifetime tests**

Run:

```powershell
node --test test/usage.test.js
node --test --test-name-pattern="reservation lifetime" test/gateway.test.js
```

Expected: all selected tests pass and both held requests release reservations after disconnect.

- [ ] **Step 6: Commit only reservation paths**

```powershell
git add -- services/usage.js routes/v1.js test/usage.test.js test/gateway.test.js
git diff --cached --check -- services/usage.js routes/v1.js test/usage.test.js test/gateway.test.js
git commit --only -m "fix: align reservations with request lifetime" -- services/usage.js routes/v1.js test/usage.test.js test/gateway.test.js
```

---

### Task 3: Preserve the first abort cause

**Files:**
- Modify: `routes/v1.js` at active request tracking, disconnect, catch, finally, filter abort, and `abortInFlight`
- Test: `test/gateway.test.js` at `abortInFlight aborts active requests and cleanup is idempotent`
- Test: `test/server.test.js` at the shutdown database assertions

**Interfaces:**
- Produces: handler-local `abortRequest(cause)` where `cause` is `client`, `timeout`, `shutdown`, or `filter`.
- Produces: HTTP 503 code `gateway_shutdown` for an in-flight request aborted by `abortInFlight` before response headers.
- Preserves: timeout as HTTP 504 `provider_timeout`, client disconnect suppression, and filter error classification.

- [ ] **Step 1: Strengthen abort-in-flight and shutdown tests**

In the existing gateway `abortInFlight` test, capture the response status and assert the single stored outcome after invoking `abortInFlight()` twice:

```javascript
let responseStatus;
let client;
const responseEnded = new Promise((resolve, reject) => {
  client = http.request(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json'
    }
  }, (response) => {
    responseStatus = response.statusCode;
    response.resume();
    response.once('end', resolve);
  });
  client.once('error', reject);
});
const completed = once(client, 'close', { signal: AbortSignal.timeout(3000) });
client.end(JSON.stringify({
  model: 'abort-in-flight',
  messages: [{ role: 'user', content: 'abort-secret' }],
  max_tokens: 1
}));
t.after(() => client.destroy());

await started;
const v1 = require('../routes/v1');
v1.abortInFlight();
v1.abortInFlight();
await closed;
await responseEnded;
await completed;
assert.equal(responseStatus, 503);
const outcomes = db.prepare(`
  SELECT status, error_type FROM request_logs
  WHERE user_id = ? ORDER BY id
`).all(user.id);
assert.deepEqual(outcomes, [{ status: 'failure', error_type: 'internal' }]);
```

Keep the existing upstream close, reservation, and concurrency assertions around this replacement.

In `test/server.test.js`, before closing the readonly migrated database, add:

```javascript
const shutdownOutcome = migrated.prepare(`
  SELECT status, error_type FROM request_logs
  ORDER BY id DESC LIMIT 1
`).get();
assert.deepEqual(shutdownOutcome, {
  status: 'failure',
  error_type: 'internal'
});
```

- [ ] **Step 2: Run the tests and verify the existing false timeout attribution**

Run:

```powershell
node --test --test-name-pattern="abortInFlight" test/gateway.test.js
node --test test/server.test.js
```

Expected: the gateway test receives 504 or stores `timeout` instead of the required 503/internal shutdown outcome.

- [ ] **Step 3: Track and use the first abort cause**

Rename the module-level set and register abort callbacks instead of bare controllers:

```javascript
const activeRequests = new Set();
```

Inside the route, replace direct controller registration and direct client abort with:

```javascript
let abortCause = null;
const controller = new AbortController();
const abortRequest = (cause) => {
  if (controller.signal.aborted) return;
  abortCause = cause;
  controller.abort();
};
activeRequests.add(abortRequest);
const disconnect = () => {
  if (!res.writableEnded) {
    clientDisconnected = true;
    abortRequest('client');
  }
};
```

Change the output-filter failure abort to:

```javascript
abortRequest('filter');
```

Replace the aborted error mapping with:

```javascript
const aborted = error.name === 'AbortError' && controller.signal.aborted;
const handledError = aborted
  ? abortCause === 'client'
    ? new ApiError(499, 'Client disconnected', 'client_disconnected')
    : abortCause === 'timeout'
      ? new ApiError(504, 'Provider request timed out', 'provider_timeout')
      : new ApiError(503, 'Gateway is shutting down', 'gateway_shutdown')
  : error;
```

In `finally`, delete the callback:

```javascript
activeRequests.delete(abortRequest);
```

Replace `abortInFlight` with:

```javascript
function abortInFlight() {
  for (const abortRequest of activeRequests) abortRequest('shutdown');
}
```

Task 4 will route all deadline callbacks through `abortRequest('timeout')`.

- [ ] **Step 4: Run lifecycle tests**

Run:

```powershell
node --test --test-name-pattern="abortInFlight|disconnect" test/gateway.test.js
node --test test/server.test.js
```

Expected: shutdown produces one internal failure record, client disconnect remains client-owned, upstream closes once, and reservations/concurrency are empty.

- [ ] **Step 5: Commit only abort-cause paths**

```powershell
git add -- routes/v1.js test/gateway.test.js test/server.test.js
git diff --cached --check -- routes/v1.js test/gateway.test.js test/server.test.js
git commit --only -m "fix: distinguish shutdown from provider timeout" -- routes/v1.js test/gateway.test.js test/server.test.js
```

---

### Task 4: Replace the streaming absolute timer with progress-aware deadlines

**Files:**
- Modify: `routes/v1.js` in the chat handler, `relayStream`, and `relayFilteredStream`
- Test: `test/gateway.test.js` in its mock provider, model fixture, chat helper, and timeout tests
- Test: `test/filter-streaming.test.js` in helpers and timeout behavior tests

**Interfaces:**
- Produces: handler-local `refreshStreamIdleTimeout()` with no arguments or return value.
- `relayStream(response, res, signal, outputPatterns, onChunk)` invokes `onChunk()` before processing every raw upstream chunk.
- `relayFilteredStream(response, res, signal, patterns, onChunk)` follows the same raw activity contract.
- Before downstream headers, a deadline yields 504 `provider_timeout`; after SSE headers, it destroys the connection without an SSE error event.
- During downstream backpressure the relay stops reading upstream, so the idle deadline remains armed and bounds the stalled connection.

- [ ] **Step 1: Add streaming-start and non-streaming-body timeout fixtures**

Change the gateway `chat` helper without changing existing callers:

```javascript
function chat(token, model, maxTokens, stream = false) {
  const body = {
    model,
    stream,
    messages: [{ role: 'user', content: 'test' }]
  };
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  return request('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body
  });
}
```

In the gateway mock provider, immediately after parsing `payload`, add:

```javascript
if (payload.model === 'stream-start-timeout' ||
    payload.model === 'nonstream-body-timeout') {
  const eventName = payload.model;
  res.once('close', () => {
    providerEvents.emit(`${eventName}:closed`, !res.writableEnded);
  });
  if (eventName === 'nonstream-body-timeout') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
  }
  providerEvents.emit(`${eventName}:started`);
  return;
}
```

Register both model names in the existing model fixture array with `max_tokens=4`.

- [ ] **Step 2: Add failing Gateway deadline tests**

Add beside the existing lifecycle tests:

```javascript
async function assertGatewayTimeout(t, modelName, stream) {
  const originalTimeout = config.providerTimeoutMs;
  config.providerTimeoutMs = 100;
  t.after(() => { config.providerTimeoutMs = originalTimeout; });

  const user = await createUser(`${modelName}-user`, [modelName]);
  const started = once(providerEvents, `${modelName}:started`, {
    signal: AbortSignal.timeout(3000)
  });
  const closed = once(providerEvents, `${modelName}:closed`, {
    signal: AbortSignal.timeout(3000)
  });
  const pending = chat(user.token, modelName, 1, stream);

  await started;
  const response = await pending;
  const [wasAborted] = await closed;
  assert.equal(wasAborted, true);
  assert.equal(response.status, 504);
  assert.equal(response.body.code, 'provider_timeout');
  await waitFor(
    () => db.prepare('SELECT COUNT(*) FROM quota_reservations WHERE user_id = ?')
      .pluck().get(user.id) === 0,
    `${modelName} reservation cleanup did not finish`
  );
  const requestLog = db.prepare(`
    SELECT status, error_type FROM request_logs
    WHERE user_id = ? ORDER BY id DESC LIMIT 1
  `).get(user.id);
  assert.deepEqual(requestLog, { status: 'failure', error_type: 'timeout' });
  const { state } = require('../services/limits');
  assert.equal(state().users[user.id], undefined);
  assert.equal(state().models[modelName], undefined);
  assert.equal(state().providers[providerId], undefined);
}

test('streaming response-start timeout returns 504 before headers', async (t) => {
  await assertGatewayTimeout(t, 'stream-start-timeout', true);
});

test('non-streaming body timeout returns 504', async (t) => {
  await assertGatewayTimeout(t, 'nonstream-body-timeout', false);
});
```

- [ ] **Step 3: Add streaming timeout helpers**

After the environment assignments in `test/filter-streaming.test.js`, load:

```javascript
const config = require('../config');
const { state } = require('../services/limits');
```

Add beside the existing test helpers:

```javascript
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function useStreamingTimeouts(t, values) {
  const original = {
    providerTimeoutMs: config.providerTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    streamMaxDurationMs: config.streamMaxDurationMs
  };
  Object.assign(config, values);
  t.after(() => Object.assign(config, original));
}

async function writeActiveEvents(res, contents) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  res.flushHeaders();
  for (const content of contents) {
    res.write('data: ' + JSON.stringify({
      choices: [{ index: 0, delta: { content } }]
    }) + '\n\n');
    await delay(50);
  }
  res.write('data: ' + JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

async function waitForReleasedResources() {
  await waitFor(() => {
    const reservations = db.prepare(
      'SELECT COUNT(*) FROM quota_reservations WHERE user_id = ?'
    ).pluck().get(user.id);
    return reservations === 0 &&
      state().users[user.id] === undefined &&
      state().models['filter-streaming'] === undefined &&
      state().providers[providerId] === undefined;
  }, 'timeout resource cleanup did not finish');
}
```

- [ ] **Step 4: Add filtered pre-header and raw-fragment progress tests**

Add:

```javascript
test('filtered idle timeout returns 504 before downstream headers', async (t) => {
  useStreamingTimeouts(t, {
    providerTimeoutMs: 100,
    streamIdleTimeoutMs: 200,
    streamMaxDurationMs: 1000
  });
  addOutputFilter(['secret']);
  providerHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    res.once('close', () => providerEvents.emit('filtered-idle:closed'));
    providerEvents.emit('filtered-idle:started');
  };
  const started = once(providerEvents, 'filtered-idle:started', {
    signal: AbortSignal.timeout(3000)
  });
  const closed = once(providerEvents, 'filtered-idle:closed', {
    signal: AbortSignal.timeout(3000)
  });
  const pending = streamRequest();

  await started;
  const response = await pending;
  await closed;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'provider_timeout');
  await waitForReleasedResources();
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'timeout',
    input_tokens: 0, output_tokens: 0, total_tokens: 0
  }]);
});

test('filtered stream treats fragmented raw chunks as progress', async (t) => {
  useStreamingTimeouts(t, {
    providerTimeoutMs: 100,
    streamIdleTimeoutMs: 300,
    streamMaxDurationMs: 2000
  });
  addOutputFilter(['secret']);
  providerHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    const event = Buffer.from('data: ' + JSON.stringify({
      choices: [{ index: 0, delta: { content: 'secret-fragmented' } }]
    }) + '\n\n');
    const size = Math.ceil(event.length / 5);
    for (let offset = 0; offset < event.length; offset += size) {
      res.write(event.subarray(offset, offset + size));
      await delay(100);
    }
    res.write('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
    res.end('data: [DONE]\n\n');
  };

  const startedAt = Date.now();
  const response = await streamRequest();
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(Date.now() - startedAt >= 300);
  assert.equal(text.includes('secret'), false);
  assert.equal(text.includes('[FILTERED]'), true);
  assert.match(text, /\[DONE\]/);
  assert.deepEqual(requestLogs(), [{
    status: 'success', error_type: null,
    input_tokens: 1, output_tokens: 1, total_tokens: 2
  }]);
});
```

- [ ] **Step 5: Add active, post-header idle, and hard-cap tests**

Add:

```javascript
test('active byte-transparent stream outlives response-start timeout', async (t) => {
  useStreamingTimeouts(t, {
    providerTimeoutMs: 100,
    streamIdleTimeoutMs: 300,
    streamMaxDurationMs: 1000
  });
  providerHandler = async (req, res) => writeActiveEvents(
    res,
    ['safe-0-', 'safe-1-', 'safe-2-', 'safe-3-', 'safe-4-']
  );

  const startedAt = Date.now();
  const response = await streamRequest();
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(Date.now() - startedAt >= 200);
  assert.match(text, /\[DONE\]/);
  assert.deepEqual(requestLogs(), [{
    status: 'success', error_type: null,
    input_tokens: 1, output_tokens: 1, total_tokens: 2
  }]);
});

test('post-header stream idle timeout destroys the connection', async (t) => {
  useStreamingTimeouts(t, {
    providerTimeoutMs: 100,
    streamIdleTimeoutMs: 200,
    streamMaxDurationMs: 1000
  });
  providerHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    res.write('data: {"choices":[{"index":0,"delta":{"content":"safe"}}]}\n\n');
    res.once('close', () => providerEvents.emit('idle:closed'));
    providerEvents.emit('idle:started');
  };
  const started = once(providerEvents, 'idle:started', {
    signal: AbortSignal.timeout(3000)
  });
  const closed = once(providerEvents, 'idle:closed', {
    signal: AbortSignal.timeout(3000)
  });
  const startedAt = Date.now();
  const pending = streamRequest();

  await started;
  const response = await pending;
  assert.equal(response.status, 200);
  const partialBody = await partialBodyUntilFailure(response);
  await closed;
  const elapsed = Date.now() - startedAt;
  assert.ok(partialBody.length > 0);
  assert.ok(elapsed >= 150 && elapsed < 700, `elapsed=${elapsed}`);
  await waitForReleasedResources();
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'timeout',
    input_tokens: 0, output_tokens: 0, total_tokens: 0
  }]);
});

test('stream maximum duration aborts a progressing upstream', async (t) => {
  useStreamingTimeouts(t, {
    providerTimeoutMs: 100,
    streamIdleTimeoutMs: 300,
    streamMaxDurationMs: 450
  });
  let interval;
  providerHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    let sequence = 0;
    interval = setInterval(() => {
      res.write('data: ' + JSON.stringify({
        choices: [{ index: 0, delta: { content: `safe-${sequence++}` } }]
      }) + '\n\n');
    }, 50);
    res.once('close', () => {
      clearInterval(interval);
      providerEvents.emit('maximum:closed');
    });
  };
  t.after(() => clearInterval(interval));
  const closed = once(providerEvents, 'maximum:closed', {
    signal: AbortSignal.timeout(3000)
  });
  const startedAt = Date.now();
  const response = await streamRequest();

  assert.equal(response.status, 200);
  const partialBody = await partialBodyUntilFailure(response);
  await closed;
  const elapsed = Date.now() - startedAt;
  assert.ok(partialBody.length > 0);
  assert.ok(elapsed >= 350 && elapsed < 1000, `elapsed=${elapsed}`);
  await waitForReleasedResources();
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'timeout',
    input_tokens: 0, output_tokens: 0, total_tokens: 0
  }]);
});
```

- [ ] **Step 6: Add the downstream-backpressure idle test**

Add:

```javascript
test('stream idle timeout bounds downstream backpressure', async (t) => {
  useStreamingTimeouts(t, {
    providerTimeoutMs: 100,
    streamIdleTimeoutMs: 200,
    streamMaxDurationMs: 1000
  });
  const originalWrite = http.ServerResponse.prototype.write;
  const originalOnce = http.ServerResponse.prototype.once;
  http.ServerResponse.prototype.write = function (chunk, ...args) {
    const result = originalWrite.call(this, chunk, ...args);
    return this.getHeader('X-Accel-Buffering') === 'no' ? false : result;
  };
  http.ServerResponse.prototype.once = function (eventName, ...args) {
    if (this.getHeader('X-Accel-Buffering') === 'no' && eventName === 'drain') {
      return this;
    }
    return originalOnce.call(this, eventName, ...args);
  };
  t.after(() => {
    http.ServerResponse.prototype.write = originalWrite;
    http.ServerResponse.prototype.once = originalOnce;
  });
  providerHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    res.once('close', () => providerEvents.emit('backpressure-idle:closed'));
    let sequence = 0;
    while (!res.destroyed && !res.writableEnded) {
      const accepted = res.write('data: ' + JSON.stringify({
        choices: [{ index: 0, delta: { content: `safe-${sequence++}` } }]
      }) + '\n\n');
      if (!accepted) await once(res, 'drain');
      await delay(5);
    }
  };
  const closed = once(providerEvents, 'backpressure-idle:closed', {
    signal: AbortSignal.timeout(3000)
  });
  const response = await streamRequest();
  assert.equal(response.status, 200);
  const partialBody = await partialBodyUntilFailure(response);
  await closed;
  assert.ok(partialBody.length > 0);
  await waitForReleasedResources();
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'timeout',
    input_tokens: 0, output_tokens: 0, total_tokens: 0
  }]);
});
```

- [ ] **Step 7: Run the new timeout tests and verify red**

Run each file separately so the expected old behavior is clear:

```powershell
node --test --test-name-pattern="timeout|outlives|maximum duration|raw chunks|backpressure" test/gateway.test.js
node --test --test-name-pattern="timeout|outlives|maximum duration|raw chunks|backpressure" test/filter-streaming.test.js
```

Expected: Gateway characterization remains green where old behavior already matches; active and fragmented streams fail near the old provider deadline, and filtered idle/progress/backpressure coverage fails without idle transitions.

- [ ] **Step 8: Implement the streaming timer transition**

Replace the single timer handle in the route with:

```javascript
let providerTimeout;
let streamIdleTimeout;
let streamMaxDurationTimeout;
```

Add after `abortRequest` is defined:

```javascript
const abortForTimeout = () => abortRequest('timeout');
const refreshStreamIdleTimeout = () => {
  clearTimeout(streamIdleTimeout);
  streamIdleTimeout = setTimeout(
    abortForTimeout,
    config.streamIdleTimeoutMs
  );
};
```

Immediately before `fetch`, arm response-start/whole-response and streaming maximum deadlines:

```javascript
providerTimeout = setTimeout(
  abortForTimeout,
  config.providerTimeoutMs
);
if (streaming) {
  streamMaxDurationTimeout = setTimeout(
    abortForTimeout,
    config.streamMaxDurationMs
  );
}
```

Immediately after `fetch` resolves for a streaming request, clear the response-start deadline. Keep redirect and non-success checks in their existing order; they execute synchronously before waiting for a body chunk:

```javascript
if (streaming) {
  clearTimeout(providerTimeout);
  providerTimeout = undefined;
}
```

Before entering either streaming relay, arm idle protection and pass the callback:

```javascript
if (streaming) {
  refreshStreamIdleTimeout();
  let streamUsage;
  try {
    streamUsage = await relayStream(
      response,
      res,
      controller.signal,
      filterSnapshot.output_mask_patterns,
      refreshStreamIdleTimeout
    );
  } catch (error) {
    if (error.code === 'filter_processing_failed') {
      abortRequest('filter');
      if (error.providerUsage) {
        recordUsage(
          reservation.requestId,
          req.user.id,
          req.gatewayModel,
          error.providerUsage.inputTokens,
          error.providerUsage.outputTokens,
          Date.now() - startedAt,
          { status: 'failure', errorType: 'filter' }
        );
        reservation = null;
        requestFinalized = true;
      }
    }
    throw error;
  }
  recordUsage(
    reservation.requestId,
    req.user.id,
    req.gatewayModel,
    streamUsage.inputTokens,
    streamUsage.outputTokens,
    Date.now() - startedAt
  );
  reservation = null;
  requestFinalized = true;
  return;
}
```

In `finally`, clear every handle:

```javascript
clearTimeout(providerTimeout);
clearTimeout(streamIdleTimeout);
clearTimeout(streamMaxDurationTimeout);
```

Change the byte-transparent relay signature and refresh before parsing or downstream write:

```javascript
async function relayStream(response, res, signal, outputPatterns, onChunk) {
  if (outputPatterns.length > 0) {
    return relayFilteredStream(
      response,
      res,
      signal,
      outputPatterns,
      onChunk
    );
  }
  setStreamHeaders(response, res);
  res.flushHeaders();
  const decoder = new TextDecoder();
  let pending = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const chunk of response.body) {
    onChunk();
    const text = decoder.decode(chunk, { stream: true });
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const usage = usageFromProvider(parsed);
        if (parsed.usage) {
          inputTokens = usage.inputTokens;
          outputTokens = usage.outputTokens;
        }
      } catch {}
    }
    if (!res.write(chunk)) await once(res, 'drain', { signal });
  }
  res.end();
  return { inputTokens, outputTokens };
}
```

Change the filtered relay signature and refresh at the same raw boundary:

```javascript
async function relayFilteredStream(response, res, signal, patterns, onChunk) {
  const streamState = createMaskState(patterns);
  const pending = createEventAccumulator();
  for await (const chunk of response.body) {
    onChunk();
    await writeCompleteEvents(
      response,
      res,
      signal,
      pending,
      chunk,
      streamState
    );
  }

  if (pending.length > 0) throw filterStreamError(streamState);
  const finalOutput = streamState.done ? [] : flushChoices(streamState, '\n\n');
  for (const event of finalOutput) {
    await writeStreamChunk(response, res, event, signal);
  }
  if (!res.headersSent) {
    setStreamHeaders(response, res);
    res.flushHeaders();
  }
  res.end();
  return {
    inputTokens: streamState.inputTokens,
    outputTokens: streamState.outputTokens
  };
}
```

- [ ] **Step 9: Run focused tests and verify green**

Run:

```powershell
node --test --test-name-pattern="timeout|outlives|maximum duration|raw chunks|backpressure" test/gateway.test.js
node --test --test-name-pattern="timeout|outlives|maximum duration|raw chunks|backpressure" test/filter-streaming.test.js
```

Expected: streaming start and filtered pre-header deadlines return 504; active streams outlive 100 ms; idle expires before the 1000 ms hard cap; progressing streams end at the hard cap; downstream backpressure is bounded.

- [ ] **Step 10: Run lifecycle and filtering regressions**

Run:

```powershell
node --test test/gateway.test.js test/filter-runtime.test.js test/filter-streaming.test.js test/server.test.js test/usage.test.js
```

Expected: disconnect, filtering failures, shutdown, reservations, backpressure, and concurrency cleanup all pass.

- [ ] **Step 11: Commit only streaming lifecycle paths**

```powershell
git add -- routes/v1.js test/gateway.test.js test/filter-streaming.test.js
git diff --cached --check -- routes/v1.js test/gateway.test.js test/filter-streaming.test.js
git commit --only -m "fix: keep active model streams alive" -- routes/v1.js test/gateway.test.js test/filter-streaming.test.js
```

---

### Task 5: Document the contract and run release verification

**Files:**
- Modify: `README.md` immediately after the content-filter plaintext warning and before `## 공급자와 모델`
- Modify: `docs/COMPATIBILITY.md` at the timeout row and immediately after the compatibility table
- Verify: `.dockerignore`, `Dockerfile`, `docker-compose.yml`, `package.json`, and all tests

**Interfaces:**
- Documents the three variables without introducing an alias.
- Documents 504 before downstream SSE headers and connection termination afterward.
- Requires proxy idle timeout greater than the configured stream idle timeout and proxy absolute lifetime greater than the configured stream maximum.

- [ ] **Step 1: Add exact operator documentation**

Insert this README section after the plaintext content-filter warning and before `## 공급자와 모델`:

```markdown
### 모델 응답 timeout

LLMWard는 다음 millisecond 단위 설정을 사용합니다.

- `LLMWARD_PROVIDER_TIMEOUT_MS=60000`: 비스트리밍 전체 응답 또는 스트리밍 upstream 응답 헤더 대기
- `LLMWARD_STREAM_IDLE_TIMEOUT_MS=120000`: 스트리밍 응답 헤더 이후 raw upstream body chunk 사이의 최대 무응답 시간
- `LLMWARD_STREAM_MAX_DURATION_MS=1800000`: upstream 요청 시작부터 스트림 종료까지의 절대 상한

진행 중인 스트림은 raw upstream body chunk를 받을 때마다 idle timeout을 갱신하지만 절대 상한은 갱신하지 않습니다. downstream backpressure로 LLMWard가 upstream을 더 읽지 못하는 동안에도 idle timeout은 계속 적용됩니다.

Timeout이 클라이언트에 SSE 응답 헤더를 보내기 전에 발생하면 HTTP 504 `provider_timeout`을 반환합니다. 이미 SSE 헤더를 보냈다면 JSON 또는 SSE 오류를 추가하지 않고 연결을 종료합니다.

기존 설치의 다른 제품명 접두사 timeout 설정은 읽지 않습니다. 기존 `.env`를 세 LLMWard 설정으로 직접 변경한 뒤 프로세스를 다시 시작하거나 컨테이너를 다시 생성해야 합니다. Compose의 `env_file` 변경은 `docker compose restart`로 다시 읽히지 않으므로 `docker compose up -d --force-recreate gateway`를 사용합니다.

reverse proxy의 read/idle timeout은 `LLMWARD_STREAM_IDLE_TIMEOUT_MS`보다 길어야 하며 기본 설정에서는 180초 이상을 권장합니다. 절대 연결 제한은 `LLMWARD_STREAM_MAX_DURATION_MS`보다 길게 설정하거나 이 경로에서 비활성화하고, SSE buffering은 비활성화하십시오.
```

Replace the compatibility timeout row with:

```markdown
| Timeout | 지원 | 비스트리밍 전체 응답과 streaming upstream 응답 헤더 대기는 `LLMWARD_PROVIDER_TIMEOUT_MS`, 진행 중 stream은 `LLMWARD_STREAM_IDLE_TIMEOUT_MS`·`LLMWARD_STREAM_MAX_DURATION_MS` 적용(기본 60초/2분/30분); 클라이언트 응답 헤더 전 timeout은 504 `provider_timeout`, 이후에는 연결 종료 |
```

Insert immediately after the table and before the existing streaming-provider paragraph:

```markdown
Streaming idle은 완성된 SSE event나 downstream write가 아니라 출력 필터 처리 전의 raw upstream body chunk 수신을 기준으로 갱신합니다. 따라서 필터가 event를 조립하는 동안에도 upstream bytes가 계속 도착하면 활성 상태로 취급합니다. downstream backpressure로 upstream 읽기가 중단된 동안에는 idle timeout이 계속 적용됩니다.
```

- [ ] **Step 2: Verify public documentation and deployment guards without printing secrets**

Run:

```powershell
foreach ($needle in @(
  'LLMWARD_PROVIDER_TIMEOUT_MS',
  'LLMWARD_STREAM_IDLE_TIMEOUT_MS',
  'LLMWARD_STREAM_MAX_DURATION_MS'
)) {
  rg -q -F -- $needle README.md .env.example
  if ($LASTEXITCODE -ne 0) { throw "Missing public setting documentation: $needle" }
}
rg -q -F -- 'provider_timeout' docs/COMPATIBILITY.md
if ($LASTEXITCODE -ne 0) { throw 'Missing timeout response contract' }
rg -q -F -- 'raw upstream body chunk' docs/COMPATIBILITY.md
if ($LASTEXITCODE -ne 0) { throw 'Missing raw chunk activity contract' }
node --test test/config.test.js test/setup.test.js test/operations.test.js
```

Expected: all non-printing content checks and tests pass. `test/operations.test.js` statically verifies `.dockerignore` exclusions for `.env`, data, database sidecars, backups, logs, and local artifacts.

- [ ] **Step 3: Run the full test suite**

Run:

```powershell
npm.cmd test
```

Expected: exit code 0 and zero failed tests.

- [ ] **Step 4: Run doctor against a temporary database**

Run from the repository root:

```powershell
$doctorRoot = Join-Path ([IO.Path]::GetTempPath()) ('llmward-doctor-' + [guid]::NewGuid().ToString('N'))
$doctorDatabase = Join-Path $doctorRoot 'gateway.db'
New-Item -ItemType Directory -Path $doctorRoot | Out-Null
$savedDatabasePath = $env:DATABASE_PATH
$savedAdminKey = $env:ADMIN_SECRET_KEY
try {
  $env:DATABASE_PATH = $doctorDatabase
  $env:ADMIN_SECRET_KEY = 'admin-' + [guid]::NewGuid().ToString('N')
  node -e "require('./db/migrations').runMigrations(); require('./db/database').close();"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npm.cmd run doctor
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  $env:DATABASE_PATH = $savedDatabasePath
  $env:ADMIN_SECRET_KEY = $savedAdminKey
  $resolvedDoctorRoot = [IO.Path]::GetFullPath($doctorRoot)
  $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (-not $resolvedDoctorRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Doctor cleanup path escaped the temporary directory'
  }
  Remove-Item -LiteralPath $resolvedDoctorRoot -Recurse -Force
}
```

Expected: doctor has no `FAIL` result and the active `.env`/database are not read or modified.

- [ ] **Step 5: Run benchmark, production audit, and Docker build verification**

Run:

```powershell
$benchmarkOutput = npm.cmd --silent run benchmark
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$benchmark = ($benchmarkOutput -join "`n") | ConvertFrom-Json
if ($benchmark.streaming.status -ne 200 -or -not $benchmark.streaming.received_done) {
  throw 'Benchmark streaming verification failed'
}
npm.cmd audit --omit=dev
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (Get-Command docker -ErrorAction SilentlyContinue) {
  docker compose build gateway
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: the benchmark explicitly proves status 200 and `[DONE]`; the production audit succeeds; when Docker is installed the statically guarded context builds. Do not run `docker compose config`, which can render values loaded from `.env`.

- [ ] **Step 6: Verify naming, whitespace, and scope**

Run:

```powershell
$legacyPattern = ('KER' + 'NEXA|Ker' + 'nexa|ker' + 'nexa')
git grep -q -I -E $legacyPattern -- .
if ($LASTEXITCODE -eq 0) {
  git grep -l -I -E $legacyPattern -- .
  throw 'Legacy product prefix remains in tracked files'
}
if ($LASTEXITCODE -ne 1) { exit $LASTEXITCODE }
git diff --check -- README.md docs/COMPATIBILITY.md
git status --short
```

Expected: no legacy-prefix filenames, no whitespace errors, and only intended timeout files plus unrelated pre-existing work in status output.

- [ ] **Step 7: Request final review and run completion verification**

Invoke `superpowers:requesting-code-review` against the approved design and all timeout commits. Address only findings within this plan's scope. Then invoke `superpowers:verification-before-completion` and rerun any command it requires from fresh output.

- [ ] **Step 8: Commit only documentation paths after verification**

```powershell
git add -- README.md docs/COMPATIBILITY.md
git diff --cached --check -- README.md docs/COMPATIBILITY.md
git commit --only -m "docs: explain streaming timeout policy" -- README.md docs/COMPATIBILITY.md
```
