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
    this.attributes = new Map();
    this._className = '';
    this._classes = new Set();
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.defaultValue = '';
    this.type = '';
    this.checked = false;
    this.defaultChecked = false;
    this.disabled = false;
    this.selected = false;
    this.focusCount = 0;
    this.classList = {
      add: (...names) => this.updateClasses((classes) => names.forEach((name) => classes.add(name))),
      remove: (...names) => this.updateClasses((classes) => names.forEach((name) => classes.delete(name))),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this._classes.has(name) : Boolean(force);
        this.updateClasses((classes) => enabled ? classes.add(name) : classes.delete(name));
        return enabled;
      },
      contains: (name) => this._classes.has(name),
    };
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value);
    this._classes = new Set(this._className.split(/\s+/u).filter(Boolean));
  }

  get options() {
    return this.children;
  }

  get selectedOptions() {
    return this.children.filter((child) => child.selected);
  }

  updateClasses(change) {
    change(this._classes);
    this._className = [...this._classes].join(' ');
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  focus() {
    this.focusCount += 1;
  }
}

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

class FakeForm extends FakeNode {
  constructor(values = {}) {
    super();
    this.values = values;
    this.resetCount = 0;
    this.elements = {};
  }

  reset() {
    this.resetCount += 1;
    for (const control of Object.values(this.elements)) {
      if (!control || Array.isArray(control)) continue;
      control.value = control.defaultValue;
      control.checked = control.defaultChecked;
      for (const option of control.options || []) option.selected = option.defaultSelected || false;
    }
  }
}

class FakeFormData {
  constructor(form) {
    this.form = form;
    this.values = form.values;
  }

  get(name) {
    const control = this.form.elements && this.form.elements[name];
    if (control) {
      if (control.disabled) return null;
      if (control.type === 'checkbox') return control.checked ? control.value || 'on' : null;
      if (control.multiple) {
        const selected = Array.from(control.selectedOptions || []);
        if (control.multiple) return selected.length ? selected[0].value : null;
      }
      return control.value;
    }
    return this.values[name] ?? null;
  }

  getAll(name) {
    const control = this.form.elements && this.form.elements[name];
    if (control) {
      if (control.disabled) return [];
      if (control.type === 'checkbox') return control.checked ? [control.value || 'on'] : [];
      if (control.multiple) {
        return Array.from(control.selectedOptions || [], (option) => option.value);
      }
      return [control.value];
    }
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

function createDashboardHarness({ storedKey = '', fetchOverride, confirmResult = false } = {}) {
  const elements = new Map();
  const register = (id, item = new FakeNode()) => {
    elements.set(id, item);
    return item;
  };
  const control = (form, name, { value = '', type = '', checked = false, ...properties } = {}) => {
    const item = Object.assign(new FakeNode(), properties);
    item.value = String(value);
    item.defaultValue = String(value);
    item.type = type;
    item.checked = checked;
    item.defaultChecked = checked;
    form.elements[name] = item;
    register(name, item);
    return item;
  };
  const userForm = register('user-form', new FakeForm());
  control(userForm, 'userId');
  control(userForm, 'username');
  control(userForm, 'inputQuota', { value: '0', type: 'number' });
  control(userForm, 'outputQuota', { value: '0', type: 'number' });
  control(userForm, 'allowedModels');
  const modelForm = register('model-form', new FakeForm());
  control(modelForm, 'modelId');
  control(modelForm, 'modelName');
  control(modelForm, 'displayName');
  control(modelForm, 'providerId');
  control(modelForm, 'maxTokens', { value: '4096', type: 'number' });
  control(modelForm, 'inputPrice', { type: 'number' });
  control(modelForm, 'outputPrice', { type: 'number' });
  control(modelForm, 'contextWindow', { type: 'number' });
  control(modelForm, 'defaultTemperature', { type: 'number' });
  control(modelForm, 'defaultTopP', { type: 'number' });
  control(modelForm, 'defaultPresencePenalty', { type: 'number' });
  control(modelForm, 'defaultFrequencyPenalty', { type: 'number' });
  control(modelForm, 'defaultSeed', { type: 'number' });
  const providerForm = register('provider-form', new FakeForm());
  control(providerForm, 'providerId');
  control(providerForm, 'preset');
  control(providerForm, 'providerName');
  control(providerForm, 'displayName');
  control(providerForm, 'baseUrl');
  control(providerForm, 'authType', { value: 'none' });
  control(providerForm, 'envName');
  control(providerForm, 'storedKey', { type: 'password' });
  control(providerForm, 'removeStoredKey', { type: 'checkbox' });
  const filterForm = new FakeForm();
  filterForm.elements.modelIds = Object.assign(new FakeNode(), { multiple: true });
  filterForm.elements.isGlobal = new FakeNode();
  const statsForm = new FakeForm({ range: '24h', start: '', end: '' });
  const requests = [];
  const clipboardWrites = [];
  const sessionValues = new Map(storedKey ? [['llmGatewayAdminKey', storedKey]] : []);
  let confirmCount = 0;
  let promptCount = 0;
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
  for (const id of ['user-dialog', 'model-dialog', 'provider-dialog', 'confirm-dialog']) register(id, new FakeDialog());
  register('confirm-form', new FakeForm());
  for (const id of [
    'create-user', 'create-model', 'create-provider',
    'user-cancel', 'model-cancel', 'provider-cancel',
    'user-submit', 'model-submit', 'provider-submit',
    'user-token-copy', 'user-token-close', 'confirm-submit', 'confirm-cancel',
  ]) {
    register(id).type = 'button';
  }
  for (const id of [
    'user-dialog-title', 'user-dialog-description', 'user-dialog-status', 'user-token-result', 'user-token-value',
    'model-dialog-title', 'model-dialog-description', 'model-dialog-status', 'model-advanced',
    'provider-dialog-title', 'provider-dialog-description', 'provider-dialog-status',
    'provider-preset-field', 'provider-env-field',
    'confirm-title', 'confirm-message', 'confirm-dialog-status',
  ]) register(id);
  elements.set('built-in-pii-form', builtInPiiForm);
  elements.set('built-in-pii-rules', new FakeNode());
  elements.set('built-in-pii-state', new FakeNode());
  elements.set('filter-form', filterForm);
  elements.set('stats-form', statsForm);
  const loginForm = new FakeForm();
  elements.set('login-form', loginForm);
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
    navigator: { clipboard: { writeText: async (value) => clipboardWrites.push(value) } },
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
    sessionStorage: {
      getItem: (key) => sessionValues.get(key) || null,
      setItem: (key, value) => sessionValues.set(key, String(value)),
      removeItem: (key) => sessionValues.delete(key),
    },
    window: new FakeNode(),
  };
  context.window.prompt = () => { promptCount += 1; throw new Error('Resource flows must not call window.prompt'); };
  context.window.confirm = () => { confirmCount += 1; return confirmResult; };
  context.window.addEventListener = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.js'), 'utf8'), context);
  return {
    adminKey: document.getElementById('admin-key'),
    loginForm,
    userForm,
    modelForm,
    providerForm,
    requests,
    status: document.getElementById('status'),
    builtInPiiForm,
    builtInPiiRules: document.getElementById('built-in-pii-rules'),
    get builtInPiiActive() { return builtInPiiActive; },
    builtInPiiState: document.getElementById('built-in-pii-state'),

    usersContent: document.getElementById('users-content'),
    createUser: document.getElementById('create-user'),
    createModel: document.getElementById('create-model'),
    createProvider: document.getElementById('create-provider'),
    userDialog: document.getElementById('user-dialog'),
    modelDialog: document.getElementById('model-dialog'),
    providerDialog: document.getElementById('provider-dialog'),
    confirmDialog: document.getElementById('confirm-dialog'),
    userCancel: document.getElementById('user-cancel'),
    modelCancel: document.getElementById('model-cancel'),
    providerCancel: document.getElementById('provider-cancel'),
    userTokenResult: document.getElementById('user-token-result'),
    userTokenValue: document.getElementById('user-token-value'),
    userTokenCopy: document.getElementById('user-token-copy'),
    userTokenClose: document.getElementById('user-token-close'),
    userSubmit: document.getElementById('user-submit'),
    userDialogStatus: document.getElementById('user-dialog-status'),
    confirmForm: document.getElementById('confirm-form'),
    confirmSubmit: document.getElementById('confirm-submit'),
    confirmMessage: document.getElementById('confirm-message'),
    confirmDialogStatus: document.getElementById('confirm-dialog-status'),
    clipboardWrites,
    sessionValues,
    get confirmCount() { return confirmCount; },
    get promptCount() { return promptCount; },
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

test('dashboard exposes labelled native resource and confirmation dialogs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');
  assert.equal((html.match(/<dialog\b/gu) || []).length, 4);
  for (const resource of ['user', 'model', 'provider']) {
    assert.match(html, new RegExp(`<dialog id="${resource}-dialog"[^>]*aria-labelledby="${resource}-dialog-title"[^>]*aria-describedby="${resource}-dialog-description"`));
    assert.match(html, new RegExp(`id="${resource}-dialog-status"[^>]*role="status"[^>]*aria-live="polite"`));
    assert.match(html, new RegExp(`id="create-${resource}"`));
  }
  assert.match(html, /<dialog id="confirm-dialog"[^>]*aria-labelledby="confirm-title"[^>]*aria-describedby="confirm-message"/);
  assert.match(html, /id="confirm-dialog-status"[^>]*role="status"[^>]*aria-live="polite"/);
  for (const name of ['inputQuota', 'outputQuota', 'maxTokens']) {
    assert.match(html, new RegExp(`<input name="${name}"[^>]*max="9007199254740991"`));
  }
  assert.match(html, /<input name="contextWindow"[^>]*min="1"[^>]*max="9007199254740991"[^>]*step="1"[^>]*aria-describedby="context-window-help"/);
  assert.match(html, /<input name="defaultTemperature"[^>]*min="0"[^>]*max="2"[^>]*aria-describedby="model-defaults-help"/);
  assert.match(html, /<input name="defaultTopP"[^>]*min="0"[^>]*max="1"[^>]*aria-describedby="model-defaults-help"/);
  assert.match(html, /<input name="defaultPresencePenalty"[^>]*min="-2"[^>]*max="2"[^>]*aria-describedby="model-defaults-help"/);
  assert.match(html, /<input name="defaultFrequencyPenalty"[^>]*min="-2"[^>]*max="2"[^>]*aria-describedby="model-defaults-help"/);
  assert.match(html, /<input name="defaultSeed"[^>]*min="-9007199254740991"[^>]*max="9007199254740991"[^>]*step="1"[^>]*aria-describedby="model-defaults-help"/);
  assert.match(html, /id="context-window-help"[^>]*>[^<]*does not reconfigure the provider/);
  assert.match(html, /id="model-defaults-help"[^>]*>[^<]*Client-owned fields always win/);
  assert.match(html, /<details id="model-advanced">/);
  for (const resource of ['user', 'model', 'provider']) {
    const section = html.match(new RegExp(`<section id="tab-${resource}s"[\\s\\S]*?(?=<section id="tab-|<\/div>\\s*<\/main>)`));
    assert.ok(section);
    assert.doesNotMatch(section[0], new RegExp(`<form id="${resource}-form"`));
    assert.doesNotMatch(section[0], new RegExp(`<h2>Create ${resource}`));
  }
});

test('create dialogs reset forms focus the first control and restore focus on cancel or Escape', () => {
  const harness = createDashboardHarness();
  harness.userForm.elements.username.value = 'stale-user';
  harness.createUser.dispatchEvent(new Event('click'));
  assert.equal(harness.userDialog.showModalCount, 1);
  assert.equal(harness.userForm.elements.userId.value, '');
  assert.equal(harness.userForm.elements.username.value, '');
  assert.equal(harness.userForm.elements.username.focusCount, 1);
  harness.userCancel.dispatchEvent(new Event('click'));
  assert.equal(harness.userDialog.open, false);
  assert.equal(harness.createUser.focusCount, 1);

  harness.modelForm.elements.modelName.value = 'stale-model';
  harness.createModel.dispatchEvent(new Event('click'));
  assert.equal(harness.modelDialog.showModalCount, 1);
  assert.equal(harness.modelForm.elements.modelId.value, '');
  assert.equal(harness.modelForm.elements.modelName.value, '');
  assert.equal(harness.modelForm.elements.modelName.focusCount, 1);
  harness.modelDialog.cancel();
  assert.equal(harness.modelDialog.open, false);
  assert.equal(harness.createModel.focusCount, 1);

  harness.providerForm.elements.preset.value = 'stale-preset';
  harness.createProvider.dispatchEvent(new Event('click'));
  assert.equal(harness.providerDialog.showModalCount, 1);
  assert.equal(harness.providerForm.elements.providerId.value, '');
  assert.equal(harness.providerForm.elements.preset.value, '');
  assert.equal(harness.providerForm.elements.preset.focusCount, 1);
  harness.providerCancel.dispatchEvent(new Event('click'));
  assert.equal(harness.createProvider.focusCount, 1);
  assert.equal(harness.confirmCount, 0);
});

test('backdrop clicks do not discard resource forms', () => {
  const harness = createDashboardHarness();
  harness.createProvider.dispatchEvent(new Event('click'));
  harness.providerForm.elements.baseUrl.value = 'https://provider.example/v1';
  harness.providerDialog.dispatchEvent(new Event('click'));
  assert.equal(harness.providerDialog.open, true);
  assert.equal(harness.providerForm.elements.baseUrl.value, 'https://provider.example/v1');
  assert.equal(harness.confirmCount, 0);
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


test('user create submits once and shows a one-time token until explicitly closed', async () => {
  const mutation = deferred();
  const token = 'created-<token>';
  let userLoads = 0;
  const harness = createDashboardHarness({
    storedKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/users' && options.method === 'POST') return mutation.promise;
      if (route === '/admin/users' && !options.method) {
        userLoads += 1;
        if (userLoads === 1) return response([]);
        return { ok: false, status: 500, json: async () => ({ error: 'Refresh failed.' }) };
      }
      return undefined;
    },
  });
  await settle();

  harness.createUser.dispatchEvent(new Event('click'));
  harness.userForm.elements.username.value = 'alice';
  harness.userForm.elements.inputQuota.value = '0';
  harness.userForm.elements.outputQuota.value = '0';
  harness.userForm.elements.allowedModels.value = 'model-a, model-b';
  harness.userForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.userForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();

  const posts = harness.requests.filter(({ route, options }) => route === '/admin/users' && options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].options.body), {
    username: 'alice',
    max_daily_input_tokens: 0,
    max_daily_output_tokens: 0,
    allowed_models: ['model-a', 'model-b'],
  });
  assert.equal(harness.userSubmit.disabled, true);

  mutation.resolve(response({ apiToken: token }));
  await settle();

  assert.equal(harness.userDialog.open, true);
  assert.equal(harness.userForm.classList.contains('hidden'), true);
  assert.equal(harness.userTokenResult.classList.contains('hidden'), false);
  assert.equal(harness.userTokenValue.textContent, token);
  assert.equal(harness.userTokenValue.children.length, 0);
  assert.equal(harness.userTokenCopy.focusCount, 1);
  assert.equal(harness.status.textContent, 'Refresh failed.');
  assert.equal(harness.status.textContent.includes(token), false);
  assert.equal([...harness.sessionValues.values()].includes(token), false);

  harness.userTokenCopy.dispatchEvent(new Event('click'));
  await settle();
  assert.deepEqual(harness.clipboardWrites, [token]);

  harness.userTokenClose.dispatchEvent(new Event('click'));
  assert.equal(harness.userDialog.open, false);
  assert.equal(harness.userTokenValue.textContent, '');
  assert.equal(harness.createUser.focusCount, 1);
});

test('user edit populates supported fields without enabling username rename', async () => {
  const user = {
    id: 7,
    username: 'alice',
    is_active: true,
    max_daily_input_tokens: 0,
    max_daily_output_tokens: 0,
    permissions_valid: true,
    allowed_models: ['model-a', 'model-b'],
    created_at: '2026-08-13T00:00:00.000Z',
  };
  const mutation = deferred();
  const harness = createDashboardHarness({
    storedKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/users') return response([user]);
      if (route === '/admin/users/7' && options.method === 'PUT') return mutation.promise;
      return undefined;
    },
  });
  await settle();
  const oldEdit = findButton(harness.usersContent, 'Edit');

  oldEdit.dispatchEvent(new Event('click'));
  assert.equal(harness.userDialog.open, true);
  assert.equal(harness.userForm.elements.userId.value, '7');
  assert.equal(harness.userForm.elements.username.value, 'alice');
  assert.equal(harness.userForm.elements.username.disabled, true);
  assert.equal(harness.userForm.elements.inputQuota.value, '0');
  assert.equal(harness.userForm.elements.outputQuota.value, '0');
  assert.equal(harness.userForm.elements.allowedModels.value, 'model-a, model-b');
  harness.userForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.userForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();

  const puts = harness.requests.filter(({ route, options }) => route === '/admin/users/7' && options.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.deepEqual(JSON.parse(puts[0].options.body), {
    max_daily_input_tokens: 0,
    max_daily_output_tokens: 0,
    allowed_models: ['model-a', 'model-b'],
  });
  assert.equal(Object.hasOwn(JSON.parse(puts[0].options.body), 'username'), false);
  assert.equal(harness.userSubmit.disabled, true);

  mutation.resolve(response(user));
  await settle();

  const newEdit = findButton(harness.usersContent, 'Edit');
  assert.equal(harness.userDialog.open, false);
  assert.notEqual(newEdit, oldEdit);
  assert.equal(oldEdit.focusCount, 0);
  assert.equal(newEdit.focusCount, 1);
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/users' && !options.method).length, 2);
  assert.equal(harness.requests.filter(({ route }) => route.startsWith('/admin/stats?')).length, 1);
  assert.equal(harness.promptCount, 0);
  assert.equal(harness.confirmCount, 0);
});

test('user mutation errors stay local and preserve input', async () => {
  const mutation = deferred();
  const hostileError = '<script>invalid</script>';
  const harness = createDashboardHarness({
    storedKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/users' && options.method === 'POST') return mutation.promise;
      return undefined;
    },
  });
  await settle();
  harness.createUser.dispatchEvent(new Event('click'));
  harness.userForm.elements.username.value = 'alice';
  harness.userForm.elements.inputQuota.value = '17';
  harness.userForm.elements.outputQuota.value = '23';
  harness.userForm.elements.allowedModels.value = 'model-a';
  harness.userForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.userForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/users' && options.method === 'POST').length, 1);
  assert.equal(harness.userSubmit.disabled, true);

  mutation.resolve({ ok: false, status: 400, json: async () => ({ error: hostileError }) });
  await settle();

  assert.equal(harness.userDialog.open, true);
  assert.equal(harness.userForm.elements.username.value, 'alice');
  assert.equal(harness.userForm.elements.inputQuota.value, '17');
  assert.equal(harness.userForm.elements.outputQuota.value, '23');
  assert.equal(harness.userForm.elements.allowedModels.value, 'model-a');
  assert.equal(harness.userSubmit.disabled, false);
  assert.equal(harness.userDialogStatus.textContent, hostileError);
  assert.equal(harness.userDialogStatus.children.length, 0);
  assert.equal(harness.status.textContent.includes(hostileError), false);
});

test('user deactivation is confirmed by name and uses DELETE while activation is direct PUT', async () => {
  const active = {
    id: 1, username: 'active-user', is_active: true,
    max_daily_input_tokens: 0, max_daily_output_tokens: 0,
    permissions_valid: true, allowed_models: [], created_at: '2026-08-13T00:00:00.000Z',
  };
  const inactive = { ...active, id: 2, username: 'inactive-user', is_active: false };
  const deactivation = deferred();
  let userLoads = 0;
  const harness = createDashboardHarness({
    storedKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/users' && !options.method) {
        userLoads += 1;
        return response(userLoads === 1 ? [active, inactive] : [inactive]);
      }
      if (route === '/admin/users/1' && options.method === 'DELETE') return deactivation.promise;
      if (route === '/admin/users/2' && options.method === 'PUT') return response({ ...inactive, is_active: true });
      return undefined;
    },
  });
  await settle();

  findButton(harness.usersContent, 'Deactivate').dispatchEvent(new Event('click'));
  assert.equal(harness.confirmDialog.open, true);
  assert.match(harness.confirmMessage.textContent, /active-user/u);
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/users/1' && options.method === 'DELETE').length, 1);
  assert.equal(harness.confirmSubmit.disabled, true);

  deactivation.resolve(response({}));
  await settle();
  const confirmOpenCount = harness.confirmDialog.showModalCount;
  findButton(harness.usersContent, 'Activate').dispatchEvent(new Event('click'));
  await settle();

  const activation = harness.requests.filter(({ route, options }) => route === '/admin/users/2' && options.method === 'PUT');
  assert.equal(activation.length, 1);
  assert.deepEqual(JSON.parse(activation[0].options.body), { is_active: true });
  assert.equal(harness.confirmDialog.showModalCount, confirmOpenCount);
  assert.equal(harness.confirmCount, 0);
});

test('failed deactivation keeps confirmation open with its server error', async () => {
  const user = {
    id: 9, username: 'blocked-user', is_active: true,
    max_daily_input_tokens: 0, max_daily_output_tokens: 0,
    permissions_valid: true, allowed_models: [], created_at: '2026-08-13T00:00:00.000Z',
  };
  const mutation = deferred();
  const error = '<script>cannot deactivate</script>';
  const harness = createDashboardHarness({
    storedKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/users') return response([user]);
      if (route === '/admin/users/9' && options.method === 'DELETE') return mutation.promise;
      return undefined;
    },
  });
  await settle();
  findButton(harness.usersContent, 'Deactivate').dispatchEvent(new Event('click'));
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/users/9' && options.method === 'DELETE').length, 1);
  assert.equal(harness.confirmSubmit.disabled, true);

  mutation.resolve({ ok: false, status: 400, json: async () => ({ error }) });
  await settle();

  assert.equal(harness.confirmDialog.open, true);
  assert.equal(harness.confirmSubmit.disabled, false);
  assert.equal(harness.confirmDialogStatus.textContent, error);
  assert.equal(harness.confirmDialogStatus.children.length, 0);
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/users/9' && options.method === 'DELETE').length, 1);
});

test('token rotation requires confirmation and reuses the one-time token result', async () => {
  const user = {
    id: 11, username: 'rotation-user', is_active: true,
    max_daily_input_tokens: 0, max_daily_output_tokens: 0,
    permissions_valid: true, allowed_models: [], created_at: '2026-08-13T00:00:00.000Z',
  };
  const mutation = deferred();
  const token = 'rotated-<token>';
  const harness = createDashboardHarness({
    storedKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/users') return response([user]);
      if (route === '/admin/users/11/rotate-token' && options.method === 'POST') return mutation.promise;
      return undefined;
    },
  });
  await settle();
  const oldRotate = findButton(harness.usersContent, 'Rotate token');

  oldRotate.dispatchEvent(new Event('click'));
  assert.equal(harness.confirmDialog.open, true);
  assert.match(harness.confirmMessage.textContent, /rotation-user/u);
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/users/11/rotate-token' && options.method === 'POST').length, 1);
  assert.equal(harness.confirmSubmit.disabled, true);

  mutation.resolve(response({ apiToken: token }));
  await settle();

  const newRotate = findButton(harness.usersContent, 'Rotate token');
  assert.equal(harness.confirmDialog.open, false);
  assert.equal(harness.userDialog.open, true);
  assert.equal(harness.userForm.classList.contains('hidden'), true);
  assert.equal(harness.userTokenResult.classList.contains('hidden'), false);
  assert.equal(harness.userTokenValue.textContent, token);
  assert.equal(harness.userTokenValue.children.length, 0);
  assert.equal(harness.status.textContent.includes(token), false);
  assert.equal([...harness.sessionValues.values()].includes(token), false);
  assert.notEqual(newRotate, oldRotate);

  harness.userTokenClose.dispatchEvent(new Event('click'));
  assert.equal(harness.userDialog.open, false);
  assert.equal(harness.userTokenValue.textContent, '');
  assert.equal(oldRotate.focusCount, 0);
  assert.equal(newRotate.focusCount, 1);
  assert.equal(harness.confirmCount, 0);
});
