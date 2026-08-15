# Signal Grid Admin Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implemented and verified on 2026-08-15 through commit `99a8ce4`. The checklist below is retained as the execution specification; focused dashboard and full repository tests, diff validation, and live Edge layout, focus, session-isolation, and secret-scrubbing checks passed.

**Goal:** Turn the existing administrator dashboard into the approved dark Signal Grid Gateway console, with a read-only Overview, memory-only administrator authentication, resilient shared seven-day statistics, responsive labelled navigation, and stronger table/status accessibility.

**Architecture:** Keep the current static HTML, one CSS file, and one vanilla-JavaScript controller. Extend the existing client state with one fixed seven-day statistics snapshot and one guarded in-flight promise; derive Overview counts only from existing list responses; keep every mutation and backend API unchanged. Drive the regression suite through the real login, navigation, and form events in the existing fake DOM.

**Tech Stack:** Node.js 22, CommonJS, node:test, static HTML, CSS, vanilla browser JavaScript, and the current Express admin APIs. Add no dependency, build step, framework, font, icon package, or remote asset.

## Global Constraints

- Execute in an isolated worktree using superpowers:using-git-worktrees. Implementation used that isolation and excluded unrelated primary-worktree changes from every feature commit.
- Production scope is only public/admin-dashboard.html, public/admin-dashboard.css, and public/admin-dashboard.js. Regression scope is only test/admin-dashboard.test.js.
- Preserve every existing API route, payload, response shape, dialog, confirmation, pending-operation guard, one-time token clearing rule, provider credential rule, filter warning, and safe DOM-construction rule.
- Never render, persist, or log prompts, message arrays, generated content, or provider error bodies.
- In the administrator UI, administrator keys, provider credentials, plaintext filter patterns, and raw user tokens may be displayed only in their existing purpose-limited password/edit controls or one-time token result. Do not copy them into metrics, activity, DOM data attributes, logs, URLs, cookies, or browser storage; never prefill stored provider credentials; clear one-time tokens and sensitive form values when their dialog closes or the session ends.
- Continue to build administrator-controlled content with textContent, createTextNode, and node(). Do not introduce innerHTML.
- Keep 401 and 403 fail-closed: clear the in-memory key and password input, hide the dashboard, and show login. Only non-authentication statistics failures are recoverable local panel failures.
- Keep mutation refreshes on loadAll() only. Do not add statistics refreshes to mutation paths.
- For every behavior task: write a failing test, run node --test test/admin-dashboard.test.js and confirm the intended failure, make the smallest implementation, then rerun it.
- Use npm.cmd on Windows. Do not run setup or visual checks against data/gateway.db.

## File Map

| File | Responsibility |
|---|---|
| public/admin-dashboard.html | Login, authenticated shell, six-section navigation, Overview markup, existing resources and dialogs |
| public/admin-dashboard.css | Signal Grid tokens, shell, components, focus, responsive behavior, reduced motion |
| public/admin-dashboard.js | Memory key, section selection, Overview derivations, shared statistics state, existing CRUD rendering |
| test/admin-dashboard.test.js | Fake browser harness, static semantics, auth/navigation/Overview/statistics regressions, preserved CRUD regressions |

---

## Task 1: Make administrator authentication memory-only

**Files:**

- Modify: test/admin-dashboard.test.js:9-379
- Modify: test/admin-dashboard.test.js:819-865 and the 29 storedKey fixtures below it
- Modify: public/admin-dashboard.js:3,22-24,102-103,119

- [ ] Add removeAttribute() to FakeNode:

~~~js
removeAttribute(name) {
  this.attributes.delete(name);
}
~~~

- [ ] Replace the harness option storedKey with loginKey and add initialSessionValues plus storageCalls. A loginKey is test setup: its first GET /admin/users verifies login, returns response([]), and is not recorded in requests or passed to fetchOverride. All requests made by loadInitial() remain visible to existing assertions.

Use this exact bootstrap logic around the existing fetch implementation:

~~~js
function createDashboardHarness({
  loginKey = '',
  initialSessionValues = [],
  fetchOverride,
  confirmResult = false,
  clipboardWrite,
} = {}) {
  const sessionValues = new Map(initialSessionValues);
  const storageCalls = [];
  let bootstrapLoginPending = Boolean(loginKey);

  const context = {
    Array,
    Date,
    Event,
    EventTarget,
    FormData: FakeFormData,
    Intl,
    Map,
    Node: FakeNode,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    document,
    navigator: { clipboard: { writeText: clipboardWrite || (async (value) => clipboardWrites.push(value)) } },
    fetch: async (route, options = {}) => {
      if (bootstrapLoginPending && route === '/admin/users' && !options.method) {
        bootstrapLoginPending = false;
        return response([]);
      }
      requests.push({ route, options });
      const overridden = fetchOverride && fetchOverride(route, options);
      if (overridden !== undefined) return overridden;
      if (route === '/admin/providers' && options.method === 'POST') return response({});
      if (route === '/admin/users') return response([]);
      if (route === '/admin/filters/built-in-pii' && options.method === 'PUT') {
        builtInPiiActive = JSON.parse(options.body).is_active;
      }
      if (route === '/admin/filters/built-in-pii') {
        return response({
          id: 'built-in-pii',
          name: 'Built-in Korean PII & Secret Filter',
          is_active: builtInPiiActive,
          is_global: true,
          rules: builtInPiiRules,
        });
      }
      if (route === '/admin/models') return response([]);
      if (route === '/admin/providers') return response([]);
      if (route === '/admin/filters') return response([]);
      if (route === '/admin/onboarding') return response({ complete: true, steps: [], example: '' });
      if (route === '/admin/provider-presets') return response([]);
      if (route.startsWith('/admin/stats?')) return response(dashboardStats());
      throw new Error('Unexpected route: ' + route);
    },
    sessionStorage: {
      getItem(key) {
        storageCalls.push({ method: 'getItem', key });
        return sessionValues.get(key) || null;
      },
      setItem(key, value) {
        storageCalls.push({ method: 'setItem', key });
        sessionValues.set(key, String(value));
      },
      removeItem(key) {
        storageCalls.push({ method: 'removeItem', key });
        sessionValues.delete(key);
      },
    },
    window: new FakeNode(),
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.js'), 'utf8'),
    context,
  );
  if (loginKey) {
    document.getElementById('admin-key').value = loginKey;
    loginForm.dispatchEvent(new Event('submit', { cancelable: true }));
  }
}
~~~

Keep all current harness return properties, then add login, dashboard, signOut, storageCalls, and sessionValues. Change statsForm.values.range from 24h to 7d. Mechanically change the 29 resource fixtures from storedKey to loginKey; do not weaken their request-count assertions.

- [ ] Add a complete zero-valued fixture:

~~~js
function dashboardStats(overrides = {}) {
  const summary = {
    total_requests: 0,
    successful_requests: 0,
    failed_requests: 0,
    error_rate: 0,
    total_input: 0,
    total_output: 0,
    total_tokens: 0,
    average_response_time_ms: 0,
    p95_response_time_ms: 0,
    estimated_cost_usd: 0,
    cost_configured: false,
    ...(overrides.summary || {}),
  };
  const period = {
    start: '2026-08-08T00:00:00.000Z',
    end: '2026-08-15T00:00:00.000Z',
    ...(overrides.period || {}),
  };
  return {
    generated_at: '2026-08-15T01:00:00.000Z',
    by_user: [],
    by_model: [],
    by_provider: [],
    recent_requests: [],
    ...overrides,
    summary,
    period,
  };
}
~~~

- [ ] Replace the stored-key restoration test with these security regressions:

~~~js
test('administrator key stays memory-only and reload starts signed out', async () => {
  const first = createDashboardHarness();
  first.adminKey.value = 'memory-only-admin-key';
  first.loginForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();

  assert.equal(first.adminKey.value, '');
  assert.equal(first.login.classList.contains('hidden'), true);
  assert.equal(first.dashboard.classList.contains('hidden'), false);
  assert.deepEqual(first.storageCalls, []);
  assert.equal(first.sessionValues.has('llmGatewayAdminKey'), false);

  const reloaded = createDashboardHarness({
    initialSessionValues: [['llmGatewayAdminKey', 'legacy-stored-key']],
  });
  await settle();
  assert.equal(reloaded.requests.length, 0);
  assert.equal(reloaded.login.classList.contains('hidden'), false);
  assert.equal(reloaded.dashboard.classList.contains('hidden'), true);
  assert.deepEqual(reloaded.storageCalls, []);
});

test('sign out clears the in-memory session and returns to login', async () => {
  const harness = createDashboardHarness({ loginKey: 'memory-only-admin-key' });
  await settle();
  harness.signOut.dispatchEvent(new Event('click'));
  assert.equal(harness.login.classList.contains('hidden'), false);
  assert.equal(harness.dashboard.classList.contains('hidden'), true);
  assert.equal(harness.adminKey.value, '');
  assert.deepEqual(harness.storageCalls, []);
});
~~~

- [ ] Run the focused suite and confirm the tests fail because production still reads/writes sessionStorage:

~~~powershell
node --test test/admin-dashboard.test.js
~~~

- [ ] Replace the production state and API error path:

~~~js
const state = {
  key: '',
  users: [],
  models: [],
  providers: [],
  filters: [],
  builtInPii: null,
  presets: [],
};

async function api(path, options = {}) {
  const headers = { 'X-Admin-Key': state.key, ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  let body = null;
  try {
    body = await response.json();
  } catch {}
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      state.key = '';
      showLogin();
      showStatus(T.authFailed, 'error');
    }
    const error = new Error(body && body.error ? body.error : T.requestFailed);
    error.status = response.status;
    throw error;
  }
  return body;
}
~~~

- [ ] Replace login, sign-out, and boot behavior:

~~~js
el('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.key = el('admin-key').value;
  el('admin-key').value = '';
  try {
    await api('/admin/users');
    showDashboard();
    showStatus(T.signedIn, 'success');
    await loadInitial();
  } catch (error) {
    if (state.key) showStatus(error.message, 'error');
  }
});

el('sign-out').addEventListener('click', () => {
  state.key = '';
  showLogin();
  showStatus(T.signedOut, 'success');
});

showLogin();
~~~

Remove every production sessionStorage reference.

- [ ] Run and commit:

~~~powershell
node --test test/admin-dashboard.test.js
git add public/admin-dashboard.js test/admin-dashboard.test.js
git commit -m "fix: keep admin key in memory only"
~~~

---

## Task 2: Add the labelled six-section Signal Grid shell

**Files:**

- Modify: public/admin-dashboard.html:9-80
- Modify: public/admin-dashboard.js:23-24,85
- Modify: test/admin-dashboard.test.js:174-474

- [ ] Add a static test asserting this exact nav order: Overview, Users, Models, Providers, Filters, Usage. For each internal name overview/users/models/providers/filters/stats, assert the button has id tab-button-NAME and aria-controls tab-NAME, and the section has aria-labelledby tab-button-NAME. Assert only Overview has aria-current="page", no nav item has aria-selected, and onboarding occurs inside tab-overview before overview-stats-content.

- [ ] Replace the global header and login panel with the authenticated-data-free Gateway identity below:

~~~html
<body>
  <main id="admin-app">
    <div id="status" class="status hidden" role="status" aria-live="polite"></div>
    <section id="login" class="card login-panel" aria-labelledby="login-title">
      <p class="eyebrow">GATEWAY CONTROL PLANE</p>
      <h1 id="login-title">LLMWard Gateway</h1>
      <p class="help">Administrator access is required to view Gateway configuration and usage.</p>
      <form id="login-form">
        <label for="admin-key">Admin key</label>
        <input id="admin-key" type="password" required autocomplete="current-password">
        <button type="submit">Sign in</button>
      </form>
    </section>
~~~

Remove the old top-level header. Before authentication, no dashboard count, provider state, usage value, or onboarding content may sit outside the hidden dashboard.

- [ ] Replace the existing dashboard nav with:

~~~html
<div id="dashboard" class="hidden">
  <div class="app-shell">
    <aside class="nav-rail" aria-label="LLMWard Gateway">
      <div class="rail-brand">
        <span class="brand-mark" aria-hidden="true">GW</span>
        <span><strong>LLMWard</strong><small>Gateway control</small></span>
      </div>
      <nav class="rail-nav" aria-label="Administration sections">
        <button id="tab-button-overview" type="button" data-tab="overview" aria-controls="tab-overview" aria-current="page">Overview</button>
        <button id="tab-button-users" type="button" data-tab="users" aria-controls="tab-users">Users</button>
        <button id="tab-button-models" type="button" data-tab="models" aria-controls="tab-models">Models</button>
        <button id="tab-button-providers" type="button" data-tab="providers" aria-controls="tab-providers">Providers</button>
        <button id="tab-button-filters" type="button" data-tab="filters" aria-controls="tab-filters">Filters</button>
        <button id="tab-button-stats" type="button" data-tab="stats" aria-controls="tab-stats">Usage</button>
      </nav>
      <button id="sign-out" type="button" class="secondary rail-sign-out">Sign out</button>
    </aside>
    <div class="workspace">
      <header class="workspace-header">
        <p class="eyebrow">GATEWAY OPERATIONS</p>
        <h1 id="section-title">Overview</h1>
      </header>
~~~

- [ ] Add Overview as the first page. Move the existing onboarding section into it before all metrics:

~~~html
<section id="tab-overview" class="page-section" aria-labelledby="tab-button-overview">
  <section id="onboarding" class="card onboarding hidden" aria-labelledby="onboarding-title">
    <h2 id="onboarding-title">First-time setup</h2>
    <div id="onboarding-content"></div>
  </section>
  <section class="card" aria-labelledby="gateway-path-title">
    <p class="eyebrow">GATEWAY PATH</p>
    <h2 id="gateway-path-title">Effective access path</h2>
    <div class="gateway-path" aria-label="Users, policies, models, and providers">
      <button id="overview-users" class="gateway-node" type="button" data-overview-target="users" aria-controls="tab-users">
        <span class="node-index">01</span><span class="node-label">Users</span><strong id="overview-users-count">0</strong><span class="node-detail">tokens and quotas</span>
      </button>
      <span class="gateway-arrow" aria-hidden="true">→</span><span class="visually-hidden">then</span>
      <button id="overview-policies" class="gateway-node" type="button" data-overview-target="filters" aria-controls="tab-filters">
        <span class="node-index">02</span><span class="node-label">Policies</span><strong id="overview-policies-count">0</strong><span class="node-detail">effective filters</span>
      </button>
      <span class="gateway-arrow" aria-hidden="true">→</span><span class="visually-hidden">then</span>
      <button id="overview-models" class="gateway-node" type="button" data-overview-target="models" aria-controls="tab-models">
        <span class="node-index">03</span><span class="node-label">Models</span><strong id="overview-models-count">0</strong><span class="node-detail">available routes</span>
      </button>
      <span class="gateway-arrow" aria-hidden="true">→</span><span class="visually-hidden">then</span>
      <button id="overview-providers" class="gateway-node" type="button" data-overview-target="providers" aria-controls="tab-providers">
        <span class="node-index">04</span><span class="node-label">Providers</span><strong id="overview-providers-count">0</strong><span class="node-detail">active registrations</span>
      </button>
    </div>
  </section>
  <div class="overview-grid">
    <section class="card" aria-labelledby="overview-summary-title">
      <h2 id="overview-summary-title">7-day operational summary</h2>
      <div id="overview-stats-content"></div>
    </section>
    <section class="card" aria-labelledby="overview-provider-title">
      <h2 id="overview-provider-title">Provider snapshot</h2>
      <div id="overview-providers-content"></div>
    </section>
    <section class="card overview-activity" aria-labelledby="overview-activity-title">
      <h2 id="overview-activity-title">Recent gateway activity</h2>
      <div id="overview-activity-content"></div>
    </section>
  </div>
</section>
~~~

Keep all existing resource content and dialogs. Give each resource section class="page-section hidden" and the matching aria-labelledby. Close workspace/app-shell/dashboard after tab-stats.

- [ ] Register the six nav buttons and sections in the fake DOM:

~~~js
const sectionNames = ['overview', 'users', 'models', 'providers', 'filters', 'stats'];
const navButtons = sectionNames.map((name) => {
  const item = register('tab-button-' + name);
  item.type = 'button';
  item.dataset.tab = name;
  item.setAttribute('aria-controls', 'tab-' + name);
  register('tab-' + name);
  return item;
});

document.querySelectorAll = (selector) => selector === 'nav [data-tab]' ? navButtons : [];
~~~

Return navButtons, sectionTitle, and a tabs object keyed by section name from the harness.

- [ ] Add a behavior test: after login, Overview is shown; clicking Filters leaves only Filters with aria-current="page", updates section-title to Filters, shows tab-filters, and hides tab-overview.

- [ ] Implement one section selector:

~~~js
const SECTION_LABELS = Object.freeze({
  overview: 'Overview',
  users: 'Users',
  models: 'Models',
  providers: 'Providers',
  filters: 'Filters',
  stats: 'Usage',
});

function selectSection(name) {
  document.querySelectorAll('nav [data-tab]').forEach((item) => {
    if (item.dataset.tab === name) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  Object.keys(SECTION_LABELS).forEach((sectionName) => {
    el('tab-' + sectionName).classList.toggle('hidden', sectionName !== name);
  });
  el('section-title').textContent = SECTION_LABELS[name];
}

function showDashboard() {
  el('login').classList.add('hidden');
  el('dashboard').classList.remove('hidden');
  selectSection('overview');
}

document.querySelectorAll('nav [data-tab]').forEach((item) => {
  item.addEventListener('click', () => selectSection(item.dataset.tab));
});
~~~

- [ ] Run and commit:

~~~powershell
node --test test/admin-dashboard.test.js
git add public/admin-dashboard.html public/admin-dashboard.js test/admin-dashboard.test.js
git commit -m "feat: add accessible Signal Grid shell"
~~~

---

## Task 3: Add accessible generated tables and explicit filter states

**Files:**

- Modify: public/admin-dashboard.js:54-55,61,64,67,71-72,81-82
- Modify: public/admin-dashboard.html:95-100,156-162
- Modify: test/admin-dashboard.test.js:1417-1435 and adjacent tests

- [ ] Add this traversal helper and extend the current model-table test:

~~~js
function findNodes(node, predicate) {
  const matches = predicate(node) ? [node] : [];
  for (const child of node.children) matches.push(...findNodes(child, predicate));
  return matches;
}
~~~

Assert exactly one .table-wrap with tabIndex 0, role="region", aria-label="Models"; one CAPTION containing Models; and every TH has scope="col".

- [ ] Add a filter regression with active global, active two-model scoped, inactive, and active unassigned fixtures. Assert the rendered text includes exactly Active globally, Active for 2 models, Inactive, and Active but no models assigned.

- [ ] Replace table() with:

~~~js
function table(caption, headers, rows) {
  if (!rows.length) return node('p', T.empty, 'empty');
  const wrap = node('div', undefined, 'table-wrap');
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', caption);
  const result = node('table');
  result.append(node('caption', caption, 'visually-hidden'));
  const head = node('thead');
  const headRow = node('tr');
  headers.forEach((header) => {
    const cell = node('th', header);
    cell.setAttribute('scope', 'col');
    headRow.append(cell);
  });
  head.append(headRow);
  result.append(head);
  const body = node('tbody');
  rows.forEach((cells) => {
    const row = node('tr');
    cells.forEach((cell) => {
      const tableCell = node('td');
      tableCell.append(cell instanceof Node ? cell : document.createTextNode(String(cell)));
      row.append(tableCell);
    });
    body.append(row);
  });
  result.append(body);
  wrap.append(result);
  return wrap;
}
~~~

Update all existing calls with these captions: Users, Models, Providers, Filters, label + " usage", and Recent requests.

- [ ] Replace statusBadge and add filterStatus:

~~~js
function statusBadge(active, label = active ? 'Active' : 'Inactive') {
  return node('span', label, 'badge' + (active ? ' active' : ''));
}

function filterStatus(filter) {
  if (!filter.is_active) return 'Inactive';
  if (filter.is_global) return 'Active globally';
  const assigned = Array.isArray(filter.model_ids) ? filter.model_ids.length : 0;
  return assigned ? 'Active for ' + assigned + ' models' : 'Active but no models assigned';
}
~~~

Render the Filters Status cell with statusBadge(filter.is_active, filterStatus(filter)). Keep the current Scope cell separately.

- [ ] Add class="warning-panel hidden" to user-token-result and class="danger" to confirm-submit. Preserve every warning word-for-word.

- [ ] Run and commit:

~~~powershell
node --test test/admin-dashboard.test.js
git add public/admin-dashboard.html public/admin-dashboard.js test/admin-dashboard.test.js
git commit -m "feat: improve admin status and table accessibility"
~~~

---

## Task 4: Derive and navigate the effective Gateway path

**Files:**

- Modify: public/admin-dashboard.js:57-74,85
- Modify: test/admin-dashboard.test.js:174-440 and new Overview tests

- [ ] Register and return all overview-*-count nodes, overview-stats-content, overview-providers-content, overview-activity-content, the six Usage content nodes, and four native Overview buttons. Extend querySelectorAll:

~~~js
const overviewNodes = [
  ['overview-users', 'users'],
  ['overview-policies', 'filters'],
  ['overview-models', 'models'],
  ['overview-providers', 'providers'],
].map(([id, target]) => {
  const item = register(id);
  item.type = 'button';
  item.dataset.overviewTarget = target;
  item.setAttribute('aria-controls', 'tab-' + target);
  return item;
});

document.querySelectorAll = (selector) => {
  if (selector === 'nav [data-tab]') return navButtons;
  if (selector === '[data-overview-target]') return overviewNodes;
  return [];
};
~~~

- [ ] Add one fixture test for all formulas:

  - Users: active and permissions_valid = 1; exclude active/invalid and inactive/valid.
  - Providers: two active and one inactive = 2.
  - Models: one active on an active provider; exclude an inactive model and an active model on an inactive provider = 1.
  - Policies: active built-in + active global + active scoped to the available model = 3; exclude inactive, empty scoped, and scoped only to unavailable models.
  - Click the Models node; assert Models nav alone has aria-current="page", tab-models is visible, and Models nav focusCount increments.

- [ ] Implement the exact formulas:

~~~js
function overviewResourceCounts() {
  const activeProviderIds = new Set(
    state.providers.filter((provider) => provider.is_active).map((provider) => provider.id),
  );
  const availableModels = state.models.filter(
    (model) => model.is_active && activeProviderIds.has(model.provider_id),
  );
  const availableModelIds = new Set(availableModels.map((model) => model.id));
  return {
    users: state.users.filter((user) => user.is_active && user.permissions_valid).length,
    policies: (state.builtInPii && state.builtInPii.is_active ? 1 : 0)
      + state.filters.filter((filter) => {
        if (!filter.is_active) return false;
        if (filter.is_global) return true;
        return (filter.model_ids || []).some((modelId) => availableModelIds.has(modelId));
      }).length,
    models: availableModels.length,
    providers: activeProviderIds.size,
  };
}
~~~

- [ ] Render counts and a safe provider snapshot:

~~~js
function providerHealthText(provider) {
  const parts = [provider.health_status || 'Unknown'];
  if (provider.last_health_latency_ms !== null && provider.last_health_latency_ms !== undefined) {
    parts.push(number(provider.last_health_latency_ms) + ' ms');
  }
  if (provider.last_health_check) parts.push(formatDate(provider.last_health_check));
  if (!provider.is_active) parts.push('Inactive');
  return parts.join(' · ');
}

function renderOverviewConfiguration() {
  const counts = overviewResourceCounts();
  for (const name of ['users', 'policies', 'models', 'providers']) {
    el('overview-' + name + '-count').textContent = String(counts[name]);
  }
  if (!state.providers.length) {
    el('overview-providers-content').replaceChildren(node('p', T.empty, 'empty'));
    return;
  }
  const list = node('ul', undefined, 'provider-snapshot');
  state.providers.forEach((provider) => {
    const item = node('li');
    item.append(
      node('strong', provider.display_name || provider.provider_name),
      node('span', providerHealthText(provider), 'operational-value'),
    );
    list.append(item);
  });
  el('overview-providers-content').replaceChildren(list);
}
~~~

Call renderOverviewConfiguration() in loadAll() after state assignment. It must not issue a request.

- [ ] Wire native nodes and transfer focus because the source node becomes hidden:

~~~js
document.querySelectorAll('[data-overview-target]').forEach((item) => {
  item.addEventListener('click', () => {
    const target = item.dataset.overviewTarget;
    selectSection(target);
    el('tab-button-' + target).focus();
  });
});
~~~

- [ ] Run and commit:

~~~powershell
node --test test/admin-dashboard.test.js
git add public/admin-dashboard.js test/admin-dashboard.test.js
git commit -m "feat: add Gateway overview resource path"
~~~

---

## Task 5: Share one resilient seven-day statistics snapshot

**Files:**

- Modify: public/admin-dashboard.js:3,21-22,56-59,81-82,85,117
- Modify: test/admin-dashboard.test.js:162-172,819-865 and new statistics tests

- [ ] Add a test asserting the initial statistics URL list is exactly ['/admin/stats?range=7d'] after login and remains one item after opening Usage. Return total_requests 10/successful_requests 9 and assert Overview shows 90.0% while Usage shows 10.

- [ ] Add a zero-state test: with dashboardStats(), Overview includes No requests exactly twice and Not configured, and excludes 0.0% and 0 ms.

- [ ] Add a guarded retry test: first 7d request returns 500; configuration and navigation remain usable; Overview and initial Usage show the local error; two Overview activations while one deferred retry is pending create only one second stats request; resolving it replaces the error.

- [ ] Add an ownership test: initial 7d fails, Usage Apply for 30d renders 30 requests, Overview retry later renders 7 requests, and Usage remains 30. Assert URL order 7d, 30d, 7d.

- [ ] Add a privacy test with six recent rows. Assert Overview renders at most five rows and ignores injected prompt, response, provider_error_body, stored_api_key, and admin_key properties.

- [ ] Add initial-stats 401 and Usage-Apply 403 cases. Both must clear authentication and return to login, not remain as a recoverable panel error.

- [ ] Extend state:

~~~js
sevenDayStats: null,
sevenDayStatsError: '',
sevenDayStatsRequest: null,
usageStats: null,
usageHasAppliedRange: false,
~~~

- [ ] Reset statistics state whenever login is shown so sign-out, authentication failure, and reload cannot expose a stale panel or trigger a stale retry:

~~~js
function resetStatisticsState() {
  state.sevenDayStats = null;
  state.sevenDayStatsError = '';
  state.sevenDayStatsRequest = null;
  state.usageStats = null;
  state.usageHasAppliedRange = false;
  for (const id of ['overview-stats-content', 'overview-activity-content', 'stats-content', 'usage-content', 'model-stats-content', 'provider-stats-content', 'request-content']) {
    el(id).replaceChildren();
  }
}

function showLogin() {
  resetStatisticsState();
  el('login').classList.remove('hidden');
  el('dashboard').classList.add('hidden');
  el('admin-key').value = '';
}
~~~

Use this revised showLogin after Task 1. Each statistics request must also capture the current key and ignore a late success or non-authentication failure after that key is cleared or replaced.

Add:

~~~js
function isAuthenticationError(error) {
  return error.status === 401 || error.status === 403;
}

function metricCard(label, value) {
  const card = node('div', undefined, 'metric');
  card.append(node('strong', value), node('span', label));
  return card;
}

function successRate(summary) {
  if (!summary.total_requests) return 'No requests';
  return ((summary.successful_requests / summary.total_requests) * 100).toFixed(1) + '%';
}

function p95Response(summary) {
  return summary.total_requests ? number(summary.p95_response_time_ms) + ' ms' : 'No requests';
}

function panelError(message) {
  const result = node('div', undefined, 'panel-state error');
  result.append(node('strong', 'Statistics unavailable'), node('p', message));
  return result;
}
~~~

- [ ] Add the Overview renderer:

~~~js
function renderOverviewStats(stats) {
  const summary = stats.summary;
  const cards = node('div', undefined, 'stats overview-stats');
  cards.append(
    metricCard('Requests', number(summary.total_requests)),
    metricCard('Success rate', successRate(summary)),
    metricCard('p95 response', p95Response(summary)),
    metricCard('Estimated cost · not billing', money(summary.estimated_cost_usd, summary.cost_configured)),
  );
  el('overview-stats-content').replaceChildren(cards);

  const rows = stats.recent_requests.slice(0, 5).map((row) => [
    formatDate(row.created_at),
    row.username || String(row.user_id),
    row.model_name,
    row.status,
    row.error_type || '—',
    number(row.input_tokens),
    number(row.output_tokens),
    number(row.response_time_ms) + ' ms',
  ]);
  el('overview-activity-content').replaceChildren(table(
    'Recent gateway activity',
    ['Time', 'User', 'Model', 'Status', 'Error type', 'Input', 'Output', 'Response'],
    rows,
  ));
}
~~~

Rename current renderStats(stats) to renderUsageStats(stats). Preserve all current Usage metrics/tables, use p95Response(summary) for its p95 card, and use the captioned table signature.

- [ ] Implement local errors and the guarded initial request:

~~~js
function renderOverviewStatsError(message) {
  el('overview-stats-content').replaceChildren(panelError(message));
  el('overview-activity-content').replaceChildren(panelError(message));
}

function renderUsageStatsError(message) {
  for (const id of ['stats-content', 'usage-content', 'model-stats-content', 'provider-stats-content', 'request-content']) {
    el(id).replaceChildren(panelError(message));
  }
}

function loadSevenDayStats() {
  if (state.sevenDayStatsRequest) return state.sevenDayStatsRequest;
  const requestKey = state.key;
  const request = api('/admin/stats?range=7d')
    .then((stats) => {
      if (!state.key || state.key !== requestKey) return null;
      state.sevenDayStats = stats;
      state.sevenDayStatsError = '';
      renderOverviewStats(stats);
      if (!state.usageHasAppliedRange) {
        state.usageStats = stats;
        renderUsageStats(stats);
      }
      return stats;
    })
    .catch((error) => {
      if (isAuthenticationError(error)) throw error;
      if (!state.key || state.key !== requestKey) return null;
      state.sevenDayStats = null;
      state.sevenDayStatsError = error.message;
      renderOverviewStatsError(error.message);
      if (!state.usageHasAppliedRange) renderUsageStatsError(error.message);
      return null;
    })
    .finally(() => {
      if (state.sevenDayStatsRequest === request) state.sevenDayStatsRequest = null;
    });
  state.sevenDayStatsRequest = request;
  return request;
}

async function loadInitial() {
  resetStatisticsState();
  const [configuration, statistics] = await Promise.allSettled([loadAll(), loadSevenDayStats()]);
  if (configuration.status === 'rejected') throw configuration.reason;
  if (statistics.status === 'rejected') throw statistics.reason;
}
~~~

At the end of selectSection():

~~~js
if (name === 'overview' && state.key && state.sevenDayStatsError) {
  void loadSevenDayStats();
}
~~~

- [ ] Replace Usage Apply:

~~~js
el('stats-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.usageHasAppliedRange = true;
  try {
    const stats = await api(statsPath());
    state.usageStats = stats;
    renderUsageStats(stats);
  } catch (error) {
    if (!isAuthenticationError(error)) renderUsageStatsError(error.message);
  }
});
~~~

Statistics must not use the global Loading status. Non-auth errors stay in affected panels.

- [ ] Run every existing CRUD/dialog regression and commit:

~~~powershell
node --test test/admin-dashboard.test.js
git add public/admin-dashboard.js test/admin-dashboard.test.js
git commit -m "feat: add resilient Gateway overview statistics"
~~~

---

## Task 6: Apply the Signal Grid visual system

**Files:**

- Modify: public/admin-dashboard.css:1-4
- Modify: test/admin-dashboard.test.js static visual-contract tests

- [ ] Add a static test for all approved tokens, a 2px accent :focus-visible outline, 36px controls, max-width 839px responsive rule, keyboard-scrollable .table-wrap, prefers-reduced-motion, and absence of url(). Assert the HTML still contains: cannot be retrieved again; it is not general DLP; stored in plaintext in SQLite and backups; do not enter secrets, prompts, or response examples.

- [ ] Add contrast helper assertions for text #e7ecf2 on #0e1319 >= 4.5, muted #96a2b1 on #111821 >= 4.5, accent #ffb454 on #080b0f >= 3, and border #596777 on #111821 >= 3.

- [ ] Replace the minified stylesheet. The foundation must be:

~~~css
:root {
  color-scheme: dark;
  --surface-root: #080b0f;
  --surface-page: #0e1319;
  --surface-panel: #111821;
  --border: #596777;
  --text: #e7ecf2;
  --text-muted: #96a2b1;
  --accent: #ffb454;
  --on-accent: #241406;
  --success: #58d597;
  --danger: #f17c74;
  --on-danger: #210b0a;
  --info: #78a9ff;
  font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
html { background: var(--surface-root); }
body { min-width: 0; margin: 0; overflow-x: hidden; color: var(--text); background: var(--surface-page); }
button, input, select, textarea { min-height: 36px; font: inherit; }
button {
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 7px 12px;
  color: var(--on-accent);
  background: var(--accent);
  font-weight: 700;
  cursor: pointer;
}
button.secondary { color: var(--text); background: transparent; border-color: var(--border); }
button.danger { color: var(--on-danger); background: var(--danger); border-color: var(--danger); }
button:disabled { cursor: not-allowed; opacity: .55; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.hidden { display: none !important; }
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
~~~

- [ ] Implement the desktop shell exactly at two columns, 176px and minmax(0,1fr), with a border, dark rail, labelled vertical nav, and workspace minimum width zero:

~~~css
.app-shell {
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr);
  width: min(1440px, calc(100% - 32px));
  min-height: calc(100vh - 32px);
  margin: 16px auto;
  border: 1px solid var(--border);
}
.nav-rail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 16px 12px;
  border-right: 1px solid var(--border);
  background: var(--surface-root);
}
.rail-nav { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
.rail-nav button { width: 100%; border-color: transparent; color: var(--text-muted); background: transparent; text-align: left; }
.rail-nav button[aria-current="page"] { border-color: var(--accent); color: var(--on-accent); background: var(--accent); }
.rail-sign-out { width: 100%; margin-top: 16px; }
.workspace { min-width: 0; padding: 24px; }
~~~

- [ ] Implement cards, Gateway nodes, metrics, forms, statuses, warnings, tables, and dialogs using only the approved tokens. Required contracts:

~~~css
.card { min-width: 0; margin-bottom: 16px; padding: 16px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-panel); }
.gateway-path { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr) auto) minmax(0, 1fr); align-items: stretch; gap: 8px; }
.gateway-node { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; min-width: 0; padding: 12px; border-color: var(--border); color: var(--text); background: var(--surface-root); text-align: left; }
.gateway-node strong { grid-column: 1 / -1; color: var(--accent); font: 700 28px/1 ui-monospace, SFMono-Regular, Consolas, monospace; }
.overview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.overview-activity { grid-column: 1 / -1; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
.metric { min-width: 0; padding: 12px; border: 1px solid var(--border); background: var(--surface-root); }
.metric strong { display: block; color: var(--accent); font: 700 20px/1.3 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
input, select, textarea { width: 100%; border: 1px solid var(--border); border-radius: 4px; padding: 7px 9px; color: var(--text); background: var(--surface-root); }
.status, .panel-state, .warning-panel { padding: 12px; border: 1px solid var(--info); border-radius: 4px; color: var(--text); background: var(--surface-panel); }
.status.error, .panel-state.error { border-color: var(--danger); }
.status.success { border-color: var(--success); }
.warning-panel { border-color: var(--accent); }
.badge { display: inline-block; padding: 2px 7px; border: 1px solid var(--border); border-radius: 999px; color: var(--text); background: var(--surface-root); }
.badge.active { border-color: var(--success); color: var(--success); }
.table-wrap { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); }
table { width: 100%; min-width: 680px; border-collapse: collapse; }
th, td { padding: 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
dialog { width: min(760px, calc(100% - 32px)); max-height: calc(100vh - 32px); overflow: auto; border: 1px solid var(--border); border-radius: 4px; padding: 18px; color: var(--text); background: var(--surface-panel); }
dialog::backdrop { background: rgb(8 11 15 / 78%); }
~~~

Complete every remaining current selector with the concrete rules below; do not leave any legacy light-theme declaration in the file:

~~~css
main { min-width: 0; }
#status { width: min(720px, calc(100% - 32px)); margin: 16px auto 0; }
#login { width: min(440px, calc(100% - 32px)); margin: max(32px, 12vh) auto; }
.login-panel h1 { margin: 4px 0 8px; }
.rail-brand { display: flex; align-items: center; gap: 10px; padding: 4px 6px 20px; }
.rail-brand strong, .rail-brand small { display: block; }
.rail-brand small { color: var(--text-muted); }
.brand-mark { display: grid; width: 36px; height: 36px; place-items: center; border: 1px solid var(--accent); color: var(--accent); font: 700 12px/1 ui-monospace, SFMono-Regular, Consolas, monospace; }
.workspace-header { padding-bottom: 16px; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
.workspace-header h1 { margin: 2px 0 0; font-size: clamp(24px, 3vw, 34px); line-height: 1.15; }
.eyebrow { margin: 0; color: var(--accent); font: 700 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .1em; }
.page-section { min-width: 0; }
.card h2 { margin: 0 0 12px; font-size: 17px; }
.card h3 { margin: 12px 0 8px; font-size: 15px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.section-heading h2 { margin: 0; }
.gateway-arrow { align-self: center; color: var(--accent); font: 700 18px/1 ui-monospace, SFMono-Regular, Consolas, monospace; }
.node-index, .node-detail { color: var(--text-muted); font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
.node-label { font-weight: 700; }
.provider-snapshot { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.provider-snapshot li { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.provider-snapshot li:last-child { padding-bottom: 0; border-bottom: 0; }
.operational-value { color: var(--text-muted); text-align: right; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
form { display: grid; gap: 12px; }
label { display: grid; gap: 5px; color: var(--text); font-weight: 650; }
textarea { min-height: 112px; resize: vertical; }
select[multiple]:disabled { color: var(--text-muted); background: var(--surface-page); }
.checks { display: flex; flex-wrap: wrap; gap: 12px; }
.checks label { display: flex; align-items: center; gap: 7px; }
.checks input { width: auto; min-height: auto; }
.actions, .dialog-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.actions button { min-height: 36px; padding: 6px 9px; }
.dialog-actions { justify-content: flex-end; margin-top: 4px; }
.help, .empty { color: var(--text-muted); }
.help { margin: 0; }
.empty { margin: 0; padding: 12px 0; }
code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
pre { max-width: 100%; margin: 8px 0; overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; padding: 12px; border: 1px solid var(--border); border-radius: 4px; color: var(--text); background: var(--surface-root); }
.status { margin-bottom: 16px; }
.panel-state strong, .panel-state p { display: block; margin: 0; }
.panel-state p { margin-top: 6px; color: var(--text-muted); }
tbody tr:last-child td { border-bottom: 0; }
th { color: var(--text-muted); font-size: 12px; letter-spacing: .05em; text-transform: uppercase; }
.filter-guide { background: var(--surface-root); }
.filter-steps { margin: 0 0 16px; padding-left: 22px; }
.filter-guide-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
details { border: 1px solid var(--border); padding: 10px; }
summary { cursor: pointer; font-weight: 700; }
~~~

- [ ] Add narrow and reduced-motion rules:

~~~css
@media (max-width: 839px) {
  .app-shell { display: block; width: 100%; min-height: 100vh; margin: 0; border-width: 0; }
  .nav-rail {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    padding: 12px;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
  .rail-sign-out { width: auto; margin: 0; }
  .rail-nav { grid-column: 1 / -1; flex-direction: row; min-width: 0; overflow-x: auto; padding-bottom: 4px; }
  .rail-nav button { flex: 0 0 auto; width: auto; white-space: nowrap; }
  .workspace { padding: 16px 12px 24px; }
  .gateway-path { grid-template-columns: minmax(0, 1fr); }
  .gateway-arrow { justify-self: center; transform: rotate(90deg); }
  .overview-grid { grid-template-columns: minmax(0, 1fr); }
  .overview-activity { grid-column: auto; }
}

@media (max-width: 520px) {
  .grid { grid-template-columns: minmax(0, 1fr); }
  .section-heading { align-items: stretch; flex-direction: column; }
  dialog { width: calc(100% - 16px); max-height: calc(100vh - 16px); padding: 12px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}
~~~

- [ ] Run, inspect, and commit:

~~~powershell
node --test test/admin-dashboard.test.js
git diff --check
git diff -- public/admin-dashboard.html public/admin-dashboard.css public/admin-dashboard.js test/admin-dashboard.test.js
git add public/admin-dashboard.css test/admin-dashboard.test.js
git commit -m "style: apply Signal Grid admin design"
~~~

---

## Task 7: Final verification

**Files:** Verify the four implementation files only.

- [ ] Invoke superpowers:verification-before-completion, then run:

~~~powershell
node --test test/admin-dashboard.test.js
npm.cmd test
git diff --check
git status --short
~~~

Doctor, backup, benchmark, production audit, schema, and Docker checks are not relevant because this plan changes no server, database, dependency, operational script, or image behavior.

- [ ] Start a review server with a new temporary DATABASE_PATH and in-memory generated ADMIN_SECRET_KEY. Never print the key; copy it to the clipboard. Do not touch data/gateway.db:

~~~powershell
$reviewRoot = Join-Path ([IO.Path]::GetTempPath()) ("llmward-signal-grid-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $reviewRoot | Out-Null
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$reviewPort = $listener.LocalEndpoint.Port
$listener.Stop()
$secretBytes = New-Object byte[] 32
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$random.GetBytes($secretBytes)
$random.Dispose()
$reviewKey = [Convert]::ToBase64String($secretBytes)
$env:ADMIN_SECRET_KEY = $reviewKey
$env:DATABASE_PATH = Join-Path $reviewRoot 'gateway.db'
$env:HOST = '127.0.0.1'
$env:PORT = [string]$reviewPort
$env:CORS_ORIGIN = "http://127.0.0.1:$reviewPort"
$env:LOG_LEVEL = 'error'
Set-Clipboard -Value $reviewKey
$serverProcess = Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory (Get-Location) -PassThru -WindowStyle Hidden
$healthUrl = "http://127.0.0.1:$reviewPort/health"
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $healthUrl | Out-Null
    break
  } catch {
    Start-Sleep -Milliseconds 200
  }
}
if ($attempt -eq 30) { throw 'Temporary review server did not become healthy.' }
Write-Output "Open http://127.0.0.1:$reviewPort/admin-dashboard.html and paste the clipboard key."
~~~

The command prints only the loopback URL. The generated key stays in process memory and the clipboard.

- [ ] Inspect 1440, 1024, 768, and 390 CSS pixels:

  - Login exposes only Gateway identity, key form, and authentication feedback.
  - Desktop has a 176px labelled rail; below 840px the same six labels form a horizontally scrollable row.
  - No page-level horizontal overflow; only named nav/table regions scroll.
  - Overview order and counts are Users → Policies → Models → Providers; each native node navigates and transfers focus.
  - Empty statistics show No requests twice and Not configured; configured zero cost remains a valid USD zero.
  - Provider health and recent activity are textual and metadata-only.
  - Users, Models, Providers, Filters, Usage, onboarding, dialogs, confirmations, token warning, filter warnings, and plaintext-storage warnings remain.
  - Keyboard-only traversal, visible focus, keyboard table scrolling, dialog containment, 200% zoom, and reduced motion all work.

- [ ] Verify reload requires sign-in, browser storage has no administrator key, sign-out returns to login, 401/403 returns to login, one initial 7d request serves both pages, Usage Apply updates Usage only, and repeated Overview activation creates at most one pending retry.

- [ ] Stop the temporary server, clear the temporary environment and clipboard, verify the resolved review directory is inside the operating-system temp directory, and remove only that directory:

~~~powershell
if ($serverProcess -and -not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id }
Remove-Item Env:ADMIN_SECRET_KEY, Env:DATABASE_PATH, Env:HOST, Env:PORT, Env:CORS_ORIGIN, Env:LOG_LEVEL -ErrorAction SilentlyContinue
Set-Clipboard -Value ''
$resolvedReviewRoot = [IO.Path]::GetFullPath($reviewRoot)
$resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $resolvedReviewRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to remove a non-temporary review directory.'
}
Remove-Item -LiteralPath $resolvedReviewRoot -Recurse -Force
~~~

- [ ] Review final scope:

~~~powershell
git log --oneline --decorate -7
git diff --stat HEAD~6..HEAD
git status --short
~~~

Completion requires every automated command to pass, every manual item above to pass, no unrelated path on the task branch, and no unresolved security, privacy, accessibility, or data-loss regression.
