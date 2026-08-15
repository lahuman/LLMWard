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


  removeAttribute(name) {
    this.attributes.delete(name);
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

function errorResponse(status, error) {
  return { ok: false, status, json: async () => ({ error }) };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createDashboardHarness({
  loginKey = '',
  initialSessionValues = [],
  fetchOverride,
  confirmResult = false,
  clipboardWrite,
} = {}) {
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
  const statsForm = new FakeForm({ range: '7d', start: '', end: '' });
  const requests = [];
  const clipboardWrites = [];
  const sessionValues = new Map(initialSessionValues);
  const storageCalls = [];
  let bootstrapLoginPending = Boolean(loginKey);
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
    querySelectorAll: (selector) => {
      if (selector === 'nav [data-tab]') return navButtons;
      if (selector === '[data-overview-target]') return overviewNodes;
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
  const sectionNames = ['overview', 'users', 'models', 'providers', 'filters', 'stats'];
  const tabs = {};
  const navButtons = sectionNames.map((name) => {
    const item = register('tab-button-' + name);
    item.type = 'button';
    item.dataset.tab = name;
    item.setAttribute('aria-controls', 'tab-' + name);
    tabs[name] = register('tab-' + name);
    return item;
  });
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
  for (const id of [
    'overview-users-count', 'overview-policies-count', 'overview-models-count', 'overview-providers-count',
    'overview-stats-content', 'overview-providers-content', 'overview-activity-content',
    'stats-content', 'usage-content', 'model-stats-content', 'provider-stats-content', 'request-content',
  ]) register(id);
  register('section-title');

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
    'model-discovery', 'model-discovery-list',
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
      if (route === '/admin/filters/built-in-pii') return response({ id: 'built-in-pii', name: 'Built-in Korean PII & Secret Filter', is_active: builtInPiiActive, is_global: true, rules: builtInPiiRules });
      if (route === '/admin/models') return response([]);
      if (route === '/admin/providers') return response([]);
      if (route === '/admin/filters') return response([]);
      if (route === '/admin/onboarding') return response({ complete: true, steps: [], example: '' });
      if (route === '/admin/provider-presets') return response([]);
      if (route.startsWith('/admin/stats?')) return response(dashboardStats());
      throw new Error(`Unexpected route: ${route}`);
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
  context.window.prompt = () => { promptCount += 1; throw new Error('Resource flows must not call window.prompt'); };
  context.window.confirm = () => { confirmCount += 1; return confirmResult; };
  context.window.addEventListener = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.js'), 'utf8'), context);
  if (loginKey) {
    document.getElementById('admin-key').value = loginKey;
    loginForm.dispatchEvent(new Event('submit', { cancelable: true }));
  }
  return {
    adminKey: document.getElementById('admin-key'),
    loginForm,
    login: document.getElementById('login'),
    dashboard: document.getElementById('dashboard'),
    signOut: document.getElementById('sign-out'),
    navButtons,
    overviewNodes,
    sectionTitle: document.getElementById('section-title'),
    tabs,
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
    modelsContent: document.getElementById('models-content'),
    providersContent: document.getElementById('providers-content'),
    filtersContent: document.getElementById('filters-content'),
    overviewUsersCount: document.getElementById('overview-users-count'),
    overviewPoliciesCount: document.getElementById('overview-policies-count'),
    overviewModelsCount: document.getElementById('overview-models-count'),
    overviewProvidersCount: document.getElementById('overview-providers-count'),
    overviewProvidersContent: document.getElementById('overview-providers-content'),
    overviewStatsContent: document.getElementById('overview-stats-content'),
    overviewActivityContent: document.getElementById('overview-activity-content'),
    statsForm,
    statsContent: document.getElementById('stats-content'),
    usageContent: document.getElementById('usage-content'),
    modelStatsContent: document.getElementById('model-stats-content'),
    providerStatsContent: document.getElementById('provider-stats-content'),
    requestContent: document.getElementById('request-content'),
    createUser: document.getElementById('create-user'),
    createModel: document.getElementById('create-model'),
    createProvider: document.getElementById('create-provider'),
    userDialog: document.getElementById('user-dialog'),
    modelDialog: document.getElementById('model-dialog'),
    providerDialog: document.getElementById('provider-dialog'),
    confirmDialog: document.getElementById('confirm-dialog'),
    userCancel: document.getElementById('user-cancel'),
    confirmCancel: document.getElementById('confirm-cancel'),
    modelCancel: document.getElementById('model-cancel'),
    providerCancel: document.getElementById('provider-cancel'),
    userTokenResult: document.getElementById('user-token-result'),
    userTokenValue: document.getElementById('user-token-value'),
    userTokenCopy: document.getElementById('user-token-copy'),
    userTokenClose: document.getElementById('user-token-close'),
    userSubmit: document.getElementById('user-submit'),
    userDialogStatus: document.getElementById('user-dialog-status'),
    modelSubmit: document.getElementById('model-submit'),
    modelDialogStatus: document.getElementById('model-dialog-status'),
    modelDiscovery: document.getElementById('model-discovery'),
    modelDiscoveryList: document.getElementById('model-discovery-list'),
    providerSubmit: document.getElementById('provider-submit'),
    providerDialogStatus: document.getElementById('provider-dialog-status'),
    providerPresetField: document.getElementById('provider-preset-field'),
    providerEnvField: document.getElementById('provider-env-field'),
    confirmForm: document.getElementById('confirm-form'),
    confirmSubmit: document.getElementById('confirm-submit'),
    confirmMessage: document.getElementById('confirm-message'),
    confirmDialogStatus: document.getElementById('confirm-dialog-status'),
    clipboardWrites,
    storageCalls,
    sessionValues,
    get confirmCount() { return confirmCount; },
    get promptCount() { return promptCount; },
    window: context.window,
  };
}

function collectText(node) {
  return [node.textContent, ...node.children.flatMap(collectText)].filter(Boolean);
}
function findNodes(node, predicate) {
  const matches = predicate(node) ? [node] : [];
  for (const child of node.children) matches.push(...findNodes(child, predicate));
  return matches;
}

function findButton(node, label) {
  if (node.type === 'button' && node.textContent === label) return node;
  for (const child of node.children) {
    const match = findButton(child, label);
    if (match) return match;
  }
  return null;
}

function findButtons(node, label) {
  const matches = [];
  if (node.type === 'button' && node.textContent === label) matches.push(node);
  for (const child of node.children) matches.push(...findButtons(child, label));
  return matches;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function dashboardModel(overrides = {}) {
  return {
    id: 31,
    model_name: 'model-a',
    display_name: 'Model A',
    provider_id: 7,
    provider_name: 'provider-a',
    max_tokens: 4096,
    context_window: null,
    input_cost_per_million: null,
    output_cost_per_million: null,
    default_temperature: null,
    default_top_p: null,
    default_presence_penalty: null,
    default_frequency_penalty: null,
    default_seed: null,
    is_active: true,
    ...overrides,
  };
}

function dashboardProvider(overrides = {}) {
  return {
    id: 7,
    provider_name: 'provider-a',
    display_name: 'Provider A',
    base_url: 'https://provider.example/v1',
    auth_type: 'none',
    hasApiKey: false,
    health_status: 'unknown',
    last_health_check: null,
    is_active: true,
    ...overrides,
  };
}

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
function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../gu).map((channel) => parseInt(channel, 16) / 255);
    const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test('Signal Grid stylesheet preserves the approved visual and privacy contracts', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.js'), 'utf8');
  const tokens = {
    '--surface-root': '#080b0f',
    '--surface-page': '#0e1319',
    '--surface-panel': '#111821',
    '--border': '#596777',
    '--text': '#e7ecf2',
    '--text-muted': '#96a2b1',
    '--accent': '#ffb454',
    '--on-accent': '#241406',
    '--success': '#58d597',
    '--danger': '#f17c74',
    '--on-danger': '#210b0a',
    '--info': '#78a9ff',
  };
  for (const [name, value] of Object.entries(tokens)) {
    assert.match(css, new RegExp(`${name}:\\s*${value}`));
  }
  assert.match(css, /color-scheme:\s*dark/u);
  assert.match(css, /button,\s*input,\s*select,\s*textarea\s*\{[^}]*min-height:\s*36px/su);
  assert.match(css, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--accent\);\s*outline-offset:\s*2px;\s*\}/u);
  assert.match(css, /\.app-shell\s*\{[^}]*grid-template-columns:\s*176px minmax\(0,\s*1fr\)/su);
  assert.match(css, /\.workspace\s*\{[^}]*min-width:\s*0/su);
  assert.match(css, /\.provider-snapshot li > \*\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere/su);
  assert.match(css, /\.table-wrap\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto/su);
  assert.match(script, /wrap\.tabIndex\s*=\s*0;/u);
  assert.match(css, /@media\s*\(max-width:\s*839px\)\s*\{[\s\S]*?\.app-shell\s*\{[^}]*display:\s*block[\s\S]*?\.rail-nav\s*\{[^}]*overflow-x:\s*auto[\s\S]*?\.gateway-path\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
  assert.match(css, /@media\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\.grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?transition-duration:\s*\.01ms !important;/u);
  assert.doesNotMatch(css, /url\s*\(/iu);
  for (const copy of [
    'cannot be retrieved again',
    'it is not general DLP',
    'stored in plaintext in SQLite and backups',
    'do not enter secrets, prompts, or response examples',
  ]) {
    assert.ok(html.includes(copy));
  }
});

test('Signal Grid approved color pairs meet their contrast targets', () => {
  assert.ok(contrastRatio('#e7ecf2', '#0e1319') >= 4.5);
  assert.ok(contrastRatio('#96a2b1', '#111821') >= 4.5);
  assert.ok(contrastRatio('#ffb454', '#080b0f') >= 3);
  assert.ok(contrastRatio('#596777', '#111821') >= 3);
});

test('filters tab keeps the built-in PII filter before its sibling usage guide', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');
  assert.match(html, /<section id="tab-filters"[^>]*>\s*<section id="built-in-pii-filter"[\s\S]*?<\/section>\s*<section id="filter-usage-guide"/);
});
test('Signal Grid shell labels the six ordered native navigation sections', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');
  const nav = html.match(/<nav class="rail-nav"[\s\S]*?<\/nav>/u);
  assert.ok(nav);
  assert.deepEqual([...nav[0].matchAll(/<button[^>]*data-tab="[^"]+"[^>]*>([^<]+)<\/button>/gu)].map((match) => match[1]), ['Overview', 'Users', 'Models', 'Providers', 'Filters', 'Usage']);
  for (const name of ['overview', 'users', 'models', 'providers', 'filters', 'stats']) {
    assert.match(nav[0], new RegExp(`<button id="tab-button-${name}"[^>]*aria-controls="tab-${name}"`));
    assert.match(html, new RegExp(`<section id="tab-${name}"[^>]*aria-labelledby="tab-button-${name}"`));
  }
  assert.match(nav[0], /id="tab-button-overview"[^>]*aria-current="page"/);
  assert.deepEqual([...nav[0].matchAll(/<button id="([^"]+)"[^>]*aria-current="page"/gu)].map((match) => match[1]), ['tab-button-overview']);
  assert.doesNotMatch(nav[0], /aria-selected/);
  assert.match(html, /<section id="tab-overview"[\s\S]*?<section id="onboarding"[\s\S]*?<div id="overview-stats-content"/);
  assert.equal((html.match(/<span class="gateway-arrow" aria-hidden="true">→<\/span>/gu) || []).length, 3);
});

test('Signal Grid navigation selects Filters after authentication', async () => {
  const harness = createDashboardHarness({ loginKey: 'admin-key' });
  await settle();
  assert.equal(harness.tabs.overview.classList.contains('hidden'), false);
  assert.equal(harness.navButtons.filter((item) => item.getAttribute('aria-current') === 'page').map((item) => item.dataset.tab).join(','), 'overview');
  harness.navButtons.find((item) => item.dataset.tab === 'filters').dispatchEvent(new Event('click'));
  assert.equal(harness.navButtons.filter((item) => item.getAttribute('aria-current') === 'page').map((item) => item.dataset.tab).join(','), 'filters');
  assert.equal(harness.sectionTitle.textContent, 'Filters');
  assert.equal(harness.tabs.filters.classList.contains('hidden'), false);
  assert.equal(harness.tabs.overview.classList.contains('hidden'), true);
});
test('Gateway overview derives effective resources and transfers focus to Models', async () => {
  const harness = createDashboardHarness({
    loginKey: 'admin-key',
    fetchOverride(route) {
      if (route === '/admin/users') return response([
        { username: 'usable', is_active: true, permissions_valid: true },
        { username: 'invalid', is_active: true, permissions_valid: false },
        { username: 'inactive', is_active: false, permissions_valid: true },
      ]);
      if (route === '/admin/providers') return response([
        dashboardProvider({ id: 11, provider_name: 'active-one', display_name: 'Active one', health_status: 'Healthy', last_health_latency_ms: 14, last_health_check: '2026-08-15T01:00:00.000Z', base_url: 'https://provider.example/credential', stored_api_key: 'provider-secret' }),
        dashboardProvider({ id: 12, provider_name: 'active-two', display_name: 'Active two' }),
        dashboardProvider({ id: 13, provider_name: 'inactive', display_name: 'Inactive', is_active: false, base_url: 'https://inactive.example/private' }),
      ]);
      if (route === '/admin/models') return response([
        dashboardModel({ id: 101, provider_id: 11 }),
        dashboardModel({ id: 102, provider_id: 12, is_active: false }),
        dashboardModel({ id: 103, provider_id: 13 }),
      ]);
      if (route === '/admin/filters') return response([
        { name: 'global', patterns: [], is_active: true, is_global: true, model_ids: [] },
        { name: 'available', patterns: [], is_active: true, is_global: false, model_ids: [101] },
        { name: 'inactive', patterns: [], is_active: false, is_global: true, model_ids: [] },
        { name: 'empty', patterns: [], is_active: true, is_global: false, model_ids: [] },
        { name: 'unavailable', patterns: [], is_active: true, is_global: false, model_ids: [102, 103] },
      ]);
      if (route === '/admin/filters/built-in-pii') return response({ id: 'built-in-pii', is_active: true, rules: [] });
      return undefined;
    },
  });
  await settle();

  assert.equal(harness.overviewUsersCount.textContent, '1');
  assert.equal(harness.overviewPoliciesCount.textContent, '3');
  assert.equal(harness.overviewModelsCount.textContent, '1');
  assert.equal(harness.overviewProvidersCount.textContent, '2');
  assert.equal(harness.overviewProvidersContent.children[0].tagName, 'UL');
  assert.equal(collectText(harness.overviewProvidersContent).includes('provider-secret'), false);
  assert.equal(collectText(harness.overviewProvidersContent).includes('https://provider.example/credential'), false);

  const modelsNav = harness.navButtons.find((item) => item.dataset.tab === 'models');
  harness.overviewNodes.find((item) => item.dataset.overviewTarget === 'models').dispatchEvent(new Event('click'));
  assert.equal(harness.navButtons.filter((item) => item.getAttribute('aria-current') === 'page').map((item) => item.dataset.tab).join(','), 'models');
  assert.equal(harness.tabs.models.classList.contains('hidden'), false);
  assert.equal(modelsNav.focusCount, 1);
});

test('initial seven-day statistics are shared by Overview and Usage', async () => {
  const harness = createDashboardHarness({
    loginKey: 'admin-key',
    fetchOverride(route) {
      if (route === '/admin/stats?range=7d') {
        return response(dashboardStats({ summary: { total_requests: 10, successful_requests: 9 } }));
      }
      return undefined;
    },
  });
  await settle();

  const statisticsUrls = () => harness.requests
    .filter(({ route }) => route.startsWith('/admin/stats?'))
    .map(({ route }) => route);
  assert.deepEqual(statisticsUrls(), ['/admin/stats?range=7d']);
  assert.equal(collectText(harness.overviewStatsContent).includes('90.0%'), true);
  harness.navButtons.find((item) => item.dataset.tab === 'stats').dispatchEvent(new Event('click'));
  assert.deepEqual(statisticsUrls(), ['/admin/stats?range=7d']);
  assert.equal(collectText(harness.statsContent).includes('10'), true);
});

test('Overview uses explicit zero-request and unconfigured-cost states', async () => {
  const harness = createDashboardHarness({ loginKey: 'admin-key' });
  await settle();

  const text = collectText(harness.overviewStatsContent);
  assert.equal(text.filter((value) => value === 'No requests').length, 2);
  assert.equal(text.includes('Not configured'), true);
  assert.equal(text.includes('0.0%'), false);
  assert.equal(text.includes('0 ms'), false);
});

test('failed initial statistics stay local and Overview retry is deduplicated', async () => {
  const retry = deferred();
  let statsRequests = 0;
  const harness = createDashboardHarness({
    loginKey: 'admin-key',
    fetchOverride(route) {
      if (route === '/admin/users') return response([{ username: 'usable', is_active: true, permissions_valid: true }]);
      if (route === '/admin/stats?range=7d') {
        statsRequests += 1;
        return statsRequests === 1 ? errorResponse(500, 'statistics offline') : retry.promise;
      }
      return undefined;
    },
  });
  await settle();

  assert.equal(harness.dashboard.classList.contains('hidden'), false);
  assert.equal(harness.overviewUsersCount.textContent, '1');
  assert.equal(collectText(harness.overviewStatsContent).includes('statistics offline'), true);
  assert.equal(collectText(harness.statsContent).includes('statistics offline'), true);
  const usersNav = harness.navButtons.find((item) => item.dataset.tab === 'users');
  const overviewNav = harness.navButtons.find((item) => item.dataset.tab === 'overview');
  usersNav.dispatchEvent(new Event('click'));
  overviewNav.dispatchEvent(new Event('click'));
  overviewNav.dispatchEvent(new Event('click'));
  await settle();
  assert.equal(statsRequests, 2);
  assert.equal(harness.status.classList.contains('hidden'), true);

  retry.resolve(response(dashboardStats({ summary: { total_requests: 12, successful_requests: 12 } })));
  await settle();
  assert.equal(collectText(harness.overviewStatsContent).includes('statistics offline'), false);
  assert.equal(collectText(harness.overviewStatsContent).includes('100.0%'), true);
  assert.equal(collectText(harness.statsContent).includes('12'), true);
});

test('Usage Apply owns its range before fetching and seven-day retry cannot overwrite it', async () => {
  const applied = deferred();
  let sevenDayRequests = 0;
  const harness = createDashboardHarness({
    loginKey: 'admin-key',
    fetchOverride(route) {
      if (route === '/admin/stats?range=7d') {
        sevenDayRequests += 1;
        if (sevenDayRequests === 1) return errorResponse(500, 'initial statistics failed');
        return response(dashboardStats({ summary: { total_requests: 7, successful_requests: 7 } }));
      }
      if (route === '/admin/stats?range=30d') return applied.promise;
      return undefined;
    },
  });
  await settle();

  harness.navButtons.find((item) => item.dataset.tab === 'stats').dispatchEvent(new Event('click'));
  harness.statsForm.values.range = '30d';
  harness.statsForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.navButtons.find((item) => item.dataset.tab === 'overview').dispatchEvent(new Event('click'));
  await settle();
  assert.equal(collectText(harness.overviewStatsContent).includes('7'), true);
  assert.equal(collectText(harness.statsContent).includes('7'), false);
  assert.equal(collectText(harness.statsContent).includes('initial statistics failed'), true);
  assert.equal(harness.status.classList.contains('hidden'), true);

  applied.resolve(response(dashboardStats({ summary: { total_requests: 30, successful_requests: 30 } })));
  await settle();
  assert.equal(collectText(harness.statsContent).includes('30'), true);
  assert.equal(collectText(harness.statsContent).includes('7'), false);
  assert.deepEqual(
    harness.requests.filter(({ route }) => route.startsWith('/admin/stats?')).map(({ route }) => route),
    ['/admin/stats?range=7d', '/admin/stats?range=30d', '/admin/stats?range=7d'],
  );
});

test('Usage non-authentication failures stay local and preserve Overview', async () => {
  const harness = createDashboardHarness({
    loginKey: 'admin-key',
    fetchOverride(route) {
      if (route === '/admin/stats?range=7d') {
        return response(dashboardStats({ summary: { total_requests: 5, successful_requests: 5 } }));
      }
      if (route === '/admin/stats?range=30d') return errorResponse(500, 'range unavailable');
      return undefined;
    },
  });
  await settle();

  harness.statsForm.values.range = '30d';
  harness.statsForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(collectText(harness.overviewStatsContent).includes('5'), true);
  for (const panel of [harness.statsContent, harness.usageContent, harness.modelStatsContent, harness.providerStatsContent, harness.requestContent]) {
    assert.equal(collectText(panel).includes('range unavailable'), true);
  }
  assert.equal(harness.dashboard.classList.contains('hidden'), false);
  assert.equal(harness.status.classList.contains('hidden'), true);
});

test('Overview recent activity is limited to five metadata-only rows', async () => {
  const secrets = {
    prompt: 'secret-prompt',
    response: 'secret-response',
    provider_error_body: 'secret-provider-error',
    stored_api_key: 'secret-provider-key',
    admin_key: 'secret-admin-key',
    token: 'secret-user-token',
    patterns: ['secret-pattern'],
    base_url: 'https://secret-provider.example/private',
  };
  const recentRequests = Array.from({ length: 6 }, (_, index) => ({
    created_at: `2026-08-15T01:0${index}:00.000Z`,
    username: index === 5 ? 'sixth-user' : `user-${index + 1}`,
    user_id: index + 1,
    model_name: `model-${index + 1}`,
    provider_id: 7,
    status: 'success',
    error_type: null,
    input_tokens: index + 1,
    output_tokens: index + 2,
    response_time_ms: index + 3,
    estimated_cost_usd: 0,
    cost_configured: true,
    ...secrets,
  }));
  const harness = createDashboardHarness({
    loginKey: 'admin-key',
    fetchOverride(route) {
      if (route === '/admin/stats?range=7d') return response(dashboardStats({ recent_requests: recentRequests }));
      return undefined;
    },
  });
  await settle();

  const bodies = findNodes(harness.overviewActivityContent, (item) => item.tagName === 'TBODY');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].children.length, 5);
  const text = collectText(harness.overviewActivityContent);
  assert.equal(text.includes('sixth-user'), false);
  for (const secret of Object.values(secrets).flat()) assert.equal(text.includes(secret), false);
});

test('initial statistics 401 follows the central fail-closed login path', async () => {
  const delayedConfiguration = deferred();
  const harness = createDashboardHarness({
    loginKey: 'admin-key',
    fetchOverride(route) {
      if (route === '/admin/providers') return delayedConfiguration.promise;
      if (route === '/admin/stats?range=7d') return errorResponse(401, 'expired admin key');
      return undefined;
    },
  });
  await settle();
  delayedConfiguration.resolve(response([]));
  await settle();

  assert.equal(harness.login.classList.contains('hidden'), false);
  assert.equal(harness.dashboard.classList.contains('hidden'), true);
  assert.equal(harness.status.textContent, 'Authentication failed. The admin key was cleared.');
  assert.equal(harness.status.className, 'status error');
  assert.deepEqual(collectText(harness.overviewStatsContent), []);
  assert.deepEqual(collectText(harness.statsContent), []);
});

test('Usage Apply 403 follows the central fail-closed login path', async () => {
  const harness = createDashboardHarness({
    loginKey: 'admin-key',
    fetchOverride(route) {
      if (route === '/admin/stats?range=30d') return errorResponse(403, 'forbidden');
      return undefined;
    },
  });
  await settle();

  harness.statsForm.values.range = '30d';
  harness.statsForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.login.classList.contains('hidden'), false);
  assert.equal(harness.dashboard.classList.contains('hidden'), true);
  assert.equal(harness.status.textContent, 'Authentication failed. The admin key was cleared.');
  assert.deepEqual(collectText(harness.overviewStatsContent), []);
  assert.deepEqual(collectText(harness.statsContent), []);
});

test('late seven-day success after sign-out cannot restore cleared statistics', async () => {
  const oldStatistics = deferred();
  const harness = createDashboardHarness({
    loginKey: 'old-admin-key',
    fetchOverride(route) {
      if (route === '/admin/stats?range=7d') return oldStatistics.promise;
      return undefined;
    },
  });
  await settle();
  harness.signOut.dispatchEvent(new Event('click'));
  oldStatistics.resolve(response(dashboardStats({ summary: { total_requests: 99, successful_requests: 99 } })));
  await settle();

  assert.equal(harness.login.classList.contains('hidden'), false);
  assert.deepEqual(collectText(harness.overviewStatsContent), []);
  assert.deepEqual(collectText(harness.statsContent), []);
});

test('late non-authentication failure from an old key cannot overwrite a new session', async () => {
  const oldStatistics = deferred();
  const harness = createDashboardHarness({
    loginKey: 'old-admin-key',
    fetchOverride(route, options) {
      if (route !== '/admin/stats?range=7d') return undefined;
      if (options.headers['X-Admin-Key'] === 'old-admin-key') return oldStatistics.promise;
      return response(dashboardStats({ summary: { total_requests: 22, successful_requests: 22 } }));
    },
  });
  await settle();
  harness.signOut.dispatchEvent(new Event('click'));
  harness.adminKey.value = 'new-admin-key';
  harness.loginForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  oldStatistics.resolve(errorResponse(500, 'stale statistics failure'));
  await settle();

  assert.equal(harness.dashboard.classList.contains('hidden'), false);
  assert.equal(collectText(harness.overviewStatsContent).includes('22'), true);
  assert.equal(collectText(harness.overviewStatsContent).includes('stale statistics failure'), false);
  assert.equal(collectText(harness.statsContent).includes('22'), true);
});

test('late Usage Apply success after sign-out cannot restore cleared statistics', async () => {
  const applied = deferred();
  const harness = createDashboardHarness({
    loginKey: 'admin-key',
    fetchOverride(route) {
      if (route === '/admin/stats?range=30d') return applied.promise;
      return undefined;
    },
  });
  await settle();

  harness.statsForm.values.range = '30d';
  harness.statsForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.signOut.dispatchEvent(new Event('click'));
  applied.resolve(response(dashboardStats({ summary: { total_requests: 44, successful_requests: 44 } })));
  await settle();

  assert.equal(harness.login.classList.contains('hidden'), false);
  assert.deepEqual(collectText(harness.overviewStatsContent), []);
  assert.deepEqual(collectText(harness.statsContent), []);
});

test('Overview retry 401 keeps the central fail-closed status', async () => {
  let sevenDayRequests = 0;
  const harness = createDashboardHarness({
    loginKey: 'admin-key',
    fetchOverride(route) {
      if (route !== '/admin/stats?range=7d') return undefined;
      sevenDayRequests += 1;
      return sevenDayRequests === 1
        ? errorResponse(500, 'statistics offline')
        : errorResponse(401, 'expired during retry');
    },
  });
  await settle();

  harness.navButtons.find((item) => item.dataset.tab === 'overview').dispatchEvent(new Event('click'));
  await settle();
  assert.equal(harness.login.classList.contains('hidden'), false);
  assert.equal(harness.dashboard.classList.contains('hidden'), true);
  assert.equal(harness.status.textContent, 'Authentication failed. The admin key was cleared.');
  assert.deepEqual(collectText(harness.overviewStatsContent), []);
  assert.deepEqual(collectText(harness.statsContent), []);
});

test('late seven-day success cannot overwrite a same-key relogin', async () => {
  const oldStatistics = deferred();
  let sevenDayRequests = 0;
  const harness = createDashboardHarness({
    loginKey: 'same-admin-key',
    fetchOverride(route) {
      if (route !== '/admin/stats?range=7d') return undefined;
      sevenDayRequests += 1;
      if (sevenDayRequests === 1) return oldStatistics.promise;
      return response(dashboardStats({ summary: { total_requests: 22, successful_requests: 22 } }));
    },
  });
  await settle();
  harness.signOut.dispatchEvent(new Event('click'));
  harness.adminKey.value = 'same-admin-key';
  harness.loginForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  oldStatistics.resolve(response(dashboardStats({ summary: { total_requests: 99, successful_requests: 99 } })));
  await settle();

  assert.equal(collectText(harness.overviewStatsContent).includes('22'), true);
  assert.equal(collectText(harness.overviewStatsContent).includes('99'), false);
  assert.equal(collectText(harness.statsContent).includes('22'), true);
});

test('late Usage Apply success cannot overwrite a same-key relogin', async () => {
  const oldAppliedRange = deferred();
  let sevenDayRequests = 0;
  const harness = createDashboardHarness({
    loginKey: 'same-admin-key',
    fetchOverride(route) {
      if (route === '/admin/stats?range=30d') return oldAppliedRange.promise;
      if (route !== '/admin/stats?range=7d') return undefined;
      sevenDayRequests += 1;
      return response(dashboardStats({
        summary: {
          total_requests: sevenDayRequests === 1 ? 5 : 22,
          successful_requests: sevenDayRequests === 1 ? 5 : 22,
        },
      }));
    },
  });
  await settle();
  harness.statsForm.values.range = '30d';
  harness.statsForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.signOut.dispatchEvent(new Event('click'));
  harness.adminKey.value = 'same-admin-key';
  harness.loginForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  oldAppliedRange.resolve(response(dashboardStats({ summary: { total_requests: 44, successful_requests: 44 } })));
  await settle();

  assert.equal(collectText(harness.overviewStatsContent).includes('22'), true);
  assert.equal(collectText(harness.statsContent).includes('22'), true);
  assert.equal(collectText(harness.statsContent).includes('44'), false);
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


test('provider create presets populate the modal and successful submit reloads configuration only', async () => {
  const mutation = deferred();
  const preset = { id: 'openai-compatible', name: 'OpenAI compatible', base_url: 'https://api.example/v1' };
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/provider-presets') return response([preset]);
      if (route === '/admin/providers' && options.method === 'POST') return mutation.promise;
      return undefined;
    },
  });
  await settle();
  const requestStart = harness.requests.length;
  harness.providerForm.elements.providerName.value = 'stale-provider';
  harness.providerForm.elements.storedKey.value = 'stale-secret';
  harness.createProvider.dispatchEvent(new Event('click'));
  assert.equal(harness.providerDialog.open, true);
  assert.equal(harness.providerForm.elements.providerId.value, '');
  assert.equal(harness.providerForm.elements.providerName.value, '');
  assert.equal(harness.providerForm.elements.storedKey.value, '');
  assert.equal(harness.providerPresetField.classList.contains('hidden'), false);
  assert.equal(harness.providerForm.elements.preset.disabled, false);
  assert.equal(harness.providerEnvField.classList.contains('hidden'), false);
  assert.equal(harness.providerForm.elements.envName.disabled, false);
  harness.providerForm.elements.preset.value = preset.id;
  harness.providerForm.elements.preset.dispatchEvent(new Event('change'));
  assert.equal(harness.providerForm.elements.providerName.value, preset.id);
  assert.equal(harness.providerForm.elements.displayName.value, preset.name);
  assert.equal(harness.providerForm.elements.baseUrl.value, preset.base_url);
  harness.providerForm.elements.authType.value = 'api_key';
  harness.providerForm.elements.envName.value = 'PROVIDER_API_KEY';
  harness.providerForm.elements.storedKey.value = 'created-secret';
  harness.providerForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.providerForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  const posts = harness.requests.filter(({ route, options }) => route === '/admin/providers' && options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].options.body), {
    provider_name: 'openai-compatible', display_name: 'OpenAI compatible',
    base_url: 'https://api.example/v1', auth_type: 'api_key',
    api_key_env_name: 'PROVIDER_API_KEY', stored_api_key: 'created-secret',
  });
  assert.equal(harness.providerSubmit.disabled, true);
  assert.equal(harness.providerCancel.disabled, true);
  harness.providerCancel.dispatchEvent(new Event('click'));
  harness.providerDialog.cancel();
  harness.createProvider.dispatchEvent(new Event('click'));
  assert.equal(harness.providerDialog.open, true);
  assert.equal(harness.providerDialog.showModalCount, 1);
  mutation.resolve(response(dashboardProvider()));
  await settle();
  assert.equal(harness.providerDialog.open, false);
  assert.equal(harness.providerForm.elements.storedKey.value, '');
  assert.equal(harness.status.textContent, 'Created successfully.');
  assert.equal(harness.status.className, 'status success');
  const reloadRoutes = harness.requests.slice(requestStart)
    .filter(({ options }) => !options.method).map(({ route }) => route);
  assert.deepEqual(reloadRoutes.sort(), [
    '/admin/filters', '/admin/filters/built-in-pii', '/admin/models', '/admin/onboarding',
    '/admin/provider-presets', '/admin/providers', '/admin/users',
  ].sort());
  assert.equal(reloadRoutes.some((route) => route.startsWith('/admin/stats?')), false);
  assert.equal(harness.confirmCount, 0);
  assert.equal(harness.promptCount, 0);
});

test('provider edit never prefills or exposes credentials', async () => {
  const provider = dashboardProvider({ hasApiKey: true, stored_api_key: 'must-not-be-visible', api_key_env_name: 'SECRET_ENV_NAME' });
  const harness = createDashboardHarness({ loginKey: 'stored-admin-key', fetchOverride(route) {
    if (route === '/admin/providers') return response([provider]);
    return undefined;
  }});
  await settle();
  assert.equal(collectText(harness.providersContent).includes('Configured'), true);
  assert.equal(collectText(harness.providersContent).includes('must-not-be-visible'), false);
  assert.equal(collectText(harness.providersContent).includes('SECRET_ENV_NAME'), false);
  findButton(harness.providersContent, 'Edit').dispatchEvent(new Event('click'));
  assert.equal(harness.providerDialog.open, true);
  assert.equal(harness.providerForm.elements.providerId.value, '7');
  assert.equal(harness.providerForm.elements.providerName.value, 'provider-a');
  assert.equal(harness.providerForm.elements.displayName.value, 'Provider A');
  assert.equal(harness.providerForm.elements.baseUrl.value, 'https://provider.example/v1');
  assert.equal(harness.providerForm.elements.authType.value, 'none');
  assert.equal(harness.providerPresetField.classList.contains('hidden'), true);
  assert.equal(harness.providerForm.elements.preset.disabled, true);
  assert.equal(harness.providerEnvField.classList.contains('hidden'), true);
  assert.equal(harness.providerForm.elements.envName.disabled, true);
  assert.equal(harness.providerForm.elements.envName.value, '');
  assert.equal(harness.providerForm.elements.storedKey.value, '');
  assert.equal(harness.providerForm.elements.removeStoredKey.checked, false);
  assert.equal(harness.providerForm.elements.providerName.focusCount, 1);
  assert.equal(harness.promptCount, 0);
});

test('provider edit distinguishes unchanged replacement and explicit credential removal', async () => {
  async function submitCredential(configure) {
    const provider = dashboardProvider({ hasApiKey: true });
    const harness = createDashboardHarness({ loginKey: 'stored-admin-key', fetchOverride(route, options) {
      if (route === '/admin/providers') return response([provider]);
      if (route === '/admin/providers/7' && options.method === 'PUT') return response(provider);
      return undefined;
    }});
    await settle();
    findButton(harness.providersContent, 'Edit').dispatchEvent(new Event('click'));
    configure(harness);
    harness.providerForm.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const updates = harness.requests.filter(({ route, options }) => route === '/admin/providers/7' && options.method === 'PUT');
    assert.equal(updates.length, 1);
    assert.equal(harness.providerDialog.open, false);
    assert.equal(harness.providerForm.elements.storedKey.value, '');
    assert.equal(harness.confirmCount, 0);
    assert.equal(harness.promptCount, 0);
    return JSON.parse(updates[0].options.body);
  }
  const unchangedBody = await submitCredential(() => {});
  const replacementBody = await submitCredential((harness) => {
    harness.providerForm.elements.storedKey.value = 'new-secret';
  });
  const removalBody = await submitCredential((harness) => {
    harness.providerForm.elements.removeStoredKey.checked = true;
    harness.providerForm.elements.removeStoredKey.dispatchEvent(new Event('change'));
  });
  assert.equal(Object.hasOwn(unchangedBody, 'stored_api_key'), false);
  assert.equal(replacementBody.stored_api_key, 'new-secret');
  assert.equal(removalBody.stored_api_key, null);
  for (const body of [unchangedBody, replacementBody, removalBody]) {
    assert.equal(Object.hasOwn(body, 'api_key_env_name'), false);
  }
});

test('provider credential controls are mutually exclusive and clear on close', async () => {
  const harness = createDashboardHarness({ loginKey: 'stored-admin-key', fetchOverride(route) {
    if (route === '/admin/providers') return response([dashboardProvider({ hasApiKey: true })]);
    return undefined;
  }});
  await settle();
  const edit = findButton(harness.providersContent, 'Edit');
  edit.dispatchEvent(new Event('click'));
  const password = harness.providerForm.elements.storedKey;
  const remove = harness.providerForm.elements.removeStoredKey;
  password.value = 'replacement-to-clear';
  remove.checked = true;
  remove.dispatchEvent(new Event('change'));
  assert.equal(password.value, '');
  assert.equal(password.disabled, true);
  remove.checked = false;
  remove.dispatchEvent(new Event('change'));
  assert.equal(password.disabled, false);
  remove.checked = true;
  password.value = 'replacement-wins';
  password.dispatchEvent(new Event('input'));
  assert.equal(remove.checked, false);
  assert.equal(password.disabled, false);
  harness.providerCancel.dispatchEvent(new Event('click'));
  assert.equal(harness.providerDialog.open, false);
  assert.equal(password.value, '');
  assert.equal(password.disabled, false);
  assert.equal(remove.checked, false);
  assert.equal(harness.createProvider.focusCount, 0);
  assert.equal(edit.focusCount, 1);
});

test('provider mutation errors stay local and preserve the replacement credential', async () => {
  const mutation = deferred();
  const error = '<script>Provider validation failed</script>';
  const harness = createDashboardHarness({ loginKey: 'stored-admin-key', fetchOverride(route, options) {
    if (route === '/admin/providers') return response([dashboardProvider({ hasApiKey: true })]);
    if (route === '/admin/providers/7' && options.method === 'PUT') return mutation.promise;
    return undefined;
  }});
  await settle();
  const edit = findButton(harness.providersContent, 'Edit');
  edit.dispatchEvent(new Event('click'));
  harness.providerForm.elements.storedKey.value = 'retry-this-secret';
  harness.providerForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.providerForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/providers/7' && options.method === 'PUT').length, 1);
  assert.equal(harness.providerSubmit.disabled, true);
  assert.equal(harness.providerCancel.disabled, true);
  harness.providerCancel.dispatchEvent(new Event('click'));
  harness.providerDialog.cancel();
  edit.dispatchEvent(new Event('click'));
  assert.equal(harness.providerDialog.open, true);
  assert.equal(harness.providerDialog.showModalCount, 1);
  mutation.resolve({ ok: false, status: 400, json: async () => ({ error }) });
  await settle();
  assert.equal(harness.providerDialog.open, true);
  assert.equal(harness.providerForm.elements.storedKey.value, 'retry-this-secret');
  assert.equal(harness.providerSubmit.disabled, false);
  assert.equal(harness.providerCancel.disabled, false);
  assert.equal(harness.providerDialogStatus.textContent, error);
  assert.equal(harness.providerDialogStatus.children.length, 0);
  assert.equal(harness.status.textContent.includes(error), false);
  harness.providerCancel.dispatchEvent(new Event('click'));
  assert.equal(harness.providerForm.elements.storedKey.value, '');
  assert.equal(edit.focusCount, 1);
});

test('provider deactivation and hard deletion use named confirmation', async () => {
  const active = dashboardProvider({ id: 61, provider_name: 'active-provider' });
  const inactive = dashboardProvider({ id: 62, provider_name: 'inactive-provider', is_active: false });
  let deleted = false;
  const harness = createDashboardHarness({ loginKey: 'stored-admin-key', fetchOverride(route, options) {
    if (route === '/admin/providers' && !options.method) return response(deleted ? [inactive] : [active, inactive]);
    if (route === '/admin/providers/61' && options.method === 'PUT') return response({ ...active, is_active: false });
    if (route === '/admin/providers/62' && options.method === 'PUT') return response({ ...inactive, is_active: true });
    if (route === '/admin/providers/61' && options.method === 'DELETE') {
      deleted = true;
      return response({});
    }
    return undefined;
  }});
  await settle();
  findButton(harness.providersContent, 'Deactivate').dispatchEvent(new Event('click'));
  assert.equal(harness.confirmDialog.open, true);
  assert.match(harness.confirmMessage.textContent, /active-provider/u);
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  const deactivations = harness.requests.filter(({ route, options }) => route === '/admin/providers/61' && options.method === 'PUT');
  assert.equal(deactivations.length, 1);
  assert.deepEqual(JSON.parse(deactivations[0].options.body), { is_active: false });
  const confirmOpenCount = harness.confirmDialog.showModalCount;
  findButton(harness.providersContent, 'Activate').dispatchEvent(new Event('click'));
  await settle();
  const activations = harness.requests.filter(({ route, options }) => route === '/admin/providers/62' && options.method === 'PUT');
  assert.deepEqual(activations.map(({ options }) => JSON.parse(options.body)), [{ is_active: true }]);
  assert.equal(harness.confirmDialog.showModalCount, confirmOpenCount);
  findButton(harness.providersContent, 'Delete').dispatchEvent(new Event('click'));
  assert.equal(harness.confirmDialog.open, true);
  assert.match(harness.confirmMessage.textContent, /active-provider/u);
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/providers/61' && options.method === 'DELETE').length, 1);
  assert.equal(harness.createProvider.focusCount, 1);
  assert.equal(harness.confirmCount, 0);
  assert.equal(harness.promptCount, 0);
});

test('provider delete guards keep the confirmation open with the server error', async () => {
  const provider = dashboardProvider({ id: 71, provider_name: 'attached-<provider>' });
  const error = '<script>Cannot delete a provider with attached models</script>';
  const harness = createDashboardHarness({ loginKey: 'stored-admin-key', fetchOverride(route, options) {
    if (route === '/admin/providers') return response([provider]);
    if (route === '/admin/providers/71' && options.method === 'DELETE') {
      return { ok: false, status: 400, json: async () => ({ error }) };
    }
    return undefined;
  }});
  await settle();
  const originalTable = harness.providersContent.children[0];
  findButton(harness.providersContent, 'Delete').dispatchEvent(new Event('click'));
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/providers/71' && options.method === 'DELETE').length, 1);
  assert.equal(harness.confirmDialog.open, true);
  assert.equal(harness.confirmSubmit.disabled, false);
  assert.equal(harness.confirmDialogStatus.textContent, error);
  assert.equal(harness.confirmDialogStatus.children.length, 0);
  assert.equal(harness.providersContent.children[0], originalTable);
  assert.equal(harness.requests.some(({ route }) => route.startsWith('/admin/models/')), false);
  assert.equal(harness.confirmCount, 0);
  assert.equal(harness.promptCount, 0);
});

test('resource management functions contain no browser prompts or confirms', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.js'), 'utf8');
  const resourceFunctions = script.slice(script.indexOf('function renderUsers'), script.indexOf('function filterScope'));
  assert.doesNotMatch(resourceFunctions, /window\.(?:prompt|confirm)\s*\(/u);
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


test('user create submits once and shows a one-time token until explicitly closed', async () => {
  const mutation = deferred();
  const token = 'created-<token>';
  let userLoads = 0;
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
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
    loginKey: 'stored-admin-key',
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
    loginKey: 'stored-admin-key',
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
    loginKey: 'stored-admin-key',
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
    loginKey: 'stored-admin-key',
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
    loginKey: 'stored-admin-key',
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

test('pending token rotation refresh isolates every resource dialog entry point', async () => {
  const user = {
    id: 28, username: 'isolated-rotation-user', is_active: true,
    max_daily_input_tokens: 0, max_daily_output_tokens: 0,
    permissions_valid: true, allowed_models: [], created_at: '2026-08-13T00:00:00.000Z',
  };
  const refresh = deferred();
  const mutation = deferred();
  const token = 'isolated-rotation-token';
  let userLoads = 0;
  let discoveryRequests = 0;
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/users' && !options.method) {
        userLoads += 1;
        return userLoads === 1 ? response([user]) : refresh.promise;
      }
      if (route === '/admin/models') return response([dashboardModel()]);
      if (route === '/admin/providers') return response([dashboardProvider()]);
      if (route === '/admin/users/28/rotate-token' && options.method === 'POST') return mutation.promise;
      if (route === '/admin/providers/7/discover-models') {
        discoveryRequests += 1;
        return response([{ model_name: 'must-not-open' }]);
      }
      return undefined;
    },
  });
  await settle();
  const oldRotate = findButton(harness.usersContent, 'Rotate token');
  const discover = findButton(harness.providersContent, 'Discover models');

  oldRotate.dispatchEvent(new Event('click'));
  harness.userForm.elements.username.value = 'preserve-confirm-user-form';
  harness.modelForm.elements.modelName.value = 'preserve-confirm-model-form';
  harness.providerForm.elements.providerName.value = 'preserve-confirm-provider-form';
  discover.dispatchEvent(new Event('click'));
  harness.createUser.dispatchEvent(new Event('click'));
  harness.createModel.dispatchEvent(new Event('click'));
  harness.createProvider.dispatchEvent(new Event('click'));
  await settle();
  assert.equal(harness.confirmDialog.open, true);
  assert.equal(discoveryRequests, 0);
  assert.equal(harness.userDialog.showModalCount, 0);
  assert.equal(harness.modelDialog.showModalCount, 0);
  assert.equal(harness.providerDialog.showModalCount, 0);
  assert.equal(harness.userForm.elements.username.value, 'preserve-confirm-user-form');
  assert.equal(harness.modelForm.elements.modelName.value, 'preserve-confirm-model-form');
  assert.equal(harness.providerForm.elements.providerName.value, 'preserve-confirm-provider-form');

  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  mutation.resolve(response({ apiToken: token }));
  await settle();

  assert.equal(harness.confirmDialog.open, false);
  assert.equal(harness.userDialog.open, false);
  assert.equal(harness.userTokenValue.textContent, '');
  harness.userForm.elements.username.value = 'preserve-user-form';
  harness.modelForm.elements.modelName.value = 'preserve-model-form';
  harness.providerForm.elements.providerName.value = 'preserve-provider-form';

  discover.dispatchEvent(new Event('click'));
  harness.createUser.dispatchEvent(new Event('click'));
  harness.createModel.dispatchEvent(new Event('click'));
  harness.createProvider.dispatchEvent(new Event('click'));
  await settle();

  assert.equal(discoveryRequests, 0);
  assert.equal(harness.userDialog.showModalCount, 0);
  assert.equal(harness.modelDialog.showModalCount, 0);
  assert.equal(harness.providerDialog.showModalCount, 0);
  assert.equal(harness.userDialog.open, false);
  assert.equal(harness.modelDialog.open, false);
  assert.equal(harness.providerDialog.open, false);
  assert.equal(harness.userForm.elements.username.value, 'preserve-user-form');
  assert.equal(harness.modelForm.elements.modelName.value, 'preserve-model-form');
  assert.equal(harness.providerForm.elements.providerName.value, 'preserve-provider-form');
  assert.equal(harness.userTokenValue.textContent, '');

  refresh.resolve(response([user]));
  await settle();

  const newRotate = findButton(harness.usersContent, 'Rotate token');
  assert.notEqual(newRotate, oldRotate);
  assert.equal(harness.userDialog.showModalCount, 1);
  assert.equal(harness.userDialog.open, true);
  assert.equal(harness.modelDialog.showModalCount, 0);
  assert.equal(harness.providerDialog.showModalCount, 0);
  assert.equal(harness.userTokenResult.classList.contains('hidden'), false);
  assert.equal(harness.userTokenValue.textContent, token);
  assert.equal(harness.userTokenCopy.focusCount, 1);

  harness.userTokenClose.dispatchEvent(new Event('click'));
  assert.equal(harness.userDialog.open, false);
  assert.equal(harness.userTokenValue.textContent, '');
  assert.equal(oldRotate.focusCount, 0);
  assert.equal(newRotate.focusCount, 1);
  assert.equal(harness.userForm.elements.username.value, 'preserve-user-form');
  assert.equal(harness.modelForm.elements.modelName.value, 'preserve-model-form');
  assert.equal(harness.providerForm.elements.providerName.value, 'preserve-provider-form');
});

test('pending user creation cannot be canceled reopened or submitted twice', async () => {
  const mutation = deferred();
  const token = 'only-valid-created-token';
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/users' && options.method === 'POST') return mutation.promise;
      return undefined;
    },
  });
  await settle();

  harness.createUser.dispatchEvent(new Event('click'));
  harness.userForm.elements.username.value = 'pending-user';
  harness.userForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.userSubmit.disabled, true);
  assert.equal(harness.userCancel.disabled, true);

  harness.userCancel.dispatchEvent(new Event('click'));
  assert.equal(harness.userDialog.open, true);
  harness.userDialog.cancel();
  assert.equal(harness.userDialog.open, true);
  harness.createUser.dispatchEvent(new Event('click'));
  harness.userForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/users' && options.method === 'POST').length, 1);

  mutation.resolve(response({ apiToken: token }));
  await settle();

  assert.equal(harness.userDialog.open, true);
  assert.equal(harness.userTokenValue.textContent, token);
  assert.equal(harness.userTokenResult.classList.contains('hidden'), false);
  assert.equal(harness.userTokenClose.disabled, false);
});

test('pending token rotation cannot be canceled reopened or submitted twice', async () => {
  const user = {
    id: 27, username: 'pending-rotation-user', is_active: true,
    max_daily_input_tokens: 0, max_daily_output_tokens: 0,
    permissions_valid: true, allowed_models: [], created_at: '2026-08-13T00:00:00.000Z',
  };
  const mutation = deferred();
  const token = 'only-valid-rotated-token';
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/users') return response([user]);
      if (route === '/admin/users/27/rotate-token' && options.method === 'POST') return mutation.promise;
      return undefined;
    },
  });
  await settle();
  const rotate = findButton(harness.usersContent, 'Rotate token');

  rotate.dispatchEvent(new Event('click'));
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.confirmSubmit.disabled, true);
  assert.equal(harness.confirmCancel.disabled, true);

  harness.confirmCancel.dispatchEvent(new Event('click'));
  assert.equal(harness.confirmDialog.open, true);
  harness.confirmDialog.cancel();
  assert.equal(harness.confirmDialog.open, true);
  rotate.dispatchEvent(new Event('click'));
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.confirmDialog.showModalCount, 1);
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/users/27/rotate-token' && options.method === 'POST').length, 1);

  mutation.resolve(response({ apiToken: token }));
  await settle();

  assert.equal(harness.confirmDialog.open, false);
  assert.equal(harness.userDialog.open, true);
  assert.equal(harness.userDialog.showModalCount, 1);
  assert.equal(harness.userTokenValue.textContent, token);
  assert.equal(harness.userTokenResult.classList.contains('hidden'), false);
});

test('token copy success feedback stays visible and announceable in result mode', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');
  const dialog = html.slice(html.indexOf('<dialog id="user-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="user-dialog"')));
  const formEnd = dialog.indexOf('</form>');
  const statusPosition = dialog.indexOf('id="user-dialog-status"');
  assert.ok(statusPosition > formEnd);
  assert.match(dialog, /id="user-dialog-status"[^>]*role="status"[^>]*aria-live="polite"/u);

  const token = 'copy-success-token';
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/users' && options.method === 'POST') return response({ apiToken: token });
      return undefined;
    },
  });
  await settle();
  harness.createUser.dispatchEvent(new Event('click'));
  harness.userForm.elements.username.value = 'copy-user';
  harness.userForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.userForm.classList.contains('hidden'), true);
  assert.equal(harness.userTokenResult.classList.contains('hidden'), false);

  harness.userTokenCopy.dispatchEvent(new Event('click'));
  await settle();

  assert.deepEqual(harness.clipboardWrites, [token]);
  assert.equal(harness.userDialogStatus.textContent, 'Token copied.');
  assert.equal(harness.userDialogStatus.className, 'status success');
  assert.equal(harness.userDialogStatus.children.length, 0);
});

test('token copy rejection feedback stays visible and announceable in result mode', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');
  const dialog = html.slice(html.indexOf('<dialog id="user-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="user-dialog"')));
  const formEnd = dialog.indexOf('</form>');
  const statusPosition = dialog.indexOf('id="user-dialog-status"');
  assert.ok(statusPosition > formEnd);
  assert.match(dialog, /id="user-dialog-status"[^>]*role="status"[^>]*aria-live="polite"/u);
  const token = 'copy-failure-token';
  const clipboardError = '<script>Clipboard denied</script>';
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    clipboardWrite: async () => { throw new Error(clipboardError); },
    fetchOverride(route, options) {
      if (route === '/admin/users' && options.method === 'POST') return response({ apiToken: token });
      return undefined;
    },
  });
  await settle();
  harness.createUser.dispatchEvent(new Event('click'));
  harness.userForm.elements.username.value = 'copy-failure-user';
  harness.userForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  harness.userTokenCopy.dispatchEvent(new Event('click'));
  await settle();

  assert.equal(harness.userForm.classList.contains('hidden'), true);
  assert.equal(harness.userTokenResult.classList.contains('hidden'), false);
  assert.equal(harness.userTokenValue.textContent, token);
  assert.equal(harness.userDialogStatus.textContent, clipboardError);
  assert.equal(harness.userDialogStatus.className, 'status error');
  assert.equal(harness.userDialogStatus.children.length, 0);
  assert.equal(harness.status.textContent.includes(clipboardError), false);
});

test('model dialog exposes typed advanced defaults without arbitrary JSON', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');
  const start = html.indexOf('<dialog id="model-dialog"');
  const dialog = html.slice(start, html.indexOf('</dialog>', start));
  assert.match(dialog, /Context window \(tokens\)[\s\S]*name="contextWindow"[^>]*min="1"[^>]*max="9007199254740991"[^>]*step="1"/u);
  assert.match(dialog, /does not reconfigure the provider/u);
  assert.match(dialog, /<details id="model-advanced">\s*<summary>Advanced generation defaults<\/summary>/u);
  for (const field of ['defaultTemperature', 'defaultTopP', 'defaultPresencePenalty', 'defaultFrequencyPenalty', 'defaultSeed']) {
    assert.match(dialog, new RegExp(`name="${field}"`));
  }
  assert.doesNotMatch(dialog, /model_config|arbitrary JSON|num_ctx|max_model_len|n_ctx|provider runtime option/iu);
});

test('model table distinguishes Max output and Context', async () => {
  const configured = dashboardModel({ context_window: 8192 });
  const unknown = dashboardModel({ id: 32, model_name: 'model-b', display_name: 'Model B' });
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route) {
      if (route === '/admin/models') return response([configured, unknown]);
      if (route === '/admin/providers') return response([dashboardProvider()]);
      return undefined;
    },
  });
  await settle();
  const texts = collectText(harness.modelsContent);
  assert.ok(texts.includes('Max output'));
  assert.ok(texts.includes('Context'));
  assert.ok(texts.includes('8,192'));
  assert.ok(texts.includes('Not configured'));
  assert.equal(texts.includes('Max tokens'), false);

  const wrappers = findNodes(harness.modelsContent, (node) => node.classList.contains('table-wrap'));
  assert.equal(wrappers.length, 1);
  assert.equal(wrappers[0].tabIndex, 0);
  assert.equal(wrappers[0].getAttribute('role'), 'region');
  assert.equal(wrappers[0].getAttribute('aria-label'), 'Models');
  const captions = findNodes(wrappers[0], (node) => node.tagName === 'CAPTION');
  assert.deepEqual(captions.map((caption) => caption.textContent), ['Models']);
  assert.ok(findNodes(wrappers[0], (node) => node.tagName === 'TH').every((cell) => cell.getAttribute('scope') === 'col'));
});

test('filter table states describe active scope and unassigned filters in text', async () => {
  const filters = [
    { id: 1, name: 'global', patterns: ['one'], input_action: 'block', output_action: null, is_active: true, is_global: true, model_ids: [], updated_at: '2026-08-15T00:00:00.000Z' },
    { id: 2, name: 'scoped', patterns: ['two'], input_action: 'mask', output_action: null, is_active: true, is_global: false, model_ids: [31, 32], updated_at: '2026-08-15T00:00:00.000Z' },
    { id: 3, name: 'inactive', patterns: ['three'], input_action: null, output_action: 'mask', is_active: false, is_global: false, model_ids: [31], updated_at: '2026-08-15T00:00:00.000Z' },
    { id: 4, name: 'unassigned', patterns: ['four'], input_action: null, output_action: null, is_active: true, is_global: false, model_ids: [], updated_at: '2026-08-15T00:00:00.000Z' },
  ];
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route) {
      if (route === '/admin/filters') return response(filters);
      return undefined;
    },
  });
  await settle();

  assert.deepEqual(findNodes(harness.filtersContent, (node) => node.classList.contains('badge')).map((badge) => badge.textContent), [
    'Active globally', 'Active for 2 models', 'Inactive', 'Active but no models assigned',
  ]);
});

test('model create serializes blank defaults as null and preserves numeric zero', async () => {
  const mutation = deferred();
  const harness = createDashboardHarness({
    fetchOverride(route, options) {
      if (route === '/admin/models' && options.method === 'POST') return mutation.promise;
      return undefined;
    },
  });
  harness.createModel.dispatchEvent(new Event('click'));
  Object.assign(harness.modelForm.elements.modelName, { value: 'typed-model' });
  Object.assign(harness.modelForm.elements.displayName, { value: 'Typed Model' });
  Object.assign(harness.modelForm.elements.providerId, { value: '7' });
  Object.assign(harness.modelForm.elements.maxTokens, { value: '512' });
  Object.assign(harness.modelForm.elements.inputPrice, { value: '1.25' });
  Object.assign(harness.modelForm.elements.outputPrice, { value: '' });
  Object.assign(harness.modelForm.elements.contextWindow, { value: '' });
  Object.assign(harness.modelForm.elements.defaultTemperature, { value: '0' });
  Object.assign(harness.modelForm.elements.defaultTopP, { value: '' });
  Object.assign(harness.modelForm.elements.defaultPresencePenalty, { value: '-2' });
  Object.assign(harness.modelForm.elements.defaultFrequencyPenalty, { value: '0' });
  Object.assign(harness.modelForm.elements.defaultSeed, { value: '0' });
  harness.modelForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.modelForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();

  const posts = harness.requests.filter(({ route, options }) => route === '/admin/models' && options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].options.body), {
    model_name: 'typed-model',
    display_name: 'Typed Model',
    provider_id: 7,
    max_tokens: 512,
    input_cost_per_million: 1.25,
    output_cost_per_million: null,
    context_window: null,
    default_temperature: 0,
    default_top_p: null,
    default_presence_penalty: -2,
    default_frequency_penalty: 0,
    default_seed: 0,
  });
  assert.equal(harness.modelSubmit.disabled, true);
  mutation.resolve(response(dashboardModel({ model_name: 'typed-model' })));
  await settle();
  assert.equal(harness.modelDialog.open, false);
});

test('model edit populates all fields and explicit blanks clear defaults', async () => {
  const model = dashboardModel({
    max_tokens: 2048,
    context_window: 8192,
    input_cost_per_million: 1.5,
    output_cost_per_million: 2.5,
    default_temperature: 0,
    default_top_p: 0.75,
    default_presence_penalty: -1.5,
    default_frequency_penalty: 1.25,
    default_seed: 0,
  });
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/models') return response([model]);
      if (route === '/admin/providers') return response([dashboardProvider()]);
      if (route === '/admin/models/31' && options.method === 'PUT') return response(model);
      return undefined;
    },
  });
  await settle();
  findButton(harness.modelsContent, 'Edit').dispatchEvent(new Event('click'));
  assert.equal(harness.modelForm.elements.modelId.value, '31');
  assert.equal(harness.modelForm.elements.modelName.value, 'model-a');
  assert.equal(harness.modelForm.elements.displayName.value, 'Model A');
  assert.equal(harness.modelForm.elements.providerId.value, '7');
  assert.equal(harness.modelForm.elements.maxTokens.value, '2048');
  assert.equal(harness.modelForm.elements.inputPrice.value, '1.5');
  assert.equal(harness.modelForm.elements.outputPrice.value, '2.5');
  assert.equal(harness.modelForm.elements.contextWindow.value, '8192');
  assert.equal(harness.modelForm.elements.defaultTemperature.value, '0');
  assert.equal(harness.modelForm.elements.defaultTopP.value, '0.75');
  assert.equal(harness.modelForm.elements.defaultPresencePenalty.value, '-1.5');
  assert.equal(harness.modelForm.elements.defaultFrequencyPenalty.value, '1.25');
  assert.equal(harness.modelForm.elements.defaultSeed.value, '0');
  for (const name of ['contextWindow', 'defaultTemperature', 'defaultTopP', 'defaultPresencePenalty', 'defaultFrequencyPenalty', 'defaultSeed']) {
    harness.modelForm.elements[name].value = '';
  }
  harness.modelForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  const puts = harness.requests.filter(({ route, options }) => route === '/admin/models/31' && options.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.deepEqual(JSON.parse(puts[0].options.body), {
    model_name: 'model-a',
    display_name: 'Model A',
    provider_id: 7,
    max_tokens: 2048,
    input_cost_per_million: 1.5,
    output_cost_per_million: 2.5,
    context_window: null,
    default_temperature: null,
    default_top_p: null,
    default_presence_penalty: null,
    default_frequency_penalty: null,
    default_seed: null,
  });
});

test('model validation errors stay local and a refresh failure cannot repeat a successful update', async () => {
  const model = dashboardModel();
  let modelLoads = 0;
  let puts = 0;
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/models' && !options.method) {
        modelLoads += 1;
        if (modelLoads === 1) return response([model]);
        return { ok: false, status: 500, json: async () => ({ error: 'Model refresh failed.' }) };
      }
      if (route === '/admin/providers') return response([dashboardProvider()]);
      if (route === '/admin/models' && options.method === 'POST') {
        return { ok: false, status: 400, json: async () => ({ error: 'max_tokens must not exceed context_window' }) };
      }
      if (route === '/admin/models/31' && options.method === 'PUT') {
        puts += 1;
        return response(model);
      }
      return undefined;
    },
  });
  await settle();
  harness.createModel.dispatchEvent(new Event('click'));
  harness.modelForm.elements.modelName.value = 'invalid-capacity';
  harness.modelForm.elements.displayName.value = 'Invalid Capacity';
  harness.modelForm.elements.providerId.value = '7';
  harness.modelForm.elements.maxTokens.value = '512';
  harness.modelForm.elements.contextWindow.value = '128';
  harness.modelForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.modelDialog.open, true);
  assert.equal(harness.modelForm.elements.contextWindow.value, '128');
  assert.equal(harness.modelDialogStatus.textContent, 'max_tokens must not exceed context_window');
  assert.equal(harness.modelDialogStatus.children.length, 0);
  assert.equal(harness.modelSubmit.disabled, false);

  harness.modelCancel.dispatchEvent(new Event('click'));
  const oldEdit = findButton(harness.modelsContent, 'Edit');
  oldEdit.dispatchEvent(new Event('click'));
  harness.modelForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.modelForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(puts, 1);
  assert.equal(harness.modelDialog.open, false);
  assert.equal(harness.status.textContent, 'Model refresh failed.');
  assert.equal(harness.status.className, 'status error');
  assert.equal(oldEdit.focusCount, 1);
  harness.modelForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(puts, 1);
});

test('discover models opens locked create mode and accepts only returned identifiers', async () => {
  const provider = dashboardProvider();
  const discovered = [{ model_name: '<img src=x onerror=1>' }, { model_name: 'safe-model' }];
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/providers') return response([provider]);
      if (route === '/admin/providers/7/discover-models') return response(discovered);
      if (route === '/admin/models' && options.method === 'POST') return response(dashboardModel({ model_name: 'safe-model' }));
      return undefined;
    },
  });
  await settle();
  findButton(harness.providersContent, 'Discover models').dispatchEvent(new Event('click'));
  await settle();
  assert.equal(harness.modelDialog.open, true);
  assert.equal(harness.modelForm.elements.providerId.value, '7');
  assert.equal(harness.modelForm.elements.providerId.disabled, true);
  assert.equal(harness.modelForm.elements.modelName.value, '<img src=x onerror=1>');
  assert.equal(harness.modelForm.elements.displayName.value, '<img src=x onerror=1>');
  assert.equal(harness.modelForm.elements.modelName.focusCount, 1);
  assert.deepEqual(harness.modelDiscoveryList.children.map((item) => item.tagName), ['LI', 'LI']);
  assert.equal(harness.modelDiscoveryList.children[0].textContent, '<img src=x onerror=1>');
  assert.equal(harness.modelDiscoveryList.children[0].children.length, 0);

  harness.modelForm.elements.modelName.value = 'not-discovered';
  harness.modelForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/models' && options.method === 'POST').length, 0);
  assert.equal(harness.modelDialog.open, true);
  assert.match(harness.modelDialogStatus.textContent, /discovered identifier/u);

  harness.modelForm.elements.modelName.value = 'safe-model';
  harness.modelForm.elements.displayName.value = 'Safe Model';
  harness.modelForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  const posts = harness.requests.filter(({ route, options }) => route === '/admin/models' && options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].options.body).provider_id, 7);
  assert.equal(harness.modelForm.elements.providerId.disabled, false);
  assert.equal(harness.modelDiscoveryList.children.length, 0);
  assert.equal(harness.modelDiscovery.classList.contains('hidden'), true);
  assert.equal(harness.promptCount, 0);
});

test('empty model discovery reports status without opening a dialog', async () => {
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route) {
      if (route === '/admin/providers') return response([dashboardProvider()]);
      if (route === '/admin/providers/7/discover-models') return response([]);
      return undefined;
    },
  });
  await settle();
  const openCount = harness.modelDialog.showModalCount;
  findButton(harness.providersContent, 'Discover models').dispatchEvent(new Event('click'));
  await settle();
  assert.equal(harness.modelDialog.showModalCount, openCount);
  assert.equal(harness.status.textContent, 'No unregistered models were found.');
  assert.equal(harness.status.className, 'status success');
  assert.equal(harness.promptCount, 0);
});

test('model deactivation and hard deletion use named confirmation', async () => {
  const active = dashboardModel({ id: 41, model_name: 'active-model' });
  const inactive = dashboardModel({ id: 42, model_name: 'inactive-model', is_active: false });
  let deleted = false;
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/models' && !options.method) return response(deleted ? [inactive] : [active, inactive]);
      if (route === '/admin/providers') return response([dashboardProvider()]);
      if (route === '/admin/models/41' && options.method === 'PUT') return response({ ...active, is_active: false });
      if (route === '/admin/models/42' && options.method === 'PUT') return response({ ...inactive, is_active: true });
      if (route === '/admin/models/41' && options.method === 'DELETE') {
        deleted = true;
        return response({});
      }
      return undefined;
    },
  });
  await settle();

  findButton(harness.modelsContent, 'Deactivate').dispatchEvent(new Event('click'));
  assert.equal(harness.confirmDialog.open, true);
  assert.match(harness.confirmMessage.textContent, /active-model/u);
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  const deactivations = harness.requests.filter(({ route, options }) => route === '/admin/models/41' && options.method === 'PUT');
  assert.deepEqual(deactivations.map(({ options }) => JSON.parse(options.body)), [{ is_active: false }]);

  const confirmCount = harness.confirmDialog.showModalCount;
  findButton(harness.modelsContent, 'Activate').dispatchEvent(new Event('click'));
  await settle();
  const activations = harness.requests.filter(({ route, options }) => route === '/admin/models/42' && options.method === 'PUT');
  assert.deepEqual(activations.map(({ options }) => JSON.parse(options.body)), [{ is_active: true }]);
  assert.equal(harness.confirmDialog.showModalCount, confirmCount);

  findButton(harness.modelsContent, 'Delete').dispatchEvent(new Event('click'));
  assert.equal(harness.confirmDialog.open, true);
  assert.match(harness.confirmMessage.textContent, /active-model/u);
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/models/41' && options.method === 'DELETE').length, 1);
  assert.equal(harness.createModel.focusCount, 1);
  assert.equal(harness.confirmCount, 0);
});

test('model delete guards keep the confirmation open with the server error', async () => {
  const model = dashboardModel({ id: 51, model_name: 'assigned-<model>' });
  const error = '<script>Model is assigned to users</script>';
  const harness = createDashboardHarness({
    loginKey: 'stored-admin-key',
    fetchOverride(route, options) {
      if (route === '/admin/models') return response([model]);
      if (route === '/admin/providers') return response([dashboardProvider()]);
      if (route === '/admin/models/51' && options.method === 'DELETE') {
        return { ok: false, status: 400, json: async () => ({ error }) };
      }
      return undefined;
    },
  });
  await settle();
  const originalTable = harness.modelsContent.children[0];
  findButton(harness.modelsContent, 'Delete').dispatchEvent(new Event('click'));
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  harness.confirmForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(harness.requests.filter(({ route, options }) => route === '/admin/models/51' && options.method === 'DELETE').length, 1);
  assert.equal(harness.confirmDialog.open, true);
  assert.equal(harness.confirmSubmit.disabled, false);
  assert.equal(harness.confirmDialogStatus.textContent, error);
  assert.equal(harness.confirmDialogStatus.children.length, 0);
  assert.equal(harness.modelsContent.children[0], originalTable);
  assert.equal(harness.confirmCount, 0);
});

test('stale discovery response cannot overwrite a normal model create dialog', async () => {
  const delayed = deferred();
  const harness = createDashboardHarness({ loginKey: 'stored-admin-key', fetchOverride(route) {
    if (route === '/admin/providers') return response([dashboardProvider()]);
    if (route === '/admin/providers/7/discover-models') return delayed.promise;
    return undefined;
  }});
  await settle();
  findButton(harness.providersContent, 'Discover models').dispatchEvent(new Event('click'));
  await settle();
  harness.createModel.dispatchEvent(new Event('click'));
  harness.modelForm.elements.modelName.value = 'normal-model';
  harness.modelForm.elements.displayName.value = 'Normal Model';
  harness.modelForm.elements.providerId.value = '19';
  const openCount = harness.modelDialog.showModalCount;
  delayed.resolve(response([{ model_name: 'stale-a' }]));
  await settle();
  assert.equal(harness.modelDialog.showModalCount, openCount);
  assert.equal(harness.modelForm.elements.modelName.value, 'normal-model');
  assert.equal(harness.modelForm.elements.displayName.value, 'Normal Model');
  assert.equal(harness.modelForm.elements.providerId.value, '19');
  assert.equal(harness.modelForm.elements.providerId.disabled, false);
  assert.equal(harness.modelDiscoveryList.children.length, 0);
});

test('out-of-order model discovery applies only the latest provider response', async () => {
  const delayedA = deferred(), delayedB = deferred();
  const providerA = dashboardProvider(), providerB = dashboardProvider({ id: 8, provider_name: 'provider-b', display_name: 'Provider B' });
  const harness = createDashboardHarness({ loginKey: 'stored-admin-key', fetchOverride(route) {
    if (route === '/admin/providers') return response([providerA, providerB]);
    if (route === '/admin/providers/7/discover-models') return delayedA.promise;
    if (route === '/admin/providers/8/discover-models') return delayedB.promise;
    return undefined;
  }});
  await settle();
  const triggers = findButtons(harness.providersContent, 'Discover models');
  triggers[0].dispatchEvent(new Event('click'));
  triggers[1].dispatchEvent(new Event('click'));
  await settle();
  delayedB.resolve(response([{ model_name: 'provider-b-model' }]));
  await settle();
  const openCount = harness.modelDialog.showModalCount;
  delayedA.resolve(response([{ model_name: 'stale-a' }]));
  await settle();
  assert.equal(harness.modelDialog.showModalCount, openCount);
  assert.equal(harness.modelForm.elements.providerId.value, '8');
  assert.equal(harness.modelForm.elements.providerId.disabled, true);
  assert.equal(harness.modelForm.elements.modelName.value, 'provider-b-model');
  assert.deepEqual(harness.modelDiscoveryList.children.map((item) => item.textContent), ['provider-b-model']);
});

test('model discovery cancel and success restore the logical Discover models trigger', async () => {
  const provider = dashboardProvider();
  const cancelHarness = createDashboardHarness({ loginKey: 'stored-admin-key', fetchOverride(route) {
    if (route === '/admin/providers') return response([provider]);
    if (route === '/admin/providers/7/discover-models') return response([{ model_name: 'cancel-model' }]);
    return undefined;
  }});
  await settle();
  const cancelTrigger = findButton(cancelHarness.providersContent, 'Discover models');
  cancelTrigger.dispatchEvent(new Event('click'));
  await settle();
  cancelHarness.modelCancel.dispatchEvent(new Event('click'));
  assert.equal(cancelTrigger.focusCount, 1);
  assert.equal(cancelHarness.createModel.focusCount, 0);

  const successHarness = createDashboardHarness({ loginKey: 'stored-admin-key', fetchOverride(route, options) {
    if (route === '/admin/providers') return response([provider]);
    if (route === '/admin/providers/7/discover-models') return response([{ model_name: 'registered-model' }]);
    if (route === '/admin/models' && options.method === 'POST') return response(dashboardModel({ model_name: 'registered-model' }));
    return undefined;
  }});
  await settle();
  const oldTrigger = findButton(successHarness.providersContent, 'Discover models');
  oldTrigger.dispatchEvent(new Event('click'));
  await settle();
  successHarness.modelForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  const newTrigger = findButton(successHarness.providersContent, 'Discover models');
  assert.notEqual(newTrigger, oldTrigger);
  assert.equal(oldTrigger.focusCount, 0);
  assert.equal(newTrigger.focusCount, 1);
  assert.equal(successHarness.createModel.focusCount, 0);
});

test('model identifier is programmatically associated with discovery constraints', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');
  assert.match(html, /<input name="modelName"[^>]*aria-describedby="model-discovery-help"[^>]*aria-controls="model-discovery-list"/u);
  assert.match(html, /id="model-discovery-help"[^>]*>[^<]*Choose one of the discovered identifiers/u);
  assert.match(html, /<ul id="model-discovery-list"/u);
});
