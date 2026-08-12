# Admin Refresh and Filter Policy Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make admin mutations render immediately and return the matching filter policy name on input-block responses without exposing content or persisting attribution.

**Architecture:** Keep the existing vanilla dashboard and filter matcher. Stabilize browser form references, separate configuration refreshes from Usage statistics, and carry ordered block-policy metadata only in the per-request in-memory snapshot. Add `filter_name` through a narrow error-serializer allowlist.

**Tech Stack:** CommonJS, Node.js standard library test runner, Express, SQLite, vanilla HTML/CSS/JavaScript

## Global Constraints

- Add no dependency, schema migration, polling, generalized error-details framework, or client state framework.
- Never return or log patterns, matching content, prompts, responses, provider bodies, tokens, or credentials.
- Return a policy name only for `content_filtered`; do not persist it in request or application logs.
- Preserve authentication, authorization, transaction, cleanup, safe-DOM, CSP, and accessibility behavior.
- Do not modify the user's existing `Dockerfile` or `test/operations.test.js` changes.

---

### Task 1: Make dashboard mutation refresh independent and stable

**Files:**
- Create: `test/admin-dashboard.test.js`
- Modify: `public/admin-dashboard.js`

**Interfaces:**
- Consumes: the existing `api(path, options)`, render functions, and form submit events
- Produces: `loadAll()` for configuration data and `loadStats()` for Usage data; stable `formElement` references in model/provider submit handlers

- [ ] **Step 1: Write a failing provider-submit behavior test**

Execute the real dashboard script in `node:vm` with small DOM and `fetch` fakes built from the standard library. Dispatch a real `submit` event through `EventTarget`, resolve the create request asynchronously, and assert that the submitted provider form is reset and configuration GET requests begin. This catches the browser behavior where `event.currentTarget` becomes `null` after dispatch.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --test --test-name-pattern="provider submit" test/admin-dashboard.test.js
```

Expected: FAIL because the handler reads `event.currentTarget` after the create request resolves, so reset and configuration reload never happen.

- [ ] **Step 3: Implement the minimal dashboard fix**

In each affected handler, use this shape:

```js
const formElement = event.currentTarget;
const form = new FormData(formElement);
await api(/* existing request */);
formElement.reset();
await loadAll();
showStatus(T.created, 'success');
```


- [ ] **Step 4: Verify the provider-submit test is GREEN**

Run the focused command from Step 2 and require zero failures.

- [ ] **Step 5: Write and verify a failing statistics-isolation behavior test**

Using the same real-script harness, submit a provider successfully and assert that the mutation-triggered refresh never requests `/admin/stats`, while still requesting `/admin/providers` and the other configuration resources. Run the focused test before changing `loadAll()` and confirm it fails because the current all-in-one reload requests statistics.

- [ ] **Step 6: Separate statistics and verify GREEN**

Remove statistics from the configuration `Promise.all()`. Add:

```js
async function loadStats() {
  renderStats(await api(statsPath()));
}
```

Call `loadStats()` during initial authenticated loading and from the existing Usage submit handler. Configuration mutations continue to call only `loadAll()`. Run all of `test/admin-dashboard.test.js` and require zero failures. The fakes are boundary substitutes only: assertions target real handler effects and requested routes, not fake call counts detached from behavior.

---

### Task 2: Return the matching input-block policy name safely

**Files:**
- Modify: `test/content-filters.test.js`
- Modify: `test/filter-runtime.test.js`
- Modify: `services/content-filters.js`
- Modify: `app.js`

**Interfaces:**
- Consumes: active filters ordered by ID and the existing `content_filtered` `ApiError`
- Produces: immutable `input_block_policies: Array<{name: string, patterns: string[]}>`, internal `error.filterName`, and public `filter_name`

- [ ] **Step 1: Write failing unit and integration tests**

Change the effective-snapshot test to require ordered, frozen block-policy metadata while retaining the three flattened pattern arrays. Add a unit assertion that two matching block policies return the first policy name without including either literal pattern or matched content in the error object. Extend the runtime block test to use a fixed non-sensitive policy name and require:

```js
assert.equal(response.body.filter_name, 'Runtime input policy');
assert.equal(JSON.stringify(response.body).includes('blocked secret'), false);
```

Also verify serialized request/application logs do not contain `Runtime input policy`.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --test --test-name-pattern="effective snapshot|input filtering blocks|input blocking examines" test/content-filters.test.js test/filter-runtime.test.js
```

Expected: FAIL because snapshot metadata and `filter_name` do not exist.

- [ ] **Step 3: Add ordered in-memory policy metadata**

While building the effective snapshot, append a frozen object for every active block filter:

```js
inputBlockPolicies.push(Object.freeze({
  name: filter.name,
  patterns: Object.freeze([...filter.patterns])
}));
```

Return the frozen list as `input_block_policies` without changing mask arrays.

- [ ] **Step 4: Attribute a blocked request**

Keep the combined matcher as the fast path. Retain only the blocked text in a local variable, then scan `input_block_policies` in order with the existing literal matcher until one matches. Throw the existing fixed `content_filtered` error and set `error.filterName` to that validated policy name. Do not attach patterns or content.

- [ ] **Step 5: Allowlist the public field**

Build the existing `{ error, code }` response object first. Add `filter_name` only when `error.code === 'content_filtered'` and `error.filterName` is a non-empty string. Do not serialize arbitrary error properties.

- [ ] **Step 6: Verify GREEN**

Run the focused command from Step 2 and require zero failures.

---

### Task 3: Explain block behavior and the public policy name

**Files:**
- Modify: `test/admin-filters.test.js`
- Modify: `public/admin-dashboard.html`
- Modify: `docs/API.md`
- Modify: `docs/COMPATIBILITY.md`
- Modify: `docs/THREAT_MODEL.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the new `filter_name` response contract
- Produces: accessible dashboard guidance and matching public documentation

- [ ] **Step 1: Write the failing UI contract test**

Require the filter page to state that the Name is returned to API clients, show a fictional block example containing `filter_name`, warn that a non-global rule without models is inactive in effect, and avoid any real domain, secret, prompt, or response content.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --test --test-name-pattern="dashboard exposes" test/admin-filters.test.js
```

Expected: FAIL because the current guide explains masking only and does not describe policy attribution.

- [ ] **Step 3: Update the UI and documentation**

Add `aria-describedby` help to the Name input. Replace or supplement the masking example with a fictional input-block example using `.test` data and a non-sensitive name. Document the deterministic first-policy rule, the new response field, and the fact that names are disclosed only in responses and not persisted in logs. Update the changelog without changing version metadata.

- [ ] **Step 4: Verify focused tests**

Run:

```powershell
node --test test/admin-dashboard.test.js test/admin-filters.test.js test/content-filters.test.js test/filter-runtime.test.js
```

Expected: all focused tests pass.

---

### Task 4: Full verification

**Files:**
- Verify only; no planned production changes

**Interfaces:**
- Consumes: Tasks 1-3
- Produces: fresh evidence for the final handoff

- [ ] **Step 1: Run syntax and whitespace checks**

```powershell
node --check public/admin-dashboard.js
git diff --check
```

- [ ] **Step 2: Run the complete regression suite**

```powershell
npm.cmd test
```

- [ ] **Step 3: Run relevant operational checks**

```powershell
npm.cmd run doctor
npm.cmd audit --omit=dev
```

The doctor may report expected configuration warnings, but must exit successfully without exposing secrets. The production audit must report no known vulnerabilities.

- [ ] **Step 4: Review scope and privacy**

Inspect the final diff and confirm no changes to `Dockerfile` or `test/operations.test.js`, no new dependency/schema change, no prompt/pattern logging, and no generic error-property serialization.
