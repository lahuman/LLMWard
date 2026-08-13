'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class FakeNode extends EventTarget {
  constructor() {
    super();
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.type = '';
    this.checked = false;
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
    };
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute() {}
}

class FakeForm extends FakeNode {
  constructor(values = {}) {
    super();
    this.values = values;
    this.resetCount = 0;
    this.elements = {};
  }

  reset() {
    this.resetCount += 1;
  }
}

class FakeFormData {
  constructor(form) {
    this.values = form.values;
  }

  get(name) {
    return this.values[name] ?? null;
  }

  getAll(name) {
    const value = this.get(name);
    return Array.isArray(value) ? value : value === null ? [] : [value];
  }
}

function response(body) {
  return { ok: true, status: 200, json: async () => body };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createDashboardHarness({ storedKey = '', fetchOverride } = {}) {
  const elements = new Map();
  const providerForm = new FakeForm({
    providerName: 'local',
    displayName: 'Local provider',
    baseUrl: 'http://127.0.0.1:8080',
    authType: 'none',
    envName: '',
    storedKey: '',
  });
  providerForm.elements.preset = new FakeNode();
  const modelForm = new FakeForm();
  modelForm.elements.providerId = new FakeNode();
  const filterForm = new FakeForm();
  filterForm.elements.modelIds = { selectedOptions: [], replaceChildren() {} };
  filterForm.elements.isGlobal = new FakeNode();
  const statsForm = new FakeForm({ range: '24h', start: '', end: '' });
  const requests = [];
  const builtInPiiForm = new FakeForm();
  builtInPiiForm.elements.isActive = new FakeNode();
  let builtInPiiActive = false;
  const builtInPiiRules = [
    { id: 'resident', label: 'Resident identifier', mode: 'restore' },
    { id: 'private_key', label: '<script>not markup</script>', mode: 'redact' },
  ];

  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeNode());
      return elements.get(id);
    },
    querySelectorAll() {
      return [];
    },
    createElement(tagName) {
      const node = new FakeNode();
      node.tagName = String(tagName).toUpperCase();
      return node;
    },
    createTextNode(text) {
      const node = new FakeNode();
      node.textContent = String(text);
      return node;
    },
  };
  elements.set('provider-form', providerForm);
  elements.set('built-in-pii-form', builtInPiiForm);
  elements.set('built-in-pii-rules', new FakeNode());
  elements.set('built-in-pii-state', new FakeNode());
  elements.set('model-form', modelForm);
  elements.set('filter-form', filterForm);
  elements.set('stats-form', statsForm);
  const loginForm = new FakeForm();
  elements.set('login-form', loginForm);
  elements.set('user-form', new FakeForm());
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
    fetch: async (route, options = {}) => {
      requests.push({ route, options });
      const overridden = fetchOverride && fetchOverride(route, options);
      if (overridden !== undefined) return overridden;
      if (route === '/admin/providers' && options.method === 'POST') return response({});
      if (route === '/admin/users') return response([]);
      if (route === '/admin/filters/built-in-pii' && options.method === 'PUT') {
        builtInPiiActive = JSON.parse(options.body).is_active;
      }
      if (route === '/admin/filters/built-in-pii') return response({ id: 'built-in-pii', name: 'Built-in Korean PII & Secret Filter', is_active: builtInPiiActive, is_global: true, rules: builtInPiiRules });
      if (route === '/admin/models') return response([]);
      if (route === '/admin/providers') return response([]);
      if (route === '/admin/filters') return response([]);
      if (route === '/admin/onboarding') return response({ complete: true, steps: [], example: '' });
      if (route === '/admin/provider-presets') return response([]);
      if (route.startsWith('/admin/stats?')) return response({ summary: {}, period: {}, by_user: [], by_model: [], by_provider: [], recent_requests: [] });
      throw new Error(`Unexpected route: ${route}`);
    },
    sessionStorage: { getItem: () => storedKey, setItem() {}, removeItem() {} },
    window: new FakeNode(),
  };
  context.window.prompt = () => null;
  context.window.confirm = () => false;
  context.window.addEventListener = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.js'), 'utf8'), context);
  return {
    adminKey: document.getElementById('admin-key'),
    loginForm,
    providerForm,
    requests,
    status: document.getElementById('status'),
    builtInPiiForm,
    builtInPiiRules: document.getElementById('built-in-pii-rules'),
    get builtInPiiActive() { return builtInPiiActive; },
    builtInPiiState: document.getElementById('built-in-pii-state'),

    usersContent: document.getElementById('users-content'),
    window: context.window,
  };
}

function collectText(node) {
  return [node.textContent, ...node.children.flatMap(collectText)].filter(Boolean);
}

function findButton(node, label) {
  if (node.type === 'button' && node.textContent === label) return node;
  for (const child of node.children) {
    const match = findButton(child, label);
    if (match) return match;
  }
  return null;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
test('filters tab keeps the built-in PII filter before its sibling usage guide', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');
  assert.match(html, /<section id="tab-filters"[^>]*>\s*<section id="built-in-pii-filter"[\s\S]*?<\/section>\s*<section id="filter-usage-guide"/);
});

test('built-in PII filter saves its active state and renders rules as safe list items', async () => {
  const harness = createDashboardHarness();
  harness.builtInPiiForm.elements.isActive.checked = true;
  harness.builtInPiiForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.builtInPiiActive, true);
  assert.equal(harness.builtInPiiState.textContent, 'Active');
  assert.equal(harness.builtInPiiState.className, 'badge active');
  assert.deepEqual(harness.builtInPiiRules.children.map((item) => item.tagName), ['LI', 'LI']);
  assert.equal(harness.builtInPiiRules.children[1].textContent, '<script>not markup</script> - irreversible redaction');
  assert.equal(harness.builtInPiiRules.children[1].children.length, 0);
  harness.builtInPiiForm.elements.isActive.checked = false;
  harness.builtInPiiForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.builtInPiiState.textContent, 'Inactive');
  assert.equal(harness.builtInPiiState.className, 'badge');
  assert.deepEqual(
    harness.requests.filter(({ route, options }) => route === '/admin/filters/built-in-pii' && options.method === 'PUT')
      .map(({ options }) => JSON.parse(options.body)),
    [{ is_active: true }, { is_active: false }],
  );
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/filters/built-in-pii' && !options.method).length, 2);
  assert.equal(harness.requests.some(({ route }) => route.startsWith('/admin/stats?')), false);
});


test('provider submit keeps its form after the async create request', async () => {
  const { providerForm, requests, status } = createDashboardHarness();

  providerForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();

  assert.equal(providerForm.resetCount, 1);
  assert.equal(status.textContent, 'Created successfully.');
  assert.equal(status.className, 'status success');
  assert.deepEqual(
    requests.filter(({ options }) => !options.method).map(({ route }) => route).sort(),
    ['/admin/filters', '/admin/filters/built-in-pii', '/admin/models', '/admin/onboarding', '/admin/provider-presets', '/admin/providers', '/admin/users'].sort(),
  );
});

test('provider submit reloads configuration without reloading statistics', async () => {
  const { providerForm, requests } = createDashboardHarness();

  providerForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();

  const reloadRoutes = requests.filter(({ options }) => !options.method).map(({ route }) => route);
  assert.deepEqual(
    reloadRoutes.filter((route) => !route.startsWith('/admin/stats?')).sort(),
    ['/admin/filters', '/admin/filters/built-in-pii', '/admin/models', '/admin/onboarding', '/admin/provider-presets', '/admin/providers', '/admin/users'].sort(),
  );
  assert.equal(reloadRoutes.some((route) => route.startsWith('/admin/stats?')), false);
});

test('explicit login starts configuration and statistics together', async () => {
  const delayedUsers = deferred();
  let userRequests = 0;
  const { adminKey, loginForm, requests } = createDashboardHarness({
    fetchOverride(route) {
      if (route === '/admin/users' && ++userRequests === 2) return delayedUsers.promise;
      return undefined;
    },
  });
  adminKey.value = 'admin-key';

  loginForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();

  const configurationStarted = requests.some(({ route }) => route === '/admin/providers');
  const statisticsStarted = requests.some(({ route }) => route.startsWith('/admin/stats?'));
  delayedUsers.resolve(response([]));
  await settle();

  assert.equal(configurationStarted, true);
  assert.equal(statisticsStarted, true);
});

test('stored-key initial loading preserves a statistics error after delayed configuration succeeds', async () => {
  const delayedUsers = deferred();
  const { requests, status } = createDashboardHarness({
    storedKey: 'stored-admin-key',
    fetchOverride(route) {
      if (route === '/admin/users') return delayedUsers.promise;
      if (route.startsWith('/admin/stats?')) {
        return { ok: false, status: 500, json: async () => ({ error: 'Statistics failed.' }) };
      }
      return undefined;
    },
  });
  await settle();

  const configurationStarted = requests.some(({ route }) => route === '/admin/providers');
  const statisticsStarted = requests.some(({ route }) => route.startsWith('/admin/stats?'));
  delayedUsers.resolve(response([]));
  await settle();

  assert.equal(configurationStarted, true);
  assert.equal(statisticsStarted, true);
  assert.equal(status.textContent, 'Statistics failed.');
  assert.equal(status.className, 'status error');
});

test('dashboard renders zero quotas as unlimited and explains zero while editing', async () => {
  const user = {
    id: 1,
    username: 'unlimited-user',
    is_active: true,
    max_daily_input_tokens: 0,
    max_daily_output_tokens: 0,
    permissions_valid: true,
    allowed_models: [],
    created_at: '2026-08-12T00:00:00.000Z',
  };
  const positiveQuotaUser = {
    id: 2,
    username: 'limited-user',
    is_active: true,
    max_daily_input_tokens: 1234567,
    max_daily_output_tokens: 7654321,
    permissions_valid: true,
    allowed_models: [],
    created_at: '2026-08-12T00:00:00.000Z',
  };
  const harness = createDashboardHarness({
    storedKey: 'stored-admin-key',
    fetchOverride(route) {
      if (route === '/admin/users') return response([user, positiveQuotaUser]);
      return undefined;
    },
  });
  const prompts = [];
  harness.window.prompt = (label, initialValue) => {
    prompts.push([label, initialValue]);
    return prompts.length === 1 ? initialValue : null;
  };
  await settle();

  const renderedText = collectText(harness.usersContent);
  assert.equal(renderedText.filter((text) => text === 'Unlimited').length, 2);
  assert.ok(renderedText.includes(new Intl.NumberFormat().format(1234567)));
  assert.ok(renderedText.includes(new Intl.NumberFormat().format(7654321)));
  const edit = findButton(harness.usersContent, 'Edit');
  assert.ok(edit);
  edit.dispatchEvent(new Event('click'));

  assert.deepEqual(prompts, [
    ['Daily input quota (0 = unlimited)', '0'],
    ['Daily output quota (0 = unlimited)', '0'],
  ]);
});
