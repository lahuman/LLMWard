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
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeNode());
      return elements.get(id);
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return new FakeNode();
    },
    createTextNode(text) {
      const node = new FakeNode();
      node.textContent = String(text);
      return node;
    },
  };
  elements.set('provider-form', providerForm);
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

test('provider submit keeps its form after the async create request', async () => {
  const { providerForm, requests, status } = createDashboardHarness();

  providerForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();

  assert.equal(providerForm.resetCount, 1);
  assert.equal(status.textContent, 'Created successfully.');
  assert.equal(status.className, 'status success');
  assert.deepEqual(
    requests.filter(({ options }) => !options.method).map(({ route }) => route).sort(),
    ['/admin/filters', '/admin/models', '/admin/onboarding', '/admin/provider-presets', '/admin/providers', '/admin/users'].sort(),
  );
});

test('provider submit reloads configuration without reloading statistics', async () => {
  const { providerForm, requests } = createDashboardHarness();

  providerForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();

  const reloadRoutes = requests.filter(({ options }) => !options.method).map(({ route }) => route);
  assert.deepEqual(
    reloadRoutes.filter((route) => !route.startsWith('/admin/stats?')).sort(),
    ['/admin/filters', '/admin/models', '/admin/onboarding', '/admin/provider-presets', '/admin/providers', '/admin/users'].sort(),
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
  const harness = createDashboardHarness({
    storedKey: 'stored-admin-key',
    fetchOverride(route) {
      if (route === '/admin/users') return response([user]);
      return undefined;
    },
  });
  const prompts = [];
  harness.window.prompt = (label, initialValue) => {
    prompts.push([label, initialValue]);
    return prompts.length === 1 ? initialValue : null;
  };
  await settle();

  assert.equal(collectText(harness.usersContent).filter((text) => text === 'Unlimited').length, 2);
  const edit = findButton(harness.usersContent, 'Edit');
  assert.ok(edit);
  edit.dispatchEvent(new Event('click'));

  assert.deepEqual(prompts, [
    ['Daily input quota (0 = unlimited)', '0'],
    ['Daily output quota (0 = unlimited)', '0'],
  ]);
});
