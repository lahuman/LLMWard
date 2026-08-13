const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_SECRET_KEY = 'content-filter-tests-unique-key-2026';
process.env.LOG_LEVEL = 'silent';

const db = require('../db/database');

db.exec(`
  CREATE TABLE models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_name TEXT UNIQUE NOT NULL
  );
  CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    success INTEGER NOT NULL,
    changed_fields TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE content_filters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    patterns TEXT NOT NULL,
    input_action TEXT CHECK(input_action IS NULL OR input_action IN ('block', 'mask')),
    output_action TEXT CHECK(output_action IS NULL OR output_action = 'mask'),
    is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0, 1)),
    is_global INTEGER NOT NULL DEFAULT 0 CHECK(is_global IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(input_action IS NOT NULL OR output_action IS NOT NULL)
  );
  CREATE TABLE content_filter_models (
    filter_id INTEGER NOT NULL REFERENCES content_filters(id) ON DELETE CASCADE,
    model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    PRIMARY KEY(filter_id, model_id)
  );
`);

const {
  listFilters,
  createFilter,
  updateFilter,
  deleteFilter,
  getEffectiveFilterSnapshot,
  applyInputFilters,
  applyOutputFilters,
  assertRequestSize,
  createLiteralFilter,
  createMasker,
  maskText
} = require('../services/content-filters');

function insertModel(name) {
  return Number(db.prepare('INSERT INTO models (model_name) VALUES (?)').run(name).lastInsertRowid);
}

function apiError(fn, { status = 400, code } = {}) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, status);
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  });
}

function captureRegExpConstructions(work) {
  const NativeRegExp = global.RegExp;
  const flags = [];
  const constructions = [];
  global.RegExp = class CountingRegExp extends NativeRegExp {
    constructor(pattern, matcherFlags) {
      super(pattern, matcherFlags);
      flags.push(matcherFlags);
      constructions.push({ source: String(pattern), flags: matcherFlags });
    }
  };
  try {
    return { result: work(), flags, constructions };
  } finally {
    global.RegExp = NativeRegExp;
  }
}

function observeMapEvictions(work) {
  const nativeDelete = Map.prototype.delete;
  let deletions = 0;
  Map.prototype.delete = function observedDelete(key) {
    deletions += 1;
    if (deletions > 8) throw new Error('transition cache eviction churn');
    return nativeDelete.call(this, key);
  };
  try {
    return { result: work(), deletions };
  } finally {
    Map.prototype.delete = nativeDelete;
  }
}

beforeEach(() => {
  db.exec(`
    DELETE FROM content_filter_models;
    DELETE FROM content_filters;
    DELETE FROM models;
    DELETE FROM audit_logs;
    DELETE FROM app_settings;
    DELETE FROM sqlite_sequence;
  `);
});

after(() => db.close());

test('CRUD normalizes fields, applies safe defaults, replaces assignments, and audits field names only', () => {
  const firstModel = insertModel('first');
  const secondModel = insertModel('second');
  const created = createFilter({
    name: '  Organization PII  ',
    patterns: ['  literal one ', 'literal two'],
    input_action: 'block',
    output_action: 'mask',
    model_ids: [secondModel, firstModel]
  });

  assert.deepEqual(created, {
    id: 1,
    name: 'Organization PII',
    patterns: ['literal one', 'literal two'],
    input_action: 'block',
    output_action: 'mask',
    is_active: false,
    is_global: false,
    model_ids: [firstModel, secondModel],
    created_at: created.created_at,
    updated_at: created.updated_at
  });
  assert.equal(new Date(created.created_at).toISOString(), created.created_at);
  assert.deepEqual(listFilters(), [created]);
  assert.deepEqual(JSON.parse(db.prepare('SELECT changed_fields FROM audit_logs').pluck().get()), [
    'input_action', 'model_ids', 'name', 'output_action', 'patterns'
  ]);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM audit_logs').all()).includes('literal one'), false);

  const updated = updateFilter(created.id, {
    input_action: null,
    is_active: true,
    is_global: true,
    model_ids: [firstModel]
  });
  assert.deepEqual({
    input_action: updated.input_action,
    output_action: updated.output_action,
    is_active: updated.is_active,
    is_global: updated.is_global,
    model_ids: updated.model_ids
  }, {
    input_action: null,
    output_action: 'mask',
    is_active: true,
    is_global: true,
    model_ids: []
  });
  assert.equal(db.prepare('SELECT COUNT(*) FROM content_filter_models').pluck().get(), 0);
  assert.deepEqual(JSON.parse(db.prepare("SELECT changed_fields FROM audit_logs WHERE action = 'filter.update'").pluck().get()), [
    'input_action', 'is_active', 'is_global', 'model_ids'
  ]);

  deleteFilter(created.id);
  assert.deepEqual(listFilters(), []);
  assert.deepEqual(db.prepare('SELECT action, target_type, target_id, changed_fields FROM audit_logs ORDER BY id').all(), [
    {
      action: 'filter.create', target_type: 'filter', target_id: '1',
      changed_fields: '["input_action","model_ids","name","output_action","patterns"]'
    },
    {
      action: 'filter.update', target_type: 'filter', target_id: '1',
      changed_fields: '["input_action","is_active","is_global","model_ids"]'
    },
    { action: 'filter.delete', target_type: 'filter', target_id: '1', changed_fields: '[]' }
  ]);
});

test('validation rejects unknown fields, invalid values, duplicates, and unknown models without writes', () => {
  const modelId = insertModel('known');
  const valid = { name: 'valid', patterns: ['secret'], input_action: 'block' };
  const invalidInputs = [
    { value: { ...valid, extra: true } },
    { value: { ...valid, name: ' ' } },
    { value: { ...valid, name: 'x'.repeat(101) } },
    { value: { ...valid, patterns: [] } },
    { value: { ...valid, patterns: ['x'.repeat(257)] } },
    { value: { ...valid, patterns: ['line\nbreak'] } },
    { value: { ...valid, patterns: ['safe', 'SAFE'] } },
    { value: { ...valid, patterns: ['\nsecret'] } },
    { value: { ...valid, patterns: ['secret\t'] } },
    { value: { ...valid, patterns: ['line\u2028separator'] } },
    { value: { ...valid, patterns: ['paragraph\u2029separator'] } },
    { value: { ...valid, patterns: ['control\u0085character'] } },
    { value: { ...valid, input_action: 'allow' } },
    { value: { ...valid, input_action: null, output_action: null } },
    { value: { ...valid, output_action: 'block' } },
    { value: { ...valid, is_active: 1 } },
    { value: { ...valid, model_ids: '1' } },
    { value: { ...valid, model_ids: [modelId, modelId] } },
    { value: { ...valid, model_ids: [999] } }
  ];
  for (const { value } of invalidInputs) apiError(() => createFilter(value));
  assert.equal(db.prepare('SELECT COUNT(*) FROM content_filters').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM audit_logs').pluck().get(), 0);

  const created = createFilter(valid);
  apiError(() => updateFilter(created.id, {}));
  apiError(() => updateFilter(created.id, { id: 2 }));
  apiError(() => updateFilter(created.id, { patterns: ['s', '\u017f'] }));
  apiError(() => updateFilter(999, { name: 'missing' }), { status: 404 });
  apiError(() => deleteFilter(999), { status: 404 });
  assert.equal(listFilters()[0].name, 'valid');
  assert.equal(db.prepare('SELECT COUNT(*) FROM audit_logs').pluck().get(), 1);
});

test('the aggregate stored-pattern limit is enforced for create and partial update', () => {
  createFilter({
    name: 'large',
    patterns: Array.from({ length: 199 }, (_, index) => `pattern-${index}`),
    input_action: 'mask'
  });
  const small = createFilter({ name: 'small', patterns: ['last'], output_action: 'mask' });
  apiError(() => createFilter({ name: 'overflow', patterns: ['too-many'], input_action: 'block' }));
  apiError(() => updateFilter(small.id, { patterns: ['last', 'overflow'] }));
  assert.equal(listFilters().reduce((total, filter) => total + filter.patterns.length, 0), 200);
});

test('Unicode duplicate detection is symmetric and isolated between normalization calls', () => {
  const duplicatePairs = [
    ['s', '\u017f'],
    ['k', '\u212a'],
    ['\u03c3', '\u03c2']
  ];
  let attempt = 0;
  for (let repetition = 0; repetition < 2; repetition += 1) {
    for (const pair of duplicatePairs) {
      for (const patterns of [pair, [...pair].reverse()]) {
        apiError(() => createFilter({
          name: `unicode-duplicate-${attempt++}`,
          patterns,
          input_action: 'block'
        }));
      }
    }
  }

  const first = createFilter({
    name: 'call-isolation-first', patterns: ['\u212a'], input_action: 'block'
  });
  const second = createFilter({
    name: 'call-isolation-second', patterns: ['\u212a'], input_action: 'block'
  });
  assert.deepEqual(first.patterns, ['\u212a']);
  assert.deepEqual(second.patterns, ['\u212a']);
});

test('snapshot validation compiles one anchored Unicode matcher per pattern on every call', () => {
  const patterns = Array.from({ length: 200 }, (_, index) =>
    String(index).padStart(3, '0') + 'x'.repeat(253)
  );
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO content_filters
      (name, patterns, input_action, output_action, is_active, is_global, created_at, updated_at)
    VALUES ('matcher-count', ?, 'block', NULL, 1, 1, ?, ?)
  `).run(JSON.stringify(patterns), now, now);

  for (let call = 0; call < 2; call += 1) {
    const { result, constructions } = captureRegExpConstructions(
      () => getEffectiveFilterSnapshot(1)
    );
    const anchoredMatchers = constructions.filter(({ source, flags }) =>
      flags === 'iu' && source.startsWith('^(?:') && source.endsWith(')$')
    );

    assert.deepEqual(result.input_block_patterns, patterns);
    assert.equal(anchoredMatchers.length, patterns.length);
  }
});

test('filter, assignment, and success audit mutations roll back together', () => {
  const firstModel = insertModel('atomic-first');
  const secondModel = insertModel('atomic-second');
  const created = createFilter({
    name: 'atomic', patterns: ['one'], input_action: 'mask', model_ids: [firstModel]
  });
  const capture = (work) => {
    try { work(); } catch (error) { return error; }
    return null;
  };
  let updateFailure;
  let deleteFailure;
  let createFailure;
  let assignmentsAfterUpdate;
  let filterAfterDelete;
  let createdDuringFailure;
  db.exec('DROP TABLE audit_logs');
  try {
    updateFailure = capture(() => updateFilter(created.id, { model_ids: [secondModel] }));
    assignmentsAfterUpdate = db.prepare(`
      SELECT model_id FROM content_filter_models WHERE filter_id = ? ORDER BY model_id
    `).pluck().all(created.id);
    deleteFailure = capture(() => deleteFilter(created.id));
    filterAfterDelete = db.prepare('SELECT name FROM content_filters WHERE id = ?').pluck().get(created.id);
    createFailure = capture(() => createFilter({
      name: 'create-must-roll-back', patterns: ['two'], input_action: 'block', model_ids: [secondModel]
    }));
    createdDuringFailure = db.prepare(
      "SELECT COUNT(*) FROM content_filters WHERE name = 'create-must-roll-back'"
    ).pluck().get();
  } finally {
    db.exec(`
      CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        success INTEGER NOT NULL,
        changed_fields TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }
  assert.match(updateFailure.message, /no such table/i);
  assert.deepEqual(assignmentsAfterUpdate, [firstModel]);
  assert.match(deleteFailure.message, /no such table/i);
  assert.equal(filterAfterDelete, 'atomic');
  assert.match(createFailure.message, /no such table/i);
  assert.equal(createdDuringFailure, 0);
  assert.deepEqual(
    db.prepare('SELECT filter_id, model_id FROM content_filter_models').all(),
    [{ filter_id: created.id, model_id: firstModel }]
  );
});

test('effective snapshot keeps ordered immutable input-block policy metadata', () => {
  const requestedModel = insertModel('requested');
  const otherModel = insertModel('other');
  createFilter({
    name: 'Global input policy', patterns: ['global'], input_action: 'block',
    is_active: true, is_global: true
  });
  createFilter({
    name: 'Assigned input policy', patterns: ['assigned-block'], input_action: 'block',
    is_active: true, model_ids: [requestedModel]
  });
  createFilter({
    name: 'assigned-name-must-not-leak', patterns: ['assigned'], input_action: 'mask', output_action: 'mask',
    is_active: true, model_ids: [requestedModel]
  });
  createFilter({
    name: 'other', patterns: ['other-only'], input_action: 'mask', is_active: true, model_ids: [otherModel]
  });
  createFilter({
    name: 'unassigned', patterns: ['no-op'], input_action: 'mask', is_active: true
  });
  createFilter({
    name: 'inactive', patterns: ['inactive'], input_action: 'block', is_global: true
  });

  const snapshot = getEffectiveFilterSnapshot(requestedModel);
  assert.deepEqual(snapshot, {
    built_in_pii_filter_active: false,
    input_block_patterns: ['global', 'assigned-block'],
    input_mask_patterns: ['assigned'],
    output_mask_patterns: ['assigned'],
    input_block_policies: [
      { name: 'Global input policy', patterns: ['global'] },
      { name: 'Assigned input policy', patterns: ['assigned-block'] }
    ]
  });
  const serialized = JSON.stringify(snapshot);

  for (const privateValue of ['assigned-name-must-not-leak', 'other-only', 'no-op', 'inactive']) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.input_block_patterns), true);
  assert.equal(Object.isFrozen(snapshot.input_block_policies), true);
  assert.equal(Object.isFrozen(snapshot.input_block_policies[0]), true);
  assert.equal(Object.isFrozen(snapshot.input_block_policies[0].patterns), true);
});

test('built-in PII activation is a frozen fail-closed snapshot setting', () => {
  const modelId = insertModel('built-in-pii-setting');
  assert.equal(getEffectiveFilterSnapshot(modelId).built_in_pii_filter_active, false);
  db.prepare("INSERT INTO app_settings VALUES ('built_in_pii_filter_active', '0', ?)").run(new Date().toISOString());
  assert.equal(getEffectiveFilterSnapshot(modelId).built_in_pii_filter_active, false);
  db.prepare("UPDATE app_settings SET setting_value = '1' WHERE setting_key = 'built_in_pii_filter_active'").run();
  const active = getEffectiveFilterSnapshot(modelId);
  assert.equal(active.built_in_pii_filter_active, true);
  assert.equal(Object.isFrozen(active), true);
  for (const value of ['', 'true', '2', '01']) {
    db.prepare("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'built_in_pii_filter_active'").run(value);
    apiError(() => getEffectiveFilterSnapshot(modelId), { status: 500, code: 'filter_configuration_invalid' });
  }
  db.exec('DROP TABLE app_settings');
  try {
    assert.throws(() => getEffectiveFilterSnapshot(modelId), (error) => error.code === 'SQLITE_ERROR');
  } finally {
    db.exec('CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  }
});
test('stored configuration corruption fails closed with a fixed identifier-free error', () => {
  db.prepare(`
    INSERT INTO content_filters
      (name, patterns, input_action, is_active, is_global, created_at, updated_at)
    VALUES (?, ?, 'block', 1, 1, ?, ?)
  `).run('private-rule-name', '{private-pattern', new Date().toISOString(), new Date().toISOString());

  assert.throws(() => getEffectiveFilterSnapshot(1), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.code, 'filter_configuration_invalid');
    assert.equal(error.message, 'Content filter configuration is invalid');
    assert.equal(error.message.includes('private-rule-name'), false);
    assert.equal(error.message.includes('private-pattern'), false);
    return true;
  });
});

test('an active global filter with a stored model assignment is invalid configuration', () => {
  const modelId = insertModel('corrupt-global-assignment');
  const now = new Date().toISOString();
  const filterId = Number(db.prepare(`
    INSERT INTO content_filters
      (name, patterns, input_action, is_active, is_global, created_at, updated_at)
    VALUES ('corrupt-global', '["secret"]', 'block', 1, 1, ?, ?)
  `).run(now, now).lastInsertRowid);
  db.prepare('INSERT INTO content_filter_models (filter_id, model_id) VALUES (?, ?)').run(filterId, modelId);

  apiError(() => getEffectiveFilterSnapshot(modelId), {
    status: 500, code: 'filter_configuration_invalid'
  });
});

test('SQLite read failures are not misclassified as damaged filter configuration', () => {
  createFilter({
    name: 'valid-global', patterns: ['secret'], input_action: 'block', is_active: true, is_global: true
  });
  db.exec('DROP TABLE content_filter_models');
  let failure;
  try {
    getEffectiveFilterSnapshot(1);
  } catch (error) {
    failure = error;
  } finally {
    db.exec(`
      CREATE TABLE content_filter_models (
        filter_id INTEGER NOT NULL REFERENCES content_filters(id) ON DELETE CASCADE,
        model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        PRIMARY KEY(filter_id, model_id)
      )
    `);
  }
  assert.equal(failure.code, 'SQLITE_ERROR');
  assert.notEqual(failure.code, 'filter_configuration_invalid');
});

test('input filtering blocks original text before masking and masks only independent text contents', () => {
  const blocking = {
    input_block_patterns: ['first literal', 'second literal'],
    input_mask_patterns: ['block'],
    output_mask_patterns: [],
    input_block_policies: [
      { name: 'First input policy', patterns: ['first literal'] },
      { name: 'Second input policy', patterns: ['second literal'] }
    ]
  };
  const blockedContent = ['SECOND LITERAL', 'FIRST LITERAL'];
  let filterError;
  assert.throws(() => applyInputFilters({
    messages: [
      { content: blockedContent[0] },
      { content: [{ type: 'text', text: blockedContent[1] }] }
    ]
  }, blocking), (error) => {
    filterError = error;
    assert.equal(error.status, 400);
    assert.equal(error.code, 'content_filtered');
    return true;
  });
  assert.equal(filterError.filterName, 'First input policy');
  const serializedError = JSON.stringify(filterError);
  assert.equal(serializedError.includes('first literal'), false);
  assert.equal(serializedError.includes('second literal'), false);
  assert.equal(blockedContent.some((text) => serializedError.includes(text)), false);

  const original = {
    model: 'unchanged',
    stream: false,
    messages: [
      { role: 'user', content: 'A.B and SECRET secrets' },
      { role: 'user', content: [
        { type: 'text', text: 'a.b' },
        { type: 'image_url', image_url: { url: 'secret' } },
        { type: 'text', text: 'sec' },
        { type: 'text', text: 'rets' }
      ] },
      { role: 'tool', content: [{ type: 'input_audio', data: 'secret' }] }
    ],
    tools: [{ function: { arguments: 'secret' } }],
    vendor: { secret: 'secret' }
  };
  const filtered = applyInputFilters(original, {
    input_block_patterns: [],
    input_mask_patterns: ['secret', 'secrets', 'a.b'],
    output_mask_patterns: []
  });

  assert.notEqual(filtered, original);
  assert.equal(original.messages[0].content, 'A.B and SECRET secrets');
  assert.equal(filtered.messages[0].content, '[FILTERED] and [FILTERED] [FILTERED]');
  assert.equal(filtered.messages[1].content[0].text, '[FILTERED]');
  assert.equal(filtered.messages[1].content[1].image_url.url, 'secret');
  assert.equal(filtered.messages[1].content[2].text, 'sec');
  assert.equal(filtered.messages[1].content[3].text, 'rets');
  assert.deepEqual(filtered.tools, original.tools);
  assert.deepEqual(filtered.vendor, original.vendor);
  assert.equal(filtered.model, 'unchanged');
  assert.equal(filtered.stream, false);
});

test('present input-block policy metadata is validated fail closed', () => {
  const body = { messages: [{ content: 'blocked' }] };
  const base = {
    input_block_patterns: ['blocked'],
    input_mask_patterns: [],
    output_mask_patterns: []
  };
  const invalidPolicies = [
    null,
    [{ name: ' ', patterns: ['blocked'] }],
    [{ name: 'Policy', patterns: [1] }],
    [{ name: 'Policy', patterns: ['different'] }],
    [{ name: 'Policy', patterns: ['blocked'], extra: 'not allowed' }]
  ];

  for (const input_block_policies of invalidPolicies) {
    assert.throws(() => applyInputFilters(body, { ...base, input_block_policies }), (error) => {
      assert.equal(error.status, 500);
      assert.equal(error.code, 'filter_configuration_invalid');
      assert.equal(error.message, 'Content filter configuration is invalid');
      assert.equal(Object.hasOwn(error, 'filterName'), false);
      return true;
    });
  }

  assert.throws(() => applyInputFilters(body, base), (error) => {
    assert.equal(error.code, 'content_filtered');
    assert.equal(Object.hasOwn(error, 'filterName'), false);
    return true;
  });
});

test('input-block attribution builds one literal plan regardless of policy count', () => {
  const input_block_policies = Array.from({ length: 40 }, (_, index) => ({
    name: 'Policy ' + index,
    patterns: ['bounded-attribution-' + index + '-end']
  }));
  const input_block_patterns = input_block_policies.flatMap((policy) => policy.patterns);
  const nativeStringify = JSON.stringify;
  let planLookups = 0;
  JSON.stringify = function observedStringify(value, ...args) {
    if (Array.isArray(value) && value.length > 0 && value.every((item) =>
      typeof item === 'string' && item.startsWith('bounded-attribution-'))) {
      planLookups += 1;
    }
    return nativeStringify.call(this, value, ...args);
  };
  try {
    assert.throws(() => applyInputFilters({
      messages: [{ content: 'bounded-attribution-39-end' }]
    }, {
      input_block_patterns,
      input_mask_patterns: [],
      output_mask_patterns: [],
      input_block_policies
    }), (error) => {
      assert.equal(error.code, 'content_filtered');
      assert.equal(error.filterName, 'Policy 39');
      return true;
    });
  } finally {
    JSON.stringify = nativeStringify;
  }
  assert.equal(planLookups, 1);
});

test('masking is literal, Unicode case-insensitive, leftmost, and longest at the same position', () => {
  assert.equal(maskText('aba', ['ab', 'aba']), '[FILTERED]');
  const body = { messages: [{ content: '\u212A ey and ababa and a+b' }] };
  const filtered = applyInputFilters(body, {
    input_block_patterns: [],
    input_mask_patterns: ['k', 'ab', 'aba', 'a+b'],
    output_mask_patterns: []
  });
  assert.equal(filtered.messages[0].content, '[FILTERED] ey and [FILTERED]ba and [FILTERED]');
});

test('deterministic mask scanning handles a periodic shared prefix at the request limit', () => {
  const patterns = Array.from(
    { length: 200 },
    (_, index) => 'a'.repeat(255) + String.fromCodePoint(0x4e00 + index)
  );
  const input = 'a'.repeat(1024 * 1024);
  const { result, constructions } = captureRegExpConstructions(() => {
    const mask = createMasker(patterns);
    return mask(input);
  });
  const replacementMatchers = constructions.filter(({ flags }) => flags === 'giu');

  assert.equal(result, input);
  assert.equal(replacementMatchers.length, 0);
});


test('max-size distinct-edge plans compile only branching edge matchers', () => {
  const base = 0xf0000;
  const patterns = Array.from({ length: 200 }, (_, patternIndex) =>
    Array.from(
      { length: 256 },
      (_, characterIndex) => String.fromCodePoint(
        base + patternIndex * 256 + characterIndex
      )
    ).join('')
  );
  const { result: filter, constructions } = captureRegExpConstructions(
    () => createLiteralFilter(patterns)
  );

  assert.ok(
    constructions.length <= 250,
    `expected at most 250 branching matchers, got ${constructions.length}`
  );
  assert.equal(filter.test(patterns[0]), true);
  assert.equal(filter.test(patterns.at(-1)), true);
});

test('Unicode-equivalent trie edges preserve full-pattern longest priority', () => {
  assert.equal(maskText('sxyz', ['sX', '\u017fXYZ']), '[FILTERED]');
  assert.equal(
    maskText('\u017fabc', ['sxxxxxxxxx', 'sa', '\u017fabc']),
    '[FILTERED]'
  );
  assert.equal(
    maskText('sA sB \u017fA \u017fB', ['sA', '\u017fB']),
    '[FILTERED] [FILTERED] [FILTERED] [FILTERED]'
  );
  assert.equal(maskText('\u017fabc', ['s', '\u017fabc']), '[FILTERED]');
  assert.equal(
    maskText('key \u03c2igma \u{10428}abc', ['\u212aEY', '\u03a3IGMA', '\u{10400}ABC']),
    '[FILTERED] [FILTERED] [FILTERED]'
  );
  assert.equal(
    maskText('.x +x \u{10428}yz', ['.x', '+x', '\u{10400}x', '\u{10428}yz']),
    '[FILTERED] [FILTERED] [FILTERED]'
  );
});

test('wide Unicode membership uses one safely escaped character class', () => {
  const patterns = [']', '^', '-', '\\', 's', '\u{1f600}'];
  const { result: filter, constructions } = captureRegExpConstructions(
    () => createLiteralFilter(patterns)
  );
  const memberships = constructions.filter(({ source, flags }) =>
    flags === 'iu' && source.startsWith('^(?:[')
  );

  assert.equal(memberships.length, 1);
  assert.equal(
    filter.replace(']^-\\s\u017f\u{1f600}x'),
    '[FILTERED]'.repeat(7) + 'x'
  );
});

test('literal filter preserves chained overlaps and streaming boundaries', () => {
  const filter = createLiteralFilter([
    'ab', 'bc', 'c', 'aba', 'a+b', '\u017fabc', '\u212aEY', '\u03a3IGMA', '\u{10400}ABC'
  ]);

  assert.equal(filter.test('plain'), false);
  assert.equal(filter.test('prefix \u017fABC suffix'), true);
  assert.equal(
    filter.replace('abc A+B key \u03c2igma \u{10428}abc'),
    '[FILTERED][FILTERED] [FILTERED] [FILTERED] [FILTERED] [FILTERED]'
  );
  assert.equal(filter.extendBoundary('xxabazz', 4), 5);
  assert.equal(filter.extendBoundary('xx\u{10428}abcz', 4), 7);
  const adjacent = createLiteralFilter(['long-pattern-to-make-max-greater-than-one', 's']);
  assert.equal(adjacent.extendBoundary('s\u017f', 1), 1);

});

test('literal filter matches the prioritized flat-regex oracle', () => {
  const alphabet = ['a', 'b', 's', '\u017f', 'k', '\u212a', '\u03a3', '\u03c3', '\u03c2', '+', '.', '\u{10400}', '\u{10428}'];
  let seed = 0x1a2b3c4d;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  }
  function token() {
    return alphabet[Math.floor(random() * alphabet.length)];
  }
  function literal() {
    let value = '';
    const length = 1 + Math.floor(random() * 5);
    for (let index = 0; index < length; index += 1) value += token();
    return value;
  }
  function escape(pattern) {
    const metacharacters = '\\^$.*+?()[]{}|';
    let result = '';
    for (const character of pattern) {
      result += metacharacters.includes(character) ? '\\' + character : character;
    }
    return result;
  }
  function sourceFor(patterns) {
    return patterns
      .map((pattern, index) => ({ pattern, index }))
      .sort((left, right) =>
        right.pattern.length - left.pattern.length || left.index - right.index
      )
      .map(({ pattern }) => escape(pattern))
      .join('|');
  }
  function reference(value, patterns) {
    return value.replace(new RegExp(sourceFor(patterns), 'giu'), '[FILTERED]');
  }
  function referenceBoundary(value, patterns, boundary) {
    let extended = boundary;
    const matcher = new RegExp(sourceFor(patterns), 'giu');
    for (let match = matcher.exec(value); match; match = matcher.exec(value)) {
      if (match.index < extended) extended = Math.max(extended, match.index + match[0].length);
    }
    return extended;
  }

  for (let iteration = 0; iteration < 5000; iteration += 1) {
    const patterns = Array.from({ length: 1 + Math.floor(random() * 8) }, literal);
    let value = '';
    const valueLength = Math.floor(random() * 24);
    for (let index = 0; index < valueLength; index += 1) value += token();
    const filter = createLiteralFilter(patterns);
    assert.equal(filter.replace(value), reference(value, patterns));
    const boundary = Math.floor(random() * (value.length + 1));
    assert.equal(
      filter.extendBoundary(value, boundary), referenceBoundary(value, patterns, boundary)
    );
  }
});

test('no-match replacement avoids allocating the match interval ring', () => {
  const filter = createLiteralFilter([
    'ab'.repeat(127) + 'ax',
    'ab'.repeat(127) + 'ay'
  ]);
  const NativeInt32Array = global.Int32Array;
  let allocations = 0;
  global.Int32Array = class ObservedInt32Array extends NativeInt32Array {
    constructor(...args) {
      allocations += 1;
      super(...args);
    }
  };
  try {
    const input = 'ab'.repeat(4096);
    assert.equal(filter.replace(input), input);
  } finally {
    global.Int32Array = NativeInt32Array;
  }
  assert.equal(allocations, 0);
});

test('stream boundaries at the text edges avoid allocating match rings', () => {
  const filter = createLiteralFilter(['a', 'aa', 'long-pattern-to-set-the-carry-width']);
  const NativeInt32Array = global.Int32Array;
  let allocations = 0;
  global.Int32Array = class ObservedInt32Array extends NativeInt32Array {
    constructor(...args) {
      allocations += 1;
      super(...args);
    }
  };
  try {
    const value = 'a'.repeat(4096);
    assert.equal(filter.extendBoundary(value, 0), 0);
    assert.equal(filter.extendBoundary(value, value.length), value.length);
  } finally {
    global.Int32Array = NativeInt32Array;
  }
  assert.equal(allocations, 0);
});

test('cap-plus-one root misses do not evict transition entries', () => {
  const patterns = Array.from(
    { length: 200 },
    (_, index) => String.fromCodePoint(0x400 + index)
  );
  const cycle = Array.from(
    { length: 1025 },
    (_, index) => String.fromCodePoint(0x1000 + index)
  ).join('');
  const repetitions = Math.floor(
    (1024 * 1024 - 128) / Buffer.byteLength(cycle, 'utf8')
  );
  const input = cycle.repeat(repetitions);
  const filter = createLiteralFilter(patterns);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ messages: [{ content: input }] }), 'utf8') <=
      1024 * 1024
  );

  const nativeTest = RegExp.prototype.test;
  let membershipTests = 0;
  RegExp.prototype.test = function observedTest(value) {
    if (this.flags === 'iu' && this.source.startsWith('^(?:[')) {
      membershipTests += 1;
      if (membershipTests > 4096) throw new Error('root misses were scanned character by character');
    }
    return nativeTest.call(this, value);
  };
  let observed;
  try {
    observed = observeMapEvictions(() => filter.replace(input));
  } finally {
    RegExp.prototype.test = nativeTest;
  }
  assert.equal(observed.result, input);
  assert.equal(observed.deletions, 0);
  assert.ok(membershipTests <= 4096, `unexpected root membership tests: ${membershipTests}`);
});

test('cap-plus-one deep misses do not evict transition entries', () => {
  const pattern = 'A'.repeat(255) + 'x';
  const cycle = Array.from({ length: 1025 }, (_, index) => {
    const depth = index % 255 + 1;
    const miss = String.fromCodePoint(0x1000 + Math.floor(index / 255));
    return 'A'.repeat(depth) + miss;
  }).join('');
  const repetitions = Math.floor(
    (1024 * 1024 - 128) / Buffer.byteLength(cycle, 'utf8')
  );
  const input = cycle.repeat(repetitions);
  const filter = createLiteralFilter([pattern]);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ messages: [{ content: input }] }), 'utf8') <=
      1024 * 1024
  );

  const nativeTest = RegExp.prototype.test;
  let edgeTests = 0;
  RegExp.prototype.test = function observedTest(value) {
    if (this.flags === 'iu' && this.source === '^(?:A)$') {
      edgeTests += 1;
      if (edgeTests > 4096) throw new Error('deep misses walked the failure chain');
    }
    return nativeTest.call(this, value);
  };
  let observed;
  try {
    observed = observeMapEvictions(() => filter.replace(input));
  } finally {
    RegExp.prototype.test = nativeTest;
  }
  assert.equal(observed.result, input);
  assert.equal(observed.deletions, 0);
  assert.ok(edgeTests <= 4096, `unexpected deep edge tests: ${edgeTests}`);
});

test('case-folded positive root transitions stay bounded across a wide cycle', () => {
  const patterns = [];
  const variants = [];
  const seenVariants = new Set();
  for (let codePoint = 0x41; codePoint <= 0xffff && patterns.length < 200; codePoint += 1) {
    const pattern = String.fromCodePoint(codePoint);
    const variant = pattern.toLowerCase();
    if (pattern === variant || Array.from(variant).length !== 1 || seenVariants.has(variant)) continue;
    seenVariants.add(variant);
    patterns.push(pattern);
    variants.push(variant);
  }
  assert.equal(patterns.length, 200);

  const filter = createLiteralFilter(patterns);
  const input = variants.join('').repeat(32);
  const nativeTest = RegExp.prototype.test;
  let tests = 0;
  RegExp.prototype.test = function observedTest(value) {
    if (this.flags === 'iu') {
      tests += 1;
      if (tests > 25000) throw new Error('positive transition cache was bypassed');
    }
    return nativeTest.call(this, value);
  };
  try {
    assert.equal(filter.replace(input, ''), '');
  } finally {
    RegExp.prototype.test = nativeTest;
  }
  assert.ok(tests <= 25000, `unexpected case-folded transition tests: ${tests}`);
});

test('hot nonexact transitions remain cached after 1024 distinct characters', () => {
  const filter = createLiteralFilter(['A'.repeat(255) + 'x']);
  const filler = Array.from(
    { length: 1024 },
    (_, index) => String.fromCodePoint(0x400 + index)
  ).join('');
  const input = filler + 'a'.repeat(1024 * 1024 - filler.length);
  const NativeRegExp = global.RegExp;
  const nativeTest = NativeRegExp.prototype.test;
  let hotConstructions = 0;
  let hotTests = 0;

  global.RegExp = class ObservedRegExp extends NativeRegExp {
    constructor(pattern, flags) {
      if (flags === 'iu' && String(pattern) === '^(?:a)$') {
        hotConstructions += 1;
        if (hotConstructions > 2) throw new Error('hot input matcher was recreated');
      }
      super(pattern, flags);
    }
  };
  NativeRegExp.prototype.test = function observedTest(value) {
    if (this.source === '^(?:A)$' && value === 'a') {
      hotTests += 1;
      if (hotTests > 300) throw new Error('hot transition was not cached');
    }
    return nativeTest.call(this, value);
  };
  try {
    assert.equal(filter.replace(input, ''), input);
  } finally {
    global.RegExp = NativeRegExp;
    NativeRegExp.prototype.test = nativeTest;
  }

  assert.ok(hotConstructions <= 1, `unexpected hot matcher constructions: ${hotConstructions}`);
  assert.ok(hotTests <= 256, `unexpected hot transition tests: ${hotTests}`);
});

test('single-character replacement avoids allocating the match interval ring', () => {
  const filter = createLiteralFilter(['a']);
  const NativeInt32Array = global.Int32Array;
  let allocations = 0;
  global.Int32Array = class ObservedInt32Array extends NativeInt32Array {
    constructor(...args) {
      allocations += 1;
      super(...args);
    }
  };
  try {
    assert.equal(filter.replace('a'.repeat(4096)), '[FILTERED]'.repeat(4096));
  } finally {
    global.Int32Array = NativeInt32Array;
  }
  assert.equal(allocations, 0);
});

test('dense overlapping matches coalesce adjacent replacement runs', () => {
  const filter = createLiteralFilter(['a', 'aa', 'aaa', 'aaaa']);
  const input = 'a'.repeat(4096);
  const expected = '[FILTERED]'.repeat(1024);
  const nativeRepeat = String.prototype.repeat;
  let replacementRuns = 0;
  String.prototype.repeat = function observedRepeat(count) {
    if (String(this) === '[FILTERED]' && count > 1) replacementRuns += 1;
    return nativeRepeat.call(this, count);
  };
  try {
    assert.equal(filter.replace(input), expected);
  } finally {
    String.prototype.repeat = nativeRepeat;
  }
  assert.equal(replacementRuns, 1);
});

test('createMasker reuses a deterministic plan without a full-text replacement regex', () => {
  const { result, constructions } = captureRegExpConstructions(() => {
    const mask = createMasker(['ab', 'aba', 'a+b']);
    return [mask('ababa'), mask('A+B')];
  });

  assert.deepEqual(result, ['[FILTERED]ba', '[FILTERED]']);
  assert.equal(constructions.filter(({ flags }) => flags === 'giu').length, 0);
});

test('input filtering reuses block and mask plans without full-text regex scans', () => {
  const body = {
    messages: [
      { content: 'safe' },
      { content: [
        { type: 'text', text: 'secret' },
        { type: 'text', text: 'still safe' }
      ] },
      { content: 'SECRET' }
    ]
  };
  const { result, constructions } = captureRegExpConstructions(() => applyInputFilters(body, {
    input_block_patterns: ['blocked'],
    input_mask_patterns: ['secret'],
    output_mask_patterns: []
  }));

  assert.equal(result.messages[0].content, 'safe');
  assert.equal(result.messages[1].content[0].text, '[FILTERED]');
  assert.equal(result.messages[1].content[1].text, 'still safe');
  assert.equal(result.messages[2].content, '[FILTERED]');
  const runtimeMatchers = constructions.filter(({ source, flags }) =>
    flags === 'giu' || (flags === 'iu' && !source.startsWith('^(?:'))
  );
  assert.deepEqual(runtimeMatchers, []);
});

test('input block traversal stops at the first matching content', () => {
  const unread = new Error('content after a block match was visited');
  const body = {
    messages: [
      { content: 'blocked' },
      {
        get content() {
          throw unread;
        }
      }
    ]
  };

  assert.throws(() => applyInputFilters(body, {
    input_block_patterns: ['blocked'],
    input_mask_patterns: [],
    output_mask_patterns: []
  }), (error) => {
    assert.notEqual(error, unread);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'content_filtered');
    return true;
  });
});

test('output filtering reuses one mask plan for every choice', () => {
  const response = {
    choices: [
      { message: { content: 'secret one' } },
      { message: { content: 'safe' } },
      { message: { content: 'SECRET two' } },
      { message: { content: null } }
    ]
  };
  const { result, constructions } = captureRegExpConstructions(() => applyOutputFilters(response, {
    input_block_patterns: [],
    input_mask_patterns: [],
    output_mask_patterns: ['secret']
  }));

  assert.deepEqual(result.choices.map((choice) => choice.message.content), [
    '[FILTERED] one', 'safe', '[FILTERED] two', null
  ]);
  assert.equal(constructions.filter(({ flags }) => flags === 'giu').length, 0);
});

test('non-stream output masks only choices message content and preserves all other fields', () => {
  const original = {
    id: 'response-id',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'top SECRET', tool_calls: [{ arguments: 'secret' }] }, vendor: 'keep' },
      { index: 1, message: { role: 'assistant', content: null } }
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
    vendor_secret: 'secret'
  };
  const filtered = applyOutputFilters(original, {
    input_block_patterns: [], input_mask_patterns: [], output_mask_patterns: ['secret']
  });
  assert.equal(original.choices[0].message.content, 'top SECRET');
  assert.equal(filtered.choices[0].message.content, 'top [FILTERED]');
  assert.equal(filtered.choices[0].message.tool_calls[0].arguments, 'secret');
  assert.deepEqual(filtered.usage, original.usage);
  assert.equal(filtered.vendor_secret, 'secret');
});

test('post-transform request serialization is capped at one MiB with a fixed error', () => {
  const nearLimit = { messages: [{ content: 'x'.repeat(110_000) }] };
  const filtered = applyInputFilters(nearLimit, {
    input_block_patterns: [], input_mask_patterns: ['x'], output_mask_patterns: []
  });
  apiError(() => assertRequestSize(filtered), { status: 413, code: 'request_too_large' });
  assert.doesNotThrow(() => assertRequestSize({ messages: [{ content: 'safe' }], max_tokens: 10 }));
});
