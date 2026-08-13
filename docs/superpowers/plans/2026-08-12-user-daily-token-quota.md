# Unlimited User Daily Token Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new users default to unlimited daily input and output quotas, represented by configured value 0, while preserving positive limits and every existing user's stored values.

**Architecture:** Keep the existing two quota columns and interpret each independently in the application. The admin API writes explicit zero defaults, quota reservation skips only the daily limit calculation for a zero direction, and the existing reservation row still enforces provider output and lifecycle cleanup; no SQLite table rebuild or schema-version change is needed.

**Tech Stack:** Node.js 22+, CommonJS, Express, better-sqlite3, static HTML/JavaScript, Node.js built-in test runner

## Global Constraints

- `max_daily_input_tokens` and `max_daily_output_tokens` accept only safe integers greater than or equal to 0.
- Configured value 0 means unlimited for that direction; positive values retain the current daily-limit behavior.
- Existing users keep their stored quota values; only newly created users default to 0.
- Do not change `SCHEMA_VERSION`, rebuild the `users` table, or change SQLite column defaults.
- Preserve the model/request `max_tokens` cap and the single idempotent quota/concurrency cleanup path on success, error, timeout, disconnect, and shutdown.
- Preserve authentication, authorization, prepared statements, privacy invariants, safe DOM construction, CSP compatibility, and accessibility.
- Add no dependency, tokenizer, provider SDK, new quota column, nullable quota setting, or unlimited flag.
- Run migration tests only against temporary SQLite files; never use `data/gateway.db`.
- For `GET /dashboard/usage`, an unlimited direction has `remainingInput` or `remainingOutput` equal to `null`; an exhausted positive quota remains 0.

## File Map

- `routes/admin.js`: validate non-negative quota values and provide zero defaults for supported user creation and update APIs.
- `db/migrations.js`: accept persisted zero quotas during fail-closed startup validation without changing the schema.
- `services/usage.js`: skip only the applicable daily quota check when its configured value is 0, while retaining output reservation and provider-overrun validation.
- `routes/v1.js`: distinguish unlimited remaining quota (`null`) from an exhausted positive quota (`0`).
- `test/gateway.test.js`: cover API defaults, zero updates, invalid values, unlimited runtime behavior, mixed quota configurations, and usage responses.
- `test/migrations.test.js`: cover repeated startup migration with a current database containing zero quotas.
- `public/admin-dashboard.html`: default both quota inputs to 0 and explain the sentinel in accessible labels.
- `public/admin-dashboard.js`: label zero quotas as `Unlimited` and clarify edit prompts.
- `test/admin-dashboard.test.js`: verify rendered unlimited labels and edit-prompt guidance through the existing dashboard harness.
- `docs/API.md`: document the quota contract and the existing post-response input-accounting limitation.

---

### Task 1: Implement the backend zero-quota contract

**Files:**
- Modify: `test/gateway.test.js:306-316,483-505,625-643`
- Modify: `test/migrations.test.js:500-546`
- Modify: `routes/admin.js:71-74,322-371`
- Modify: `db/migrations.js:87-99`
- Modify: `services/usage.js:47-91`
- Modify: `routes/v1.js:579-590`

**Interfaces:**
- Consumes: authenticated user rows with numeric `max_daily_input_tokens` and `max_daily_output_tokens`, the existing `reserveQuota(user, requestedMaxTokens, modelMaxTokens)` function, and the existing `/dashboard/usage` response.
- Produces: admin create/update acceptance of safe integers `>= 0`; omitted create quotas stored as 0; `reserveQuota` treating each zero independently as unbounded; `remainingInput`/`remainingOutput` returning `number | null`.

- [ ] **Step 1: Add failing admin and runtime regression tests**

Add the first five tests below to `test/gateway.test.js` after `user creation authenticates and user lists never disclose tokens`. Add the final two mixed-quota tests immediately after the existing `output quota is enforced` test so their `input-limit` and `output-limit` provider calls do not change the existing exact call-count assertions:

```js
test('new users default both daily token quotas to unlimited', async () => {
  const created = await admin('/admin/users', {
    method: 'POST', body: { username: 'default-unlimited-user', allowed_models: ['standard'] }
  });
  assert.equal(created.status, 201);
  const defaultUser = (await admin('/admin/users')).body.find((user) => user.id === created.body.userId);
  assert.deepEqual({
    input: defaultUser.max_daily_input_tokens,
    output: defaultUser.max_daily_output_tokens
  }, { input: 0, output: 0 });
});

test('user quota updates accept zero', async () => {

  const limited = await createUser('zero-update-user', ['standard'], 5, 6);
  const updated = await admin(`/admin/users/${limited.id}`, {
    method: 'PUT', body: { max_daily_input_tokens: 0, max_daily_output_tokens: 0 }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.max_daily_input_tokens, 0);
  assert.equal(updated.body.max_daily_output_tokens, 0);
});

test('zero daily quotas allow repeated requests', async () => {
  const user = await createUser('unlimited-runtime-user', ['standard'], 0, 0);

  assert.equal((await chat(user.token, 'standard', 1)).status, 200);
  assert.equal((await chat(user.token, 'standard', 1)).status, 200);
});

test('zero output quota preserves request and model output limits', async () => {
  const user = await createUser('unlimited-maximum-user', ['standard'], 0, 0);
  const before = (receivedMaximums.get('standard') || []).length;

  assert.equal((await chat(user.token, 'standard', 999999)).status, 200);
  assert.equal((await chat(user.token, 'standard', 2)).status, 200);
  assert.deepEqual(receivedMaximums.get('standard').slice(before), [8, 2]);
});

test('usage reports null remaining tokens for unlimited quotas', async () => {
  const user = await createUser('unlimited-usage-user', ['standard'], 0, 0);

  const usage = await request('/dashboard/usage', {
    headers: { Authorization: `Bearer ${user.token}` }
  });
  assert.equal(usage.status, 200);
  assert.equal(usage.body.remainingInput, null);
  assert.equal(usage.body.remainingOutput, null);
});

test('zero input quota leaves a positive output quota enforced', async () => {
  const outputLimited = await createUser('unlimited-input-user', ['output-limit'], 0, 2);
  assert.equal((await chat(outputLimited.token, 'output-limit', 2)).status, 200);
  assert.equal((await chat(outputLimited.token, 'output-limit', 1)).status, 429);
});

test('zero output quota leaves a positive input quota enforced', async () => {
  const inputLimited = await createUser('unlimited-output-user', ['input-limit'], 2, 0);
  assert.equal((await chat(inputLimited.token, 'input-limit', 1)).status, 200);
  assert.equal((await chat(inputLimited.token, 'input-limit', 1)).status, 429);
});
```

In `admin input validation rejects unsafe values and references`, replace the case that rejects zero and add explicit non-negative-integer boundary failures:

```js
    admin('/admin/users', { method: 'POST', body: { username: 'negative-input-quota', max_daily_input_tokens: -1, max_daily_output_tokens: 1 } }),
    admin('/admin/users', { method: 'POST', body: { username: 'negative-output-quota', max_daily_input_tokens: 1, max_daily_output_tokens: -1 } }),
    admin('/admin/users', { method: 'POST', body: { username: 'fractional-quota', max_daily_input_tokens: 1.5, max_daily_output_tokens: 1 } }),
    admin('/admin/users', { method: 'POST', body: { username: 'unsafe-quota', max_daily_input_tokens: 1, max_daily_output_tokens: Number.MAX_SAFE_INTEGER + 1 } }),
```

- [ ] **Step 2: Add the failing repeated-migration regression test**

Add this test to `test/migrations.test.js` immediately after `migration is repeatable on an already-current database`:

```js
test('current database preserves positive and accepts zero user quotas on repeated migration', () => {
  const file = databasePath('zero-user-quotas');
  assertMigrated(migrate(file));

  const current = open(file);
  const insert = current.prepare(`
    INSERT INTO users
      (username, api_token, max_daily_input_tokens, max_daily_output_tokens)
    VALUES (?, ?, ?, ?)
  `);
  insert.run('zero-quota-user', 'zero-quota-token', 0, 0);
  insert.run('limited-quota-user', 'limited-quota-token', 17, 19);
  current.close();

  assertMigrated(migrate(file));
  assertMigrated(migrate(file));
  const checked = open(file, { readonly: true });
  assert.deepEqual(checked.prepare(`
    SELECT username, max_daily_input_tokens, max_daily_output_tokens
    FROM users WHERE username IN (?, ?) ORDER BY username
  `).all('zero-quota-user', 'limited-quota-user'), [
    {
      username: 'limited-quota-user',
      max_daily_input_tokens: 17,
      max_daily_output_tokens: 19
    },
    { username: 'zero-quota-user', max_daily_input_tokens: 0, max_daily_output_tokens: 0 }
  ]);
  assert.equal(checked.pragma('user_version', { simple: true }), 3);
  checked.close();
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="new users default|user quota updates|zero daily quotas|zero output quota|usage reports null|zero input quota|positive input quota|admin input validation" test/gateway.test.js
node --test --test-name-pattern="zero user quotas" test/migrations.test.js
```

Expected: the gateway command fails because omitted quotas are still 100000/50000 and zero is rejected; the migration command fails with `Legacy user data contains invalid or NULL required values`.

- [ ] **Step 4: Accept zero and default new admin users to zero**

Add this helper after `positive` in `routes/admin.js`:

```js
function nonNegative(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, `${name} must be a non-negative safe integer`);
  }
  return value;
}
```

Use it only for the two user quota fields:

```js
    const inputQuota = req.body.max_daily_input_tokens === undefined
      ? 0
      : nonNegative(req.body.max_daily_input_tokens, 'max_daily_input_tokens');
    const outputQuota = req.body.max_daily_output_tokens === undefined
      ? 0
      : nonNegative(req.body.max_daily_output_tokens, 'max_daily_output_tokens');
```

```js
    if (req.body.max_daily_input_tokens !== undefined) {
      fields.push('max_daily_input_tokens = ?');
      values.push(nonNegative(req.body.max_daily_input_tokens, 'max_daily_input_tokens'));
    }
    if (req.body.max_daily_output_tokens !== undefined) {
      fields.push('max_daily_output_tokens = ?');
      values.push(nonNegative(req.body.max_daily_output_tokens, 'max_daily_output_tokens'));
    }
```

Keep `positive` unchanged for IDs, request-per-minute, concurrency, and model limits.

- [ ] **Step 5: Accept stored zero quotas and implement independent unlimited runtime behavior**

In `db/migrations.js`, change only the two quota comparisons in `assertLegacyUsers`:

```js
       OR typeof(max_daily_input_tokens) != 'integer' OR max_daily_input_tokens < 0
       OR typeof(max_daily_output_tokens) != 'integer' OR max_daily_output_tokens < 0
```

In `services/usage.js`, allow non-negative stored quota values, guard the input check, and calculate output remaining only for a positive output quota:

```js
  if (!Number.isSafeInteger(user.max_daily_input_tokens) || user.max_daily_input_tokens < 0 ||
      !Number.isSafeInteger(user.max_daily_output_tokens) || user.max_daily_output_tokens < 0) {
    throw new ApiError(500, 'User quota configuration is invalid');
  }
```

```js
    if (user.max_daily_input_tokens > 0 &&
        usage.input_tokens >= user.max_daily_input_tokens) {
      throw new ApiError(429, 'Daily input token quota exceeded');
    }

    let remaining = modelMaxTokens;
    if (user.max_daily_output_tokens > 0) {
      const reserved = db.prepare(`
        SELECT COALESCE(SUM(output_tokens), 0) AS tokens
        FROM quota_reservations WHERE user_id = ? AND request_date = ?
      `).get(user.id, date).tokens;
      remaining = user.max_daily_output_tokens - usage.output_tokens - reserved;
      if (!Number.isSafeInteger(remaining) || remaining <= 0) {
        throw new ApiError(429, 'Daily output token quota exceeded');
      }
    }

    const maxTokens = Math.min(requestedMaxTokens || modelMaxTokens, modelMaxTokens, remaining);
```

Do not change the reservation insert or `recordUsage`: even unlimited output must reserve `maxTokens` so provider output cannot exceed the forwarded maximum and every cleanup path remains unchanged.

In `routes/v1.js`, make unlimited remaining values explicit without changing positive-quota responses:

```js
      remainingInput: req.user.max_daily_input_tokens === 0
        ? null
        : Math.max(0, req.user.max_daily_input_tokens - usage.input_tokens),
      remainingOutput: req.user.max_daily_output_tokens === 0
        ? null
        : Math.max(0, req.user.max_daily_output_tokens - usage.output_tokens)
```

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="new users default|user quota updates|zero daily quotas|zero output quota|usage reports null|zero input quota|positive input quota|admin input validation" test/gateway.test.js
node --test --test-name-pattern="zero user quotas" test/migrations.test.js
```

Expected: both commands pass with zero failures.

- [ ] **Step 7: Re-run the existing positive-quota and cleanup regressions**

Run:

```powershell
node --test --test-name-pattern="input quota|output quota|concurrent requests cannot oversubscribe|recordUsage applies|disconnect aborts upstream and releases quota|abortInFlight aborts" test/gateway.test.js
```

Expected: all matched tests pass, including the existing exhausted-positive-quota assertion `remainingOutput === 0`.

- [ ] **Step 8: Check and commit the backend slice**

Run:

```powershell
git diff --check
git status --short
git add -- routes/admin.js db/migrations.js services/usage.js routes/v1.js test/gateway.test.js test/migrations.test.js
git commit -m "feat: support unlimited user token quotas"
```

### Task 2: Expose the zero-quota contract in the dashboard and API guide

**Files:**
- Modify: `test/admin-dashboard.test.js:155-162`
- Modify: `test/gateway.test.js:246-280`
- Modify: `public/admin-dashboard.html:23`
- Modify: `public/admin-dashboard.js:2,13-18`
- Modify: `docs/API.md:13-17`

**Interfaces:**
- Consumes: admin user responses where both quota properties are non-negative integers and configured zero means unlimited.
- Produces: create-form values `0`, visible `Unlimited` cells for zero quotas, edit guidance that accepts zero, and API documentation for defaults, independent enforcement, and `null` remaining values.

- [ ] **Step 1: Add failing dashboard behavior regression tests**

Extend `createDashboardHarness` to return the fake window and `#users-content`, then add small recursive test helpers that collect rendered text and find a button.

Add an async `dashboard renders zero quotas as unlimited and explains zero while editing` test. Return one zero-quota user from `/admin/users`, assert the rendered table contains exactly two `Unlimited` values, click `Edit`, and assert both prompt labels say `(0 = unlimited)` with initial value `0`.

Add an `admin dashboard serves zero quota form defaults` HTTP-boundary test to `test/gateway.test.js` after the security-header test. Fetch `/admin/` and assert both named quota inputs have `min="0"` and `value="0"`, with visible `(0 = unlimited)` labels.

- [ ] **Step 2: Run the focused dashboard tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="dashboard renders zero quotas" test/admin-dashboard.test.js
node --test --test-name-pattern="admin dashboard serves zero quota form defaults" test/gateway.test.js
```

Expected: both commands fail because the form still uses minimum 1 and 100000/50000 defaults, rendered zero values are `0`, and edit prompts do not explain the sentinel.

- [ ] **Step 3: Update the form, prompts, and quota rendering**

In `public/admin-dashboard.html`, replace only the two quota labels in `#user-form`:

```html
<label>Daily input quota (0 = unlimited) <input name="inputQuota" type="number" min="0" value="0" required></label><label>Daily output quota (0 = unlimited) <input name="outputQuota" type="number" min="0" value="0" required></label>
```

In the `T` object in `public/admin-dashboard.js`, use:

```js
promptInput:'Daily input quota (0 = unlimited)',promptOutput:'Daily output quota (0 = unlimited)'
```

Add the formatter immediately after `number`:

```js
  function quota(value){return value===0?'Unlimited':number(value)}
```

Change only the two quota cells in `renderUsers`:

```js
quota(user.max_daily_input_tokens),quota(user.max_daily_output_tokens)
```

Continue to construct DOM nodes through `node`, `textContent`, and `document.createTextNode`; do not add `innerHTML`.

- [ ] **Step 4: Document the API quota contract**

Add this section in `docs/API.md` after the token-management paragraph:

```markdown
## 사용자 일일 토큰 한도

`max_daily_input_tokens`와 `max_daily_output_tokens`는 서로 독립적인 0 이상의 safe integer입니다. 사용자 생성 시 생략하면 각각 0으로 저장되며, 0은 해당 방향의 일일 한도가 없음을 뜻합니다. 양수는 해당 방향의 일일 한도이고 기존 사용자의 저장값은 자동으로 변경되지 않습니다.

출력 한도는 요청의 `max_tokens`와 모델 최대값 안에서 예약되어 동시 초과 사용을 막습니다. 입력 사용량은 공급자 응답 후 확정되므로 양수 입력 한도는 한 요청의 실제 입력 토큰만큼 초과될 수 있으며, 한도에 도달한 뒤의 요청부터 HTTP 429로 거부됩니다.

`GET /dashboard/usage`의 `remainingInput`과 `remainingOutput`은 양수 한도에서는 남은 토큰 수를 반환합니다. 해당 방향이 무제한이면 `null`, 양수 한도를 소진했으면 0입니다.
```

- [ ] **Step 5: Run the focused dashboard tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="dashboard renders zero quotas" test/admin-dashboard.test.js
node --test --test-name-pattern="admin dashboard serves zero quota form defaults" test/gateway.test.js
```

Expected: both commands pass with no unsafe DOM sink introduced.

- [ ] **Step 6: Run the complete regression suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass with zero failures. The suite uses temporary directories and SQLite files only.

- [ ] **Step 7: Inspect and commit the user-facing slice**

Run:

```powershell
git diff --check
git status --short
git diff -- routes/admin.js db/migrations.js services/usage.js routes/v1.js public/admin-dashboard.html public/admin-dashboard.js docs/API.md test/gateway.test.js test/migrations.test.js test/admin-dashboard.test.js
git add -- public/admin-dashboard.html public/admin-dashboard.js docs/API.md test/admin-dashboard.test.js test/gateway.test.js
git commit -m "feat: show unlimited user token quotas"
git status --short
```

Expected: the final status is clean and the two implementation commits contain only the quota feature.
