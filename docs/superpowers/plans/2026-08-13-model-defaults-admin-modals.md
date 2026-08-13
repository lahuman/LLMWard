# Per-Model Defaults and Admin CRUD Modals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add nullable per-model context metadata and typed generation defaults, apply those defaults safely to omitted chat fields, and replace user/model/provider browser prompts and inline create forms with accessible native modal CRUD workflows.

**Architecture:** Extend `models` with six nullable typed columns in schema v4, expose them through the existing model administration routes, and merge only five allowlisted generation defaults after input filtering but before the existing quota-controlled `max_tokens` and payload-size check. Keep the dashboard dependency-free by reusing its safe DOM helpers and adding native `<dialog>` forms plus one shared destructive-confirmation dialog; server-side validation and deletion guards remain authoritative.

**Tech Stack:** Node.js 22+, CommonJS, Express 5, better-sqlite3, static HTML/CSS/JavaScript, native `<dialog>`, Node.js built-in test runner

## Global Constraints

- `context_window` is nullable metadata owned by a registered model; it records but never changes the provider runtime context.
- Nullable stored generation defaults are exactly `temperature` 0..2, `top_p` 0..1, `presence_penalty` -2..2, `frequency_penalty` -2..2, and signed safe-integer `seed`.
- Apply a stored default only when the filtered client body does not own that request field. Preserve explicit client `0` and `null` values.
- Precedence is gateway security/routing/quota enforcement, explicit client field, model default, then provider default.
- Keep `max_tokens` as the independent positive maximum-output field and reject any stored row where non-null `context_window < max_tokens`.
- Do not persist or log prompts, messages, system prompts, generated content, provider error bodies, raw tokens, administrator keys, or provider credentials.
- Do not send `context_window` or provider-specific context/load options upstream. Do not add arbitrary JSON defaults or use `model_config`.
- Preserve unknown and vendor request fields, registered-provider URL enforcement, redirect rejection, authorization, quota/concurrency cleanup, filtering, streaming, and the post-merge 1 MiB limit.
- Keep `CONTENT_FILTER_SCHEMA_VERSION = 3`; move only application `SCHEMA_VERSION` from 3 to 4.
- Every migration test uses temporary SQLite files and never `data/gateway.db`.
- Add no dependency, provider SDK, tokenizer, session store, prompt trimming, retry, fallback, or provider adapter.
- Use prepared statements for values, safe DOM construction and `textContent`, CSP-compatible external assets, and accessible modal names/descriptions/status regions.
- User DELETE remains soft deactivation. Model/provider hard-delete guards remain server-side and never auto-detach related records.
- A blank provider credential in edit mode means unchanged; only the explicit removal control clears it.

## File Map

- `db/schema.js`: raise the supported application schema version to 4.
- `db/migrations.js`: define and idempotently add the six nullable model columns.
- `test/migrations.test.js`: cover empty, v3, legacy/partial, repeat, current, future-v5, WAL, and data-preservation fixtures.
- `test/backup.test.js`: update current/future schema expectations and verified backup history.
- `docs/MIGRATIONS.md`: document schema v4.
- `routes/admin.js`: validate, persist, list, update, clear, relate, and audit the six model fields.
- `test/admin-models.test.js`: focused real-HTTP tests for typed model CRUD and atomic relationship validation.
- `services/provider-router.js`: expose only `context_window` through the active-model listing query.
- `routes/v1.js`: return public context metadata, load five private defaults for chat, and merge omitted fields.
- `test/gateway.test.js`: cover public context metadata and schema-dependent gateway/backup expectations.
- `test/filter-runtime.test.js`: cover default precedence, streaming parity, passthrough, context non-forwarding, and post-merge size enforcement.
- `public/admin-dashboard.html`: replace three inline create cards with create buttons and four labelled native dialogs.
- `public/admin-dashboard.css`: add only dialog, section-heading, and dialog-action styles.
- `public/admin-dashboard.js`: replace resource prompts/confirms with modal controllers and typed payload builders.
- `test/admin-dashboard.test.js`: extend the fake DOM/dialog harness and cover modal lifecycle and all resource workflows.
- `docs/API.md`: document fields, ranges, clearing, precedence, stateless conversations, and post-default size checks.
- `docs/COMPATIBILITY.md`: document `/v1/models` context metadata and omitted-field default behavior.
- `README.md`: clarify conversation history ownership, maximum output tokens, and informational context metadata.

---

### Task 1: Migrate SQLite to schema v4 without changing existing model data

**Files:**
- Modify: `test/migrations.test.js:66-75,94-122,182-235,500-634`
- Modify: `test/backup.test.js:83-121,287-326`
- Modify: `test/gateway.test.js:851-863,1266-1280`
- Modify: `db/schema.js:1-2`
- Modify: `db/migrations.js:10-25,148-161,269-275`
- Modify: `docs/MIGRATIONS.md`

**Interfaces:**
- Consumes: existing `runMigrations(): void`, atomic `BEGIN IMMEDIATE` migration, integrity/foreign-key checks, and schema-v3 databases.
- Produces: `SCHEMA_VERSION = 4`, unchanged `CONTENT_FILTER_SCHEMA_VERSION = 3`, and nullable columns `context_window`, `default_temperature`, `default_top_p`, `default_presence_penalty`, `default_frequency_penalty`, `default_seed` on every valid `models` table.

- [ ] **Step 1: Make empty and v3-upgrade migration tests expect the exact v4 columns**

Rename the first migration test and add this exact column assertion after opening the migrated database:

```js
test('empty database migrates to schema 4 with nullable model defaults', () => {
  const file = databasePath('empty-v4');
  assertMigrated(migrate(file));
  const database = open(file, { readonly: true });
  assert.equal(database.pragma('user_version', { simple: true }), 4);
  const columns = new Map(database.prepare('PRAGMA table_info(models)').all()
    .map((column) => [column.name, column]));
  assert.deepEqual(
    ['context_window', 'default_temperature', 'default_top_p',
      'default_presence_penalty', 'default_frequency_penalty', 'default_seed']
      .map((name) => ({
        name,
        type: columns.get(name).type,
        notnull: columns.get(name).notnull,
        defaultValue: columns.get(name).dflt_value
      })),
    [
      { name: 'context_window', type: 'INTEGER', notnull: 0, defaultValue: null },
      { name: 'default_temperature', type: 'REAL', notnull: 0, defaultValue: null },
      { name: 'default_top_p', type: 'REAL', notnull: 0, defaultValue: null },
      { name: 'default_presence_penalty', type: 'REAL', notnull: 0, defaultValue: null },
      { name: 'default_frequency_penalty', type: 'REAL', notnull: 0, defaultValue: null },
      { name: 'default_seed', type: 'INTEGER', notnull: 0, defaultValue: null }
    ]
  );
  database.close();
});
```

Add `version 3 schema upgrades to version 4 preserving model and related data`. Build the v3 fixture with the existing subprocess migration helper, drop the six columns only when present, set `PRAGMA user_version = 3`, and insert markers for provider binding, `max_tokens`, prices, `model_config`, user `allowed_models`, and a `content_filter_models` assignment. After migration assert the marker row is unchanged and all six new values are null:

```js
assert.deepEqual(checked.prepare(`
  SELECT model_name, provider_id, max_tokens, input_cost_per_million,
         output_cost_per_million, model_config, context_window,
         default_temperature, default_top_p, default_presence_penalty,
         default_frequency_penalty, default_seed
  FROM models WHERE model_name = 'v3-preserved-model'
`).get(), {
  model_name: 'v3-preserved-model', provider_id,
  max_tokens: 777, input_cost_per_million: 1.25,
  output_cost_per_million: 2.5, model_config: '{"preserve":true}',
  context_window: null, default_temperature: null, default_top_p: null,
  default_presence_penalty: null, default_frequency_penalty: null,
  default_seed: null
});
```

- [ ] **Step 2: Update partial, repeated, current, future, backup, and gateway schema tests**

Change every successful migration/current-backup expectation from 3 to 4. Keep v2 content-filter fixtures as v2 inputs but expect v4 outputs. In `migration is repeatable on an already-current database`, set all six fields and assert they survive two more calls:

```js
current.prepare(`
  UPDATE models SET context_window = 8192, default_temperature = 0,
    default_top_p = 0.75, default_presence_penalty = -1.5,
    default_frequency_penalty = 1.25, default_seed = 0
  WHERE id = ?
`).run(modelId);
```

Move all future-schema fixtures and names from v4 to v5, including checkpointed/uncheckpointed WAL helpers. A valid main file is v4; the future marker is v5. Update verified backup/history expectations to schema 4 and the deliberately unsupported backup fixture to schema 5.

- [ ] **Step 3: Run migration and backup tests to verify RED**

Run:

```powershell
node --test test/migrations.test.js
node --test test/backup.test.js
node --test --test-name-pattern="database integrity remains valid|online backup" test/gateway.test.js
```

Expected: failures report actual schema 3, missing model columns, or v4 being accepted as current where the updated test expects future v5 rejection.

- [ ] **Step 4: Add the nullable columns through the existing migration path**

Set only the application version in `db/schema.js`:

```js
const SCHEMA_VERSION = 4;
const CONTENT_FILTER_SCHEMA_VERSION = 3;
```

Add the six names to `REQUIRED_COLUMNS.models`. Add these definitions before `model_config` in the canonical `CREATE TABLE models` statement:

```sql
context_window INTEGER,
default_temperature REAL,
default_top_p REAL,
default_presence_penalty REAL,
default_frequency_penalty REAL,
default_seed INTEGER,
```

Extend only the existing `addMissingColumns('models', ...)` call:

```js
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
```

Do not rebuild `models`, infer values, add defaults/check constraints, or alter the migration transaction/checkpoint flow.

- [ ] **Step 5: Document v4 and verify GREEN**

Add a v4 row to `docs/MIGRATIONS.md` stating that six nullable per-model metadata/default columns are added without changing existing rows. Then run:

```powershell
node --test test/migrations.test.js
node --test test/backup.test.js
node --test --test-name-pattern="database integrity remains valid|online backup" test/gateway.test.js
```

Expected: all selected tests pass and every existing row keeps its previous values and relationships.

- [ ] **Step 6: Check and commit the schema slice**

```powershell
git diff --check
git add -- db/schema.js db/migrations.js test/migrations.test.js test/backup.test.js test/gateway.test.js docs/MIGRATIONS.md
git commit -m "feat: add per-model default columns"
```

### Task 2: Add typed model-default CRUD and atomic capacity validation

**Files:**
- Create: `test/admin-models.test.js`
- Modify: `routes/admin.js:20-26,79-165,483-578`

**Interfaces:**
- Consumes: schema-v4 model columns and existing authenticated `/admin/models` CRUD/audit behavior.
- Produces: admin model responses containing all six fields; create/update validation helpers; explicit-null clearing; atomic `max_tokens <= context_window` enforcement.

- [ ] **Step 1: Create a focused real-HTTP admin model test fixture**

Follow `test/admin-filters.test.js`: create an isolated temp database, random admin key, real Express server, and one dummy HTTPS provider. Use this cleanup so every test starts without models or model audit rows:

```js
beforeEach(() => {
  db.prepare('DELETE FROM content_filter_models').run();
  db.prepare('DELETE FROM user_tokens').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM models').run();
  db.prepare("DELETE FROM audit_logs WHERE target_type IN ('model', 'user', 'token')").run();
});
```

Add helpers `request`, `admin`, and:

```js
function modelPayload(overrides = {}) {
  return {
    model_name: 'typed-model', display_name: 'Typed Model',
    provider_id: providerId, ...overrides
  };
}
```

- [ ] **Step 2: Add failing CRUD, boundary, atomicity, and audit tests**

Add seven tests with these exact names and assertions:

| Test name | Required setup and assertions |
|---|---|
| `admin model creation stores omitted defaults as null and keeps max_tokens at 4096` | POST the base payload; require 201, `max_tokens === 4096`, and all six fields strictly null in both response and GET row. |
| `admin model defaults create list partially update and clear with explicit null` | POST the full valid defaults, compare all six response/list values, PUT only temperature/seed, assert other values unchanged, then PUT six nulls and assert six nulls. |
| `admin model defaults accept documented numeric boundaries` | Create separate uniquely named rows for each min/max combination: context 1 with `max_tokens:1`, context `MAX_SAFE_INTEGER`, temperature 0/2, top-p 0/1, penalties -2/2, seed `MIN_SAFE_INTEGER`/`MAX_SAFE_INTEGER`; require 201. |
| `admin model defaults reject invalid types ranges and unsafe integers atomically` | For every invalid pair below, POST a unique model, require 400, then require no row with that name. |
| `admin model context relationship validates effective create and partial-update values` | Exercise the five create/update relationship cases described below and re-GET after each failure to prove both values are unchanged. |
| `invalid model capacity updates do not rename the model or its user permissions` | Create model+user permission, PUT an invalid name/capacity combination, require 400, then assert the old model name and exact old `allowed_models` remain. |
| `admin model audits store only changed default field names` | PUT distinctive default values, query the latest `model.update` audit row, parse `changed_fields`, assert the exact submitted supported names and assert serialized audit data contains none of the distinctive values. |

Use this valid full payload and assert it round-trips through POST, GET, partial PUT, and explicit-null PUT:

```js
const defaults = {
  context_window: 8192,
  default_temperature: 0,
  default_top_p: 1,
  default_presence_penalty: -2,
  default_frequency_penalty: 2,
  default_seed: 0
};
```

Drive invalid cases as HTTP JSON values, not `NaN`/Infinity, which stringify to null:

```js
const invalid = [
  ['context_window', 0], ['context_window', 1.5],
  ['context_window', Number.MAX_SAFE_INTEGER + 1], ['context_window', '8192'],
  ['default_temperature', -0.01], ['default_temperature', 2.01],
  ['default_temperature', ''], ['default_temperature', '1'],
  ['default_top_p', -0.01], ['default_top_p', 1.01], ['default_top_p', '1'],
  ['default_presence_penalty', -2.01], ['default_presence_penalty', 2.01],
  ['default_presence_penalty', '-1'],
  ['default_frequency_penalty', -2.01], ['default_frequency_penalty', 2.01],
  ['default_frequency_penalty', '1'],
  ['default_seed', 1.5], ['default_seed', Number.MAX_SAFE_INTEGER + 1],
  ['default_seed', '0']
];
```

For relationship atomicity, assert: context 4095 with omitted max fails; stored max 100/context 200 rejects context 99 and max 201; `{max_tokens:300,context_window:300}` succeeds; `{max_tokens:500,context_window:null}` succeeds. Combine an invalid capacity update with `model_name:'must-not-stick'` and verify both the model name and every `users.allowed_models` value remain unchanged.

- [ ] **Step 3: Run the focused test to verify RED**

```powershell
node --test test/admin-models.test.js
```

Expected: new fields are absent/ignored, default-only PUT returns `No supported fields were provided`, invalid relationships succeed, and audit field names are missing.

- [ ] **Step 4: Add minimal nullable validators and effective-row validation**

Add these helpers beside the existing numeric validators:

```js
function nullablePositive(value, name) {
  return value === null ? null : positive(value, name);
}

function nullableRange(value, name, minimum, maximum) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ApiError(400, `${name} must be null or a finite number from ${minimum} through ${maximum}`);
  }
  return value;
}

function nullableSafeInteger(value, name) {
  if (value !== null && !Number.isSafeInteger(value)) {
    throw new ApiError(400, `${name} must be null or a safe integer`);
  }
  return value;
}

function assertModelCapacity(maxTokens, contextWindow) {
  if (contextWindow !== null && maxTokens > contextWindow) {
    throw new ApiError(400, 'max_tokens must not exceed context_window');
  }
}
```

Normalize POST omission to null, validate the effective default `max_tokens = 4096`, include the six columns in INSERT/response, and extend both model audit allowlists with the exact six names.

For PUT, load `model_name, max_tokens, context_window`; calculate validated effective max/context before constructing or executing the rename transaction:

```js
const nextMaxTokens = Object.hasOwn(req.body, 'max_tokens')
  ? positive(req.body.max_tokens, 'max_tokens')
  : existingModel.max_tokens;
const nextContextWindow = Object.hasOwn(req.body, 'context_window')
  ? nullablePositive(req.body.context_window, 'context_window')
  : existingModel.context_window;
assertModelCapacity(nextMaxTokens, nextContextWindow);
```

For each nullable field, omission adds no SQL assignment and explicit null adds SQL `NULL`. Keep prepared statement values and the existing immediate transaction for rename+permission updates.

- [ ] **Step 5: Verify focused and existing model regressions GREEN**

```powershell
node --test test/admin-models.test.js
node --test --test-name-pattern="model identifiers can be renamed|successful admin audits|admin input validation" test/gateway.test.js
```

Expected: all tests pass; invalid capacity never partially renames a model or permission.

- [ ] **Step 6: Check and commit the admin API slice**

```powershell
git diff --check
git add -- routes/admin.js test/admin-models.test.js
git commit -m "feat: manage typed model defaults"
```

### Task 3: Expose context metadata and apply model defaults to chat requests

**Files:**
- Modify: `test/gateway.test.js:34-50,996-1018`
- Modify: `test/filter-runtime.test.js:255-270,391-449,546-610`
- Modify: `services/provider-router.js:131-140`
- Modify: `routes/v1.js:13-70,120-150`

**Interfaces:**
- Consumes: validated nullable model columns from Tasks 1-2 and the existing filtered chat body/quota reservation.
- Produces: public `context_window: number | null`; private own-property default insertion for five fields; unchanged quota/passthrough/streaming behavior.

- [ ] **Step 1: Add a failing public model metadata test**

In `test/gateway.test.js`, update `standard` directly inside the test and restore it with `t.after`. Authenticate an all-model user and assert:

```js
test('public model listing exposes context metadata but not generation defaults', async (t) => {
  db.prepare(`UPDATE models SET context_window = 8192, default_temperature = 1.25,
    default_top_p = 0.75, default_presence_penalty = -1,
    default_frequency_penalty = 1, default_seed = 37
    WHERE model_name = 'standard'`).run();
  t.after(() => db.prepare(`UPDATE models SET context_window = NULL,
    default_temperature = NULL, default_top_p = NULL,
    default_presence_penalty = NULL, default_frequency_penalty = NULL,
    default_seed = NULL WHERE model_name = 'standard'`).run());
  const user = await createUser('public-model-metadata-user', []);
  const response = await request('/v1/models', {
    headers: { Authorization: `Bearer ${user.token}` }
  });
  const configured = response.body.find((model) => model.id === 'standard');
  const unknown = response.body.find((model) => model.id === 'input-limit');
  assert.equal(configured.max_tokens, 8);
  assert.equal(configured.context_window, 8192);
  assert.equal(unknown.context_window, null);
  for (const field of ['default_temperature', 'default_top_p',
    'default_presence_penalty', 'default_frequency_penalty', 'default_seed']) {
    assert.equal(Object.hasOwn(configured, field), false);
  }
});
```

- [ ] **Step 2: Add failing runtime precedence, streaming, and size tests**

In `test/filter-runtime.test.js`, use direct model UPDATE plus `t.after` restoration so runtime tests do not duplicate admin API behavior.

`model generation precedence applies stored defaults only to omitted own properties` must make four requests and inspect captured upstream payloads:

1. Omitted fields receive `1.25`, `0`, `-1.5`, `1.5`, `37`; vendor extension remains deep-equal; model remains selected; `max_tokens` remains model-clamped; no `context_window` key exists.
2. Five explicit zeros remain zeros.
3. Five explicit nulls remain owned nulls.
4. A model with all defaults null leaves all five fields absent.

Add `streaming applies the same model generation precedence`: explicit `temperature:null` wins, omitted stored `seed:0` is inserted, SSE completes, and quota `max_tokens` remains authoritative.

Add `model defaults participate in the post-merge 1 MiB request-size limit`. Calculate ASCII padding so the payload without `seed` serializes to `1024 * 1024 - 1` bytes, configure `default_seed = 0`, expect HTTP 413 `request_too_large`, zero upstream calls, and zero remaining quota reservations.

- [ ] **Step 3: Run the new tests to verify RED**

```powershell
node --test --test-name-pattern="public model listing exposes context metadata" test/gateway.test.js
node --test --test-name-pattern="model generation precedence|streaming applies the same|post-merge 1 MiB" test/filter-runtime.test.js
```

Expected: public rows lack context, omitted fields lack defaults, streaming lacks seed, and the near-limit request reaches the provider instead of failing after insertion.

- [ ] **Step 4: Add the two deliberately separate model queries**

In `getActiveModelsWithProviders`, select `m.context_window` and no default columns. In the `/v1/models` mapper return:

```js
context_window: model.context_window
```

In `validateModelAccess`, select the five `m.default_*` columns and do not select `context_window`. This keeps public metadata and private runtime configuration separate.

- [ ] **Step 5: Merge the exact allowlist after filtering and before size enforcement**

Define the mapping near the route constants:

```js
const MODEL_GENERATION_DEFAULTS = Object.freeze([
  ['temperature', 'default_temperature'],
  ['top_p', 'default_top_p'],
  ['presence_penalty', 'default_presence_penalty'],
  ['frequency_penalty', 'default_frequency_penalty'],
  ['seed', 'default_seed']
]);
```

After existing content/PII filtering, create the upstream payload without mutating `req.body` or `filteredBody`:

```js
const payload = { ...filteredBody };
for (const [requestField, modelField] of MODEL_GENERATION_DEFAULTS) {
  if (!Object.hasOwn(filteredBody, requestField) && req.gatewayModel[modelField] !== null) {
    payload[requestField] = req.gatewayModel[modelField];
  }
}
```

Keep streaming detection based on `req.body.stream === true`. Keep quota reservation based on `req.body.max_tokens` and `req.gatewayModel.max_tokens`. Replace the existing payload declaration with:

```js
reservation = reserveQuota(req.user, req.body.max_tokens,
  req.gatewayModel.max_tokens, requestLifetimeMs);
payload.max_tokens = reservation.maxTokens;
contentFilters.assertRequestSize(payload);
```

- [ ] **Step 6: Verify focused and compatibility regressions GREEN**

```powershell
node --test --test-name-pattern="public model listing exposes context metadata" test/gateway.test.js
node --test --test-name-pattern="model generation precedence|streaming applies the same|post-merge 1 MiB|passthrough|max_tokens|expanded masked payloads" test/filter-runtime.test.js
node --test --test-name-pattern="zero output quota preserves|streaming SSE and tool-call fields|prompts responses" test/gateway.test.js
node --test test/usage.test.js
```

Expected: all selected tests pass; context is metadata only; passthrough and cleanup remain unchanged.

- [ ] **Step 7: Check and commit the runtime slice**

```powershell
git diff --check
git add -- services/provider-router.js routes/v1.js test/gateway.test.js test/filter-runtime.test.js
git commit -m "feat: apply per-model generation defaults"
```

### Task 4: Add native dialog markup, styles, and a faithful dashboard test harness

**Files:**
- Modify: `test/admin-dashboard.test.js:9-204`
- Modify: `public/admin-dashboard.html:22-84`
- Modify: `public/admin-dashboard.css`
- Modify: `public/admin-dashboard.js:1-22,46-47`

**Interfaces:**
- Consumes: existing tab tables, safe `node()` helper, global status region, and fake DOM harness.
- Produces: `#user-dialog`, `#model-dialog`, `#provider-dialog`, `#confirm-dialog`; modal lifecycle helpers; create buttons; fake dialog/focus/form behavior used by Tasks 5-7.

- [ ] **Step 1: Extend the fake DOM with real dialog and form semantics**

Add stateful attributes/classList, focus, disabled controls, option selection, and this dialog class:

```js
class FakeDialog extends FakeNode {
  constructor() {
    super();
    this.open = false;
    this.showModalCount = 0;
  }

  showModal() {
    if (this.open) throw new Error('Dialog is already open');
    this.open = true;
    this.showModalCount += 1;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  }

  cancel() {
    const event = new Event('cancel', { cancelable: true });
    this.dispatchEvent(event);
    if (!event.defaultPrevented) this.close();
  }
}
```

Make `FakeFormData` read `form.elements[name]` before its legacy `values` fallback, omit disabled controls, return `on` only for checked checkboxes, and support selected options. Register all dialog, form, button, status, and control IDs before evaluating `admin-dashboard.js`. Capture `navigator.clipboard.writeText` arguments. Make `window.prompt` throw because no remaining in-scope flow may call it; make `window.confirm` increment a counter and return false so the unrelated filter-delete test seam remains available, and assert the counter does not change during user/model/provider tests.

- [ ] **Step 2: Add failing static and lifecycle tests**

Add these exact tests:

| Test name | Required assertions |
|---|---|
| `dashboard exposes labelled native resource and confirmation dialogs` | Read HTML; require exactly the four dialog IDs, each resource title/description reference, four local live status regions, and three create-button IDs; require that no resource create form remains inside its tab section. |
| `create dialogs reset forms focus the first control and restore focus on cancel or Escape` | Click each create button; require one `showModal`, reset mode values, and focus on username/modelName/preset; close user through Cancel and model through `FakeDialog.cancel()`, then require the matching trigger `focusCount` increments. |
| `backdrop clicks do not discard resource forms` | Open provider create, set a field, dispatch a dialog click whose target is the dialog, and assert `open === true` and the field value is unchanged. |

Static assertions require four `<dialog>` elements with `aria-labelledby`, resource descriptions, local `role="status" aria-live="polite"` regions, and three create buttons. Assert old `Create user/model/provider` inline cards are gone.

- [ ] **Step 3: Run lifecycle tests to verify RED**

```powershell
node --test --test-name-pattern="native resource|create dialogs|backdrop" test/admin-dashboard.test.js
```

Expected: missing dialog markup/IDs and missing `showModal` lifecycle.

- [ ] **Step 4: Move resource forms into four native dialogs**

Keep each existing table card and add `.section-heading` with `#create-user`, `#create-model`, or `#create-provider`. Add:

- `#user-dialog`: `#user-dialog-title`, `#user-dialog-description`, `#user-form`, hidden `userId`, controls `username`, `inputQuota`, `outputQuota`, `allowedModels`, `#user-dialog-status`, hidden `#user-token-result`, `#user-token-value`, copy/close buttons.
- `#model-dialog`: `#model-dialog-title`, `#model-dialog-description`, `#model-form`, hidden `modelId`, current controls plus `contextWindow`, and collapsed `#model-advanced` controls `defaultTemperature`, `defaultTopP`, `defaultPresencePenalty`, `defaultFrequencyPenalty`, `defaultSeed`.
- `#provider-dialog`: `#provider-dialog-title`, `#provider-dialog-description`, `#provider-form`, hidden `providerId`, wrappers `#provider-preset-field` and `#provider-env-field`, password `storedKey`, checkbox `removeStoredKey`.
- `#confirm-dialog`: `#confirm-title`, `#confirm-message`, `#confirm-form`, `#confirm-dialog-status`, `#confirm-submit`, and `#confirm-cancel`.

Use numeric HTML constraints matching the API. Associate context help stating that it does not reconfigure the provider, and default help stating that client-owned fields win.

- [ ] **Step 5: Add only the required modal styles and lifecycle helpers**

Append compact CSS for `dialog`, `dialog::backdrop`, `.section-heading`, `.dialog-actions`, max width/height, and overflow; reuse `.grid`, `.actions`, `.status`, `.help`, `.hidden`.

In JS add logical trigger tracking and helpers with safe text only. A row is replaced by `loadAll()`, so store its stable action key as well as its current node:

```js
const actionButtons = new Map();
let activeDialogTrigger = null; // { key, node, fallback }

function actionButton(key, text, handler, className) {
  const item = button(text, handler, className);
  actionButtons.set(key, item);
  return item;
}

function triggerReference(node, key = null, fallback = null) {
  return { key, node, fallback };
}

function focusTrigger(reference) {
  const target = reference && reference.key && actionButtons.get(reference.key) ||
    reference && reference.fallback || reference && reference.node;
  if (target) target.focus();
}

function showDialogStatus(id, message, kind = 'error') {
  const box = el(id);
  box.textContent = message;
  box.className = `status ${kind}`;
}

function clearDialogStatus(id) {
  const box = el(id);
  box.textContent = '';
  box.className = 'status hidden';
}

function openDialog(dialog, triggerReferenceValue, firstControl) {
  activeDialogTrigger = triggerReferenceValue;
  dialog.showModal();
  firstControl.focus();
}
```

Clear `actionButtons` immediately before `renderUsers()`, `renderModels()`, and `renderProviders()` repopulate it. Add `closeDialog(dialog, restoreFocus = true)` so successful mutations can close without focusing a soon-to-be-replaced row. Add `refreshAfterMutation(reference, fallback, message)` that calls `loadAll()` once, reports a refresh error without repeating the mutation, and then focuses the newly rendered `actionButtons.get(reference.key)`, explicit fallback, or old node in that order. Do not add backdrop-close behavior. On cancel/native close, clear sensitive/transient values and focus the recorded trigger.

- [ ] **Step 6: Verify lifecycle GREEN and commit the foundation**

```powershell
node --test --test-name-pattern="native resource|create dialogs|backdrop" test/admin-dashboard.test.js
git diff --check
git add -- public/admin-dashboard.html public/admin-dashboard.css public/admin-dashboard.js test/admin-dashboard.test.js
git commit -m "feat: add admin resource dialogs"
```

### Task 5: Implement user create/edit, one-time token, confirmation, and activation flows

**Files:**
- Modify: `test/admin-dashboard.test.js`
- Modify: `public/admin-dashboard.js:23-26,51`

**Interfaces:**
- Consumes: Task 4 user/confirmation dialogs and existing user API endpoints.
- Produces: modal user create/edit; one-time token display/copy/clear; confirmed soft deactivation and token rotation; direct reactivation.

- [ ] **Step 1: Add failing user workflow tests**

Add six tests with these exact names and assertions:

| Test name | Required assertions |
|---|---|
| `user create submits once and shows a one-time token until explicitly closed` | Deferred POST receives one exact body after two submits; submit is disabled; resolved raw token appears only in token `textContent`; copy writes the exact token; neither session storage nor status contains it; explicit close empties token text and restores create focus. |
| `user edit populates supported fields without enabling username rename` | Edit opens the same dialog, identifies but disables username, populates zero quotas and models, sends PUT without username, closes, reloads configuration but not statistics, and focuses the newly rendered logical Edit button. |
| `user mutation errors stay local and preserve input` | A 400 containing `<script>` leaves the dialog open, values unchanged, submit reenabled, and local status with that literal text and no child markup. |
| `user deactivation is confirmed by name and uses DELETE while activation is direct PUT` | Active row opens a confirmation whose text names the user, then DELETEs the correct ID; inactive row sends PUT `{is_active:true}` without opening confirmation. |
| `failed deactivation keeps confirmation open with its server error` | A 400 leaves the confirmation open, re-enables its submit, shows local server text, and sends no automatic retry. |
| `token rotation requires confirmation and reuses the one-time token result` | Confirm POSTs the rotation endpoint once, refreshes, opens the user dialog token result with the returned token, and closing clears it and focuses the newly rendered Rotate token button. |

Use deferred mutation responses and dispatch submit twice; assert one request and a disabled submit button. Create body must be exactly:

```js
{
  username: 'alice',
  max_daily_input_tokens: 0,
  max_daily_output_tokens: 0,
  allowed_models: ['model-a', 'model-b']
}
```

Assert error text such as `<script>invalid</script>` is held only in `textContent`, dialog stays open, and inputs remain unchanged. Replace the old quota-prompt test with edit-field assertions and prove no prompt was called.

- [ ] **Step 2: Run user tests to verify RED**

```powershell
node --test --test-name-pattern="user create|user edit|user mutation|deactivation|token rotation|zero quota" test/admin-dashboard.test.js
```

Expected: prompt/confirm sentinels fire or the new modal state/payload assertions fail.

- [ ] **Step 3: Implement user mode and one-time token lifecycle**

Create `openUserCreate(trigger)` and `openUserEdit(user, trigger)`. Edit mode sets username read-only/disabled and submits only quotas/models. Use one submit handler with a hidden `userId` to choose POST or PUT.

Guard duplicate submission:

```js
if (el('user-submit').disabled) return;
el('user-submit').disabled = true;
```

On create success, keep the dialog open, hide the form, place only `result.apiToken` in `#user-token-value.textContent`, show the result, focus Copy, and refresh configuration without clearing the token if refresh fails. Copy through `navigator.clipboard.writeText`; explicit close clears the raw token from the DOM before closing.

- [ ] **Step 4: Implement the shared confirmation controller and user actions**

Add one in-memory confirmation object and safe message assignment:

```js
let pendingConfirmation = null;

function openConfirmation({ trigger, title, message, submitLabel, action, onSuccess, fallback }) {
  pendingConfirmation = { trigger, action, onSuccess, fallback };
  el('confirm-title').textContent = title;
  el('confirm-message').textContent = message;
  el('confirm-submit').textContent = submitLabel;
  openDialog(el('confirm-dialog'), trigger, el('confirm-submit'));
}
```

Use it for `Deactivate user` with DELETE and token rotation with POST. Reactivation remains direct PUT `{is_active:true}`. Rotation opens the same one-time-token result after the confirmation closes and the list refreshes. A server error stays in `#confirm-dialog-status` and preserves the pending action for a deliberate retry.

- [ ] **Step 5: Verify user flows GREEN and commit**

```powershell
node --test --test-name-pattern="user create|user edit|user mutation|deactivation|token rotation|zero quota" test/admin-dashboard.test.js
git diff --check
git add -- public/admin-dashboard.js test/admin-dashboard.test.js
git commit -m "feat: move user management into modals"
```

### Task 6: Implement model modal defaults, discovery, activation, and deletion

**Files:**
- Modify: `test/admin-dashboard.test.js`
- Modify: `public/admin-dashboard.html`
- Modify: `public/admin-dashboard.js:27-31,46,52`

**Interfaces:**
- Consumes: Task 2 model API fields and Task 4-5 dialog/confirmation helpers.
- Produces: typed create/edit model payloads, A-layout advanced defaults, context table metadata, discovery registration, confirmed deactivation/deletion.

- [ ] **Step 1: Add failing model markup, payload, discovery, and destructive-flow tests**

Add nine tests with these exact names and assertions:

| Test name | Required assertions |
|---|---|
| `model dialog exposes typed advanced defaults without arbitrary JSON` | Static HTML contains the context constraints/help and collapsed five-field details; no `model_config`, arbitrary JSON textarea, or provider runtime option appears. |
| `model table distinguishes Max output and Context` | Render configured/null fixtures; require exact headers, formatted context integer, and `Not configured` for null. |
| `model create serializes blank defaults as null and preserves numeric zero` | Open create, set the conversion values below, submit once, and deep-equal the complete POST body including all six fields. |
| `model edit populates all fields and explicit blanks clear defaults` | Edit fixture populates strings for six fields; clearing them sends six nulls while preserving identifier/provider/max/prices. |
| `model validation errors stay local and a refresh failure cannot repeat a successful update` | A capacity 400 preserves an open form; a later successful PUT closes before a forced GET failure, produces one PUT total, reports global refresh failure, and focuses the old logical fallback. |
| `discover models opens locked create mode and accepts only returned identifiers` | GET results render safe list items, lock provider, prefill first name/display, reject an unlisted typed name with zero POSTs, and submit a listed name with the locked provider ID. |
| `empty model discovery reports status without opening a dialog` | Empty GET result sets global success text and leaves `showModalCount` unchanged. |
| `model deactivation and hard deletion use named confirmation` | Deactivate confirms then PUTs false; activation PUTs true directly; Delete confirms then DELETEs and focuses create-model after refresh. |
| `model delete guards keep the confirmation open with the server error` | Assignment-guard 400 leaves confirmation open, shows literal local error, and does not alter table state. |

For create, assert this exact conversion pattern:

```js
{
  context_window: null,
  default_temperature: 0,
  default_top_p: null,
  default_presence_penalty: -2,
  default_frequency_penalty: 0,
  default_seed: 0
}
```

Discovery must render hostile-looking returned identifiers through LI/text nodes, preselect and lock the provider, reject an identifier outside the returned Set without POST, and accept a returned identifier with the locked provider ID even though the select is disabled.

- [ ] **Step 2: Run model dashboard tests to verify RED**

```powershell
node --test --test-name-pattern="model dialog|model table|model create|model edit|model validation|discover models|empty model discovery|model deactivation|model delete" test/admin-dashboard.test.js
```

Expected: old prompts/confirms fire; fields/table headers/discovery list are missing.

- [ ] **Step 3: Implement the typed model payload and table**

Use a single conversion helper that preserves zero:

```js
function nullableNumber(value) {
  return String(value) === '' ? null : Number(value);
}
```

`modelPayload(form)` returns only the current model fields plus the six approved fields. Never include `model_config` or arbitrary request JSON. Change the table header to `Max output`, add `Context`, format null as `Not configured`, and keep safe DOM nodes.

Open edit mode with every nullable value rendered as `''` or `String(value)`. On 400, leave the dialog open and inputs intact. On successful mutation, close before `loadAll()`; a refresh error reports globally and cannot make the mutation submit-able again.

- [ ] **Step 4: Reuse model create mode for discovery safely**

Hold only transient discovery state:

```js
let discovery = null; // { providerId: number, names: Set<string> } while model dialog is open
```

After GET success, set the provider ID, disable the provider select, prefill the first identifier/display name, render every returned name safely, and focus the identifier. Before POST, require `discovery.names.has(modelName)`. Clear discovery on dialog close. No results reports global success without opening.

- [ ] **Step 5: Add model confirmation actions**

Deactivate uses confirmed PUT `{is_active:false}`; activate uses direct PUT `{is_active:true}`. Hard delete uses confirmed DELETE. Keep assignment failures local in the confirmation dialog and never detach user permissions. After successful hard delete, focus `#create-model` because the row trigger no longer exists.

- [ ] **Step 6: Verify model flows GREEN and commit**

```powershell
node --test --test-name-pattern="model dialog|model table|model create|model edit|model validation|discover models|empty model discovery|model deactivation|model delete" test/admin-dashboard.test.js
node --test test/admin-models.test.js
git diff --check
git add -- public/admin-dashboard.html public/admin-dashboard.js test/admin-dashboard.test.js
git commit -m "feat: manage model defaults in modals"
```

### Task 7: Implement provider modal credentials and destructive actions

**Files:**
- Modify: `test/admin-dashboard.test.js`
- Modify: `public/admin-dashboard.js:30-33,47,53-54`

**Interfaces:**
- Consumes: Task 4-5 provider/confirmation dialogs and existing provider API semantics.
- Produces: provider create/edit modal; unchanged/replace/remove credential payloads; confirmed deactivation/deletion; direct activation.

- [ ] **Step 1: Add failing provider workflow tests**

Replace the old inline provider-submit tests with seven tests:

| Test name | Required assertions |
|---|---|
| `provider create presets populate the modal and successful submit reloads configuration only` | Create opens reset mode, preset change fills identifier/display/Base URL, deferred double submit sends one POST, closes, and reloads configuration without statistics. |
| `provider edit never prefills or exposes credentials` | Edit populates supported non-secret fields, hides/disables preset+environment controls, leaves password empty, and uses only `hasApiKey` for table status. |
| `provider edit distinguishes unchanged replacement and explicit credential removal` | Perform three PUTs and assert the exact credential ownership/value cases below plus no `api_key_env_name`. |
| `provider credential controls are mutually exclusive and clear on close` | Remove clears/disables password; uncheck reenables; typing replacement unchecks Remove; cancel clears password and checkbox. |
| `provider mutation errors stay local and preserve the replacement credential` | A literal 400 remains local/open, preserves replacement text, and reenables submit. |
| `provider deactivation and hard deletion use named confirmation` | Deactivate confirms then PUTs false; activation PUTs true directly; delete confirms then DELETEs and focuses create-provider. |
| `provider delete guards keep the confirmation open with the server error` | Attached-model 400 keeps the dialog open, renders the local error as text, and never detaches models. |

Assert the three edit payload cases:

```js
assert.equal(Object.hasOwn(unchangedBody, 'stored_api_key'), false);
assert.equal(replacementBody.stored_api_key, 'new-secret');
assert.equal(removalBody.stored_api_key, null);
```

Also assert edit bodies omit `api_key_env_name`, stored credentials are never prefilled, mutation submits only once while pending, and successful configuration reload does not fetch statistics.

- [ ] **Step 2: Run provider tests to verify RED**

```powershell
node --test --test-name-pattern="provider create|provider edit|credential|provider mutation|provider deactivation|provider delete" test/admin-dashboard.test.js
```

Expected: old prompt/confirm sentinels fire or credential/remove/modal assertions fail.

- [ ] **Step 3: Implement provider create/edit mode and credential payloads**

Create mode shows/enables preset and environment-variable controls. Edit mode hides/disables them, leaves `storedKey` empty, and uses only list metadata such as `hasApiKey` for display.

Build edit credentials explicitly:

```js
const replacement = String(form.get('storedKey'));
if (form.get('removeStoredKey') === 'on') body.stored_api_key = null;
else if (replacement) body.stored_api_key = replacement;
```

Checking Remove clears/disables the password; unchecking reenables it. Typing a replacement clears Remove. Cancel/close clears the password and checkbox. A failed request deliberately leaves the replacement visible inside the still-open dialog so the admin can correct unrelated fields; it is cleared only on close/success.

- [ ] **Step 4: Add provider confirmation actions**

Deactivate uses confirmed PUT `{is_active:false}`, activate uses direct PUT true, hard delete uses confirmed DELETE. Attached-model errors stay local; never detach models. Successful hard delete restores focus to `#create-provider`.

- [ ] **Step 5: Verify provider flows and scoped browser-dialog removal GREEN**

Add a static JS assertion that user/model/provider functions contain no `window.prompt` or `window.confirm`; allow the unrelated filter delete confirmation to remain.

Run:

```powershell
node --test --test-name-pattern="provider create|provider edit|credential|provider mutation|provider deactivation|provider delete|browser prompts" test/admin-dashboard.test.js
node --test test/admin-dashboard.test.js
```

Expected: the complete dashboard harness passes and dynamic values remain text-only.

- [ ] **Step 6: Check and commit the provider slice**

```powershell
git diff --check
git add -- public/admin-dashboard.js test/admin-dashboard.test.js
git commit -m "feat: move provider management into modals"
```

### Task 8: Document the contracts and run complete verification

**Files:**
- Modify: `README.md`
- Modify: `docs/API.md`
- Modify: `docs/COMPATIBILITY.md`
- Modify if an expectation is exposed by full regression only: tests already touched by Tasks 1-7; do not refactor unrelated code.

**Interfaces:**
- Consumes: all implemented API, runtime, migration, and dashboard behavior.
- Produces: operator/client documentation and complete verification evidence.

- [ ] **Step 1: Update user-facing and API documentation**

Document the exact admin model fields, ranges, null-clearing semantics, and `max_tokens <= context_window` relationship in `docs/API.md`. State this precedence:

```text
gateway-enforced routing/security/quota
> explicit client field, including 0 or null
> non-null per-model default
> provider default
```

Update the 413 entry to say the 1 MiB check occurs after input filtering, model-default insertion, and quota-controlled `max_tokens` insertion.

In `docs/COMPATIBILITY.md`, document that `/v1/models` returns `context_window`, the five defaults are admin-only, and unknown client fields still pass through. In README, clarify:

- Chat Completions is stateless; OpenWebUI or another client must resend prior `messages` after reconnecting.
- `Maximum output tokens` is not the context window.
- `context_window` records the provider's effective model setting but does not change it.
- Provider-specific runtime settings remain operator-managed.

- [ ] **Step 2: Run all focused suites**

```powershell
node --test test/migrations.test.js
node --test test/backup.test.js
node --test test/admin-models.test.js
node --test test/admin-dashboard.test.js
node --test test/filter-runtime.test.js
node --test test/gateway.test.js
node --test test/usage.test.js
```

Expected: every command exits 0 with no skipped required behavior.

- [ ] **Step 3: Run repository-wide tests and operational schema checks**

```powershell
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Full test suite failed' }
$verificationRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("llmward-model-defaults-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $verificationRoot | Out-Null

$previousDatabasePath = $env:DATABASE_PATH
$previousAdminKey = $env:ADMIN_SECRET_KEY
$previousCorsOrigin = $env:CORS_ORIGIN
$previousLogLevel = $env:LOG_LEVEL
try {
  $env:DATABASE_PATH = Join-Path $verificationRoot 'gateway.db'
  $env:ADMIN_SECRET_KEY = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
  $env:CORS_ORIGIN = 'http://localhost:3000'
  $env:LOG_LEVEL = 'silent'
  npm.cmd run doctor
  if ($LASTEXITCODE -ne 0) { throw 'Doctor failed' }
  npm.cmd run backup
  if ($LASTEXITCODE -ne 0) { throw 'Backup verification failed' }
} finally {
  if ($null -eq $previousDatabasePath) { Remove-Item Env:DATABASE_PATH -ErrorAction SilentlyContinue } else { $env:DATABASE_PATH = $previousDatabasePath }
  if ($null -eq $previousAdminKey) { Remove-Item Env:ADMIN_SECRET_KEY -ErrorAction SilentlyContinue } else { $env:ADMIN_SECRET_KEY = $previousAdminKey }
  if ($null -eq $previousCorsOrigin) { Remove-Item Env:CORS_ORIGIN -ErrorAction SilentlyContinue } else { $env:CORS_ORIGIN = $previousCorsOrigin }
  if ($null -eq $previousLogLevel) { Remove-Item Env:LOG_LEVEL -ErrorAction SilentlyContinue } else { $env:LOG_LEVEL = $previousLogLevel }
  $resolvedVerificationRoot = [System.IO.Path]::GetFullPath($verificationRoot)
  $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (-not $resolvedVerificationRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to remove a verification directory outside the system temporary directory'
  }
  Remove-Item -LiteralPath $resolvedVerificationRoot -Recurse -Force
}
```

Expected: full tests pass; doctor reports schema 4/current integrity; backup verification succeeds inside the validated temporary directory without exposing secrets. `data/gateway.db` is never opened or modified.

- [ ] **Step 4: Run startup and static security checks**

Run `node --test test/server.test.js`; its child server uses a temporary database, reaches `/health`, and shuts down cleanly. Then run:

```powershell
node --test test/server.test.js
rg -n "window\.prompt|window\.confirm|innerHTML|context_window|default_temperature|default_top_p|default_presence_penalty|default_frequency_penalty|default_seed" public routes services docs test
npm.cmd audit --omit=dev
git diff --check
```

Expected: no resource CRUD browser prompts/confirms, no new unsafe DOM sink, all six names appear only in intended schema/admin/runtime/docs/tests, production audit has no blocking vulnerability, and no whitespace errors exist.

- [ ] **Step 5: Review scope and commit documentation/final adjustments**

```powershell
git status --short
git diff -- README.md docs/API.md docs/COMPATIBILITY.md
git add -- README.md docs/API.md docs/COMPATIBILITY.md
git commit -m "docs: explain model defaults and context metadata"
git status --short
```

Expected: the worktree is clean and commits contain only the approved feature.
