const db = require('../db/database');
const { ApiError } = require('./errors');
const { audit } = require('./audit');
const { forEachChatText } = require('./chat-content');

const FILTERED = '[FILTERED]';
const MAX_NAME_LENGTH = 100;
const MAX_PATTERN_LENGTH = 256;
const MAX_STORED_PATTERNS = 200;
const MAX_REQUEST_BYTES = 1024 * 1024;
const LITERAL_AUTOMATON_CACHE_MAX_ENTRIES = 16;
const LITERAL_AUTOMATON_CACHE_MAX_UNITS = 2_000_000;
const LITERAL_AUTOMATON_CACHE_MAX_NODES = 60_000;
const NONEXACT_TRANSITION_CACHE_LIMIT = 1024;
const ALPHABET_PREFILTER_MAX_SOURCE_UNITS = 4096;
const literalAutomatonCache = new Map();
let literalAutomatonCacheUnits = 0;
let literalAutomatonCacheNodes = 0;
const FILTER_FIELDS = new Set([
  'name', 'patterns', 'input_action', 'output_action', 'is_active', 'is_global', 'model_ids'
]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function configurationError() {
  return new ApiError(500, 'Content filter configuration is invalid', 'filter_configuration_invalid');
}

function badRequest(message) {
  return new ApiError(400, message);
}

function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Filter must be an object');
  }
}

function assertKnownFields(value, allowEmpty = false) {
  assertObject(value);
  const fields = Object.keys(value);
  if (!allowEmpty && fields.length === 0) throw badRequest('At least one filter field is required');
  if (fields.some((field) => !FILTER_FIELDS.has(field))) throw badRequest('Filter contains an unknown field');
  return fields;
}

function characterLength(value) {
  return Array.from(value).length;
}

function normalizeName(value) {
  if (typeof value !== 'string') throw badRequest('name must be a string');
  const normalized = value.trim();
  if (!normalized || characterLength(normalized) > MAX_NAME_LENGTH) {
    throw badRequest('name must contain 1 to 100 characters');
  }
  return normalized;
}

function escapeLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeCharacterClass(value) {
  let escaped = '';
  for (const character of value) {
    escaped += '\\[]^-'.includes(character) ? '\\' + character : character;
  }
  return escaped;
}

function normalizePatterns(value, { allowEmpty = false, allowDuplicates = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw badRequest('patterns must be a non-empty array');
  }
  if (value.length > MAX_STORED_PATTERNS) throw badRequest('At most 200 patterns may be stored');
  const normalized = [];
  const matchers = [];
  for (const pattern of value) {
    if (typeof pattern !== 'string') throw badRequest('Each pattern must be a string');
    const trimmed = pattern.trim();
    if (!trimmed || characterLength(trimmed) > MAX_PATTERN_LENGTH || CONTROL_CHARACTER.test(pattern)) {
      throw badRequest('Each pattern must contain 1 to 256 characters without control characters');
    }
    if (!allowDuplicates) {
      const matcher = new RegExp(`^(?:${escapeLiteral(trimmed)})$`, 'iu');
      if (normalized.some((existing, index) =>
        matchers[index].test(trimmed) || matcher.test(existing))) {
        throw badRequest('patterns must not contain case-insensitive duplicates');
      }
      matchers.push(matcher);
    }
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeInputAction(value) {
  if (value !== null && value !== 'block' && value !== 'mask') {
    throw badRequest('input_action must be block, mask, or null');
  }
  return value;
}

function normalizeOutputAction(value) {
  if (value !== null && value !== 'mask') throw badRequest('output_action must be mask or null');
  return value;
}

function normalizeBoolean(value, name) {
  if (typeof value !== 'boolean') throw badRequest(`${name} must be a boolean`);
  return value;
}

function normalizeModelIds(value) {
  if (!Array.isArray(value)) throw badRequest('model_ids must be an array');
  const seen = new Set();
  const normalized = [];
  for (const modelId of value) {
    if (!Number.isSafeInteger(modelId) || modelId <= 0) {
      throw badRequest('model_ids must contain positive safe integers');
    }
    if (seen.has(modelId)) throw badRequest('model_ids must not contain duplicates');
    seen.add(modelId);
    normalized.push(modelId);
  }
  return normalized.sort((left, right) => left - right);
}

function normalizeId(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw badRequest('filter id must be a positive safe integer');
  return parsed;
}

function assertActionPresent(inputAction, outputAction) {
  if (inputAction === null && outputAction === null) {
    throw badRequest('At least one input or output action is required');
  }
}

function createValues(input) {
  const fields = assertKnownFields(input, true);
  const values = {
    name: normalizeName(input.name),
    patterns: normalizePatterns(input.patterns),
    input_action: input.input_action === undefined ? null : normalizeInputAction(input.input_action),
    output_action: input.output_action === undefined ? null : normalizeOutputAction(input.output_action),
    is_active: input.is_active === undefined ? false : normalizeBoolean(input.is_active, 'is_active'),
    is_global: input.is_global === undefined ? false : normalizeBoolean(input.is_global, 'is_global'),
    model_ids: input.model_ids === undefined ? [] : normalizeModelIds(input.model_ids)
  };
  assertActionPresent(values.input_action, values.output_action);
  return { fields, values };
}

function updateValues(input) {
  const fields = assertKnownFields(input);
  const values = {};
  if (Object.hasOwn(input, 'name')) values.name = normalizeName(input.name);
  if (Object.hasOwn(input, 'patterns')) values.patterns = normalizePatterns(input.patterns);
  if (Object.hasOwn(input, 'input_action')) values.input_action = normalizeInputAction(input.input_action);
  if (Object.hasOwn(input, 'output_action')) values.output_action = normalizeOutputAction(input.output_action);
  if (Object.hasOwn(input, 'is_active')) values.is_active = normalizeBoolean(input.is_active, 'is_active');
  if (Object.hasOwn(input, 'is_global')) values.is_global = normalizeBoolean(input.is_global, 'is_global');
  if (Object.hasOwn(input, 'model_ids')) values.model_ids = normalizeModelIds(input.model_ids);
  return { fields, values };
}

function fixedConfiguration(work) {
  try {
    return work();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'filter_configuration_invalid') throw error;
    if (error && typeof error.code === 'string' && error.code.startsWith('SQLITE_')) throw error;
    throw configurationError();
  }
}

function storedPatterns(serialized) {
  return fixedConfiguration(() => {
    const parsed = JSON.parse(serialized);
    const normalized = normalizePatterns(parsed);
    if (parsed.some((pattern, index) => pattern !== normalized[index])) throw configurationError();
    return normalized;
  });
}

function storedFilter(row) {
  const modelIds = db.prepare(`
    SELECT model_id FROM content_filter_models WHERE filter_id = ? ORDER BY model_id
  `).pluck().all(row.id);
  return fixedConfiguration(() => {
    const name = normalizeName(row.name);
    const patterns = storedPatterns(row.patterns);
    const inputAction = normalizeInputAction(row.input_action);
    const outputAction = normalizeOutputAction(row.output_action);
    assertActionPresent(inputAction, outputAction);
    if (name !== row.name || ![0, 1].includes(row.is_active) || ![0, 1].includes(row.is_global) ||
        typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') {
      throw configurationError();
    }
    if (modelIds.some((modelId) => !Number.isSafeInteger(modelId) || modelId <= 0) ||
        (row.is_global === 1 && modelIds.length > 0)) {
      throw configurationError();
    }
    return {
      id: row.id,
      name,
      patterns,
      input_action: inputAction,
      output_action: outputAction,
      is_active: row.is_active === 1,
      is_global: row.is_global === 1,
      model_ids: modelIds,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  });
}

function readFilter(filterId) {
  const row = db.prepare(`
    SELECT id, name, patterns, input_action, output_action, is_active, is_global, created_at, updated_at
    FROM content_filters WHERE id = ?
  `).get(filterId);
  return row ? storedFilter(row) : null;
}

function listFilters() {
  return db.prepare(`
    SELECT id, name, patterns, input_action, output_action, is_active, is_global, created_at, updated_at
    FROM content_filters ORDER BY id
  `).all().map(storedFilter);
}

function validateModels(modelIds) {
  const exists = db.prepare('SELECT 1 FROM models WHERE id = ?');
  if (modelIds.some((modelId) => !exists.get(modelId))) throw badRequest('model_ids contains an unknown model');
}

function storedPatternCount(excludedId = null) {
  let total = 0;
  for (const row of db.prepare('SELECT id, patterns FROM content_filters').all()) {
    if (row.id === excludedId) continue;
    total += storedPatterns(row.patterns).length;
    if (!Number.isSafeInteger(total) || total > MAX_STORED_PATTERNS) throw configurationError();
  }
  return total;
}

function assertTotalPatternCount(patterns, excludedId = null) {
  if (storedPatternCount(excludedId) + patterns.length > MAX_STORED_PATTERNS) {
    throw badRequest('At most 200 patterns may be stored');
  }
}

function replaceAssignments(filterId, modelIds) {
  db.prepare('DELETE FROM content_filter_models WHERE filter_id = ?').run(filterId);
  const insert = db.prepare('INSERT INTO content_filter_models (filter_id, model_id) VALUES (?, ?)');
  for (const modelId of modelIds) insert.run(filterId, modelId);
}

function translateNameConflict(error) {
  if (error && error.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
      String(error.message).includes('content_filters.name')) {
    throw new ApiError(409, 'Filter name already exists');
  }
  throw error;
}

function createFilter(input) {
  const { fields, values } = createValues(input);
  let filterId;
  try {
    db.transaction(() => {
      validateModels(values.model_ids);
      assertTotalPatternCount(values.patterns);
      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO content_filters
          (name, patterns, input_action, output_action, is_active, is_global, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.name,
        JSON.stringify(values.patterns),
        values.input_action,
        values.output_action,
        values.is_active ? 1 : 0,
        values.is_global ? 1 : 0,
        now,
        now
      );
      filterId = Number(result.lastInsertRowid);
      replaceAssignments(filterId, values.is_global ? [] : values.model_ids);
      audit('filter.create', 'filter', filterId, true, fields);
    }).immediate();
  } catch (error) {
    translateNameConflict(error);
  }
  return readFilter(filterId);
}

function updateFilter(id, input) {
  const filterId = normalizeId(id);
  const { fields, values } = updateValues(input);
  try {
    db.transaction(() => {
      const existing = readFilter(filterId);
      if (!existing) throw new ApiError(404, 'Filter not found');
      const next = { ...existing, ...values };
      assertActionPresent(next.input_action, next.output_action);
      validateModels(values.model_ids === undefined ? [] : values.model_ids);
      assertTotalPatternCount(next.patterns, filterId);
      if (next.is_global) next.model_ids = [];
      db.prepare(`
        UPDATE content_filters SET
          name = ?, patterns = ?, input_action = ?, output_action = ?, is_active = ?, is_global = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.name,
        JSON.stringify(next.patterns),
        next.input_action,
        next.output_action,
        next.is_active ? 1 : 0,
        next.is_global ? 1 : 0,
        new Date().toISOString(),
        filterId
      );
      replaceAssignments(filterId, next.model_ids);
      audit('filter.update', 'filter', filterId, true, fields);
    }).immediate();
  } catch (error) {
    translateNameConflict(error);
  }
  return readFilter(filterId);
}

function deleteFilter(id) {
  const filterId = normalizeId(id);
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM content_filters WHERE id = ?').get(filterId)) {
      throw new ApiError(404, 'Filter not found');
    }
    db.prepare('DELETE FROM content_filters WHERE id = ?').run(filterId);
    audit('filter.delete', 'filter', filterId, true, []);
  }).immediate();
}

function getEffectiveFilterSnapshot(modelId) {
  const normalizedModelId = normalizeId(modelId);
  return fixedConfiguration(() => {
    const inputBlockPatterns = [];
    const inputBlockPolicies = [];
    const inputMaskPatterns = [];
    const outputMaskPatterns = [];
    let total = 0;
    const rows = db.prepare(`
      SELECT filter.*
      FROM content_filters AS filter
      WHERE is_active = 1 AND (
        is_global = 1 OR EXISTS (
          SELECT 1 FROM content_filter_models AS assignment
          WHERE assignment.filter_id = filter.id AND assignment.model_id = ?
        )
      )
      ORDER BY id
    `).all(normalizedModelId);
    for (const row of rows) {
      const filter = storedFilter(row);
      total += filter.patterns.length;
      if (!Number.isSafeInteger(total) || total > MAX_STORED_PATTERNS) throw configurationError();
      if (filter.input_action === 'block') {
        inputBlockPatterns.push(...filter.patterns);
        inputBlockPolicies.push(Object.freeze({ name: filter.name, patterns: Object.freeze([...filter.patterns]) }));
      }
      if (filter.input_action === 'mask') inputMaskPatterns.push(...filter.patterns);
      if (filter.output_action === 'mask') outputMaskPatterns.push(...filter.patterns);
    }
    return Object.freeze({
      input_block_patterns: Object.freeze(inputBlockPatterns),
      input_mask_patterns: Object.freeze(inputMaskPatterns),
      output_mask_patterns: Object.freeze(outputMaskPatterns),
      input_block_policies: Object.freeze(inputBlockPolicies)
    });
  });
}

function snapshotPatterns(snapshot, field) {
  return fixedConfiguration(() => {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw configurationError();
    const original = snapshot[field];
    const normalized = normalizePatterns(original, { allowEmpty: true, allowDuplicates: true });
    if (original.some((pattern, index) => pattern !== normalized[index])) throw configurationError();
    return normalized;
  });
}

function snapshotBlockPolicyNames(snapshot, blocking) {
  if (!Object.hasOwn(snapshot, 'input_block_policies')) return null;
  return fixedConfiguration(() => {
    const policies = snapshot.input_block_policies;
    if (!Array.isArray(policies)) throw configurationError();
    const namesByPattern = [];
    let patternIndex = 0;
    for (const policy of policies) {
      if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
          Object.getPrototypeOf(policy) !== Object.prototype) {
        throw configurationError();
      }
      const fields = Object.keys(policy).sort();
      if (fields.length !== 2 || fields[0] !== 'name' || fields[1] !== 'patterns') {
        throw configurationError();
      }
      const name = normalizeName(policy.name);
      if (name !== policy.name || !Array.isArray(policy.patterns) || policy.patterns.length === 0) {
        throw configurationError();
      }
      for (const pattern of policy.patterns) {
        if (pattern !== blocking[patternIndex]) throw configurationError();
        namesByPattern.push(name);
        patternIndex += 1;
      }
    }
    if (patternIndex !== blocking.length) throw configurationError();
    return namesByPattern;
  });
}

function buildLiteralAutomaton(patterns) {
  let nextNodeId = 0;
  const nodes = [];
  const characterMatchers = new Map();

  function makeNode(depth) {
    const node = {
      id: nextNodeId,
      depth,
      children: [],
      exactChildren: new Map(),
      terminalLengths: new Set(),
      outputLengths: [],
      terminalPatternIndex: -1,
      minimumOutputPatternIndex: -1,
      failure: null,
      membership: null
    };
    nextNodeId += 1;
    nodes.push(node);
    return node;
  }

  function characterMatcher(character) {
    let matcher = characterMatchers.get(character);
    if (!matcher) {
      matcher = new RegExp('^(?:' + escapeLiteral(character) + ')$', 'iu');
      characterMatchers.set(character, matcher);
    }
    return matcher;
  }

  function equivalentCharacters(left, right) {
    return characterMatcher(left).test(right) || characterMatcher(right).test(left);
  }

  function findBuildChild(node, character) {
    const exact = node.exactChildren.get(character);
    if (exact) return exact;
    if (node.membership && !node.membership.test(character)) return null;
    return node.children.find((edge) => equivalentCharacters(edge.character, character)) || null;
  }

  const root = makeNode(0);
  const prioritized = patterns
    .map((pattern, index) => ({ pattern, index, characters: Array.from(pattern) }))
    .sort((left, right) =>
      right.pattern.length - left.pattern.length || left.index - right.index
    );
  let maxPatternLength = 0;

  for (const { characters, index } of prioritized) {
    maxPatternLength = Math.max(maxPatternLength, characters.length);
    let node = root;
    for (const character of characters) {
      let edge = node.exactChildren.get(character);
      if (!edge) {
        edge = node.children.find((candidate) =>
          equivalentCharacters(candidate.character, character)
        );
      }
      if (!edge) {
        edge = { character, node: makeNode(node.depth + 1) };
        node.children.push(edge);
      }
      node.exactChildren.set(character, edge);
      node = edge.node;
    }
    node.terminalLengths.add(characters.length);
    node.terminalPatternIndex = node.terminalPatternIndex < 0 ? index : Math.min(node.terminalPatternIndex, index);
  }

  for (const node of nodes) {
    if (node.children.length > 1) {
      node.membership = new RegExp(
        '^(?:[' + node.children.map((edge) => escapeCharacterClass(edge.character)).join('') + '])$',
        'iu'
      );
    }
  }

  let alphabetSource = '[';
  const alphabetCharacters = new Set();
  alphabet: for (const node of nodes) {
    for (const edge of node.children) {
      if (alphabetCharacters.has(edge.character)) continue;
      alphabetCharacters.add(edge.character);
      const escaped = escapeCharacterClass(edge.character);
      if (alphabetSource.length + escaped.length + 1 >
          ALPHABET_PREFILTER_MAX_SOURCE_UNITS) {
        alphabetSource = null;
        break alphabet;
      }
      alphabetSource += escaped;
    }
  }
  if (alphabetSource) alphabetSource += ']';
  const alphabetMembership = maxPatternLength > 1 && alphabetSource
    ? new RegExp('^(?:' + alphabetSource + ')$', 'iu')
    : null;
  const singleCharacterSearch = maxPatternLength === 1 && alphabetSource
    ? new RegExp(alphabetSource, 'iu')
    : null;

  function mergedOutputs(node) {
    const lengths = new Set(node.terminalLengths);
    if (node !== root) {
      for (const length of node.failure.outputLengths) lengths.add(length);
    }
    return [...lengths].sort((left, right) => right - left);
  }

  function mergedPatternIndex(node) {
    const failureIndex = node === root ? -1 : node.failure.minimumOutputPatternIndex;
    if (node.terminalPatternIndex < 0) return failureIndex;
    if (failureIndex < 0) return node.terminalPatternIndex;
    return Math.min(node.terminalPatternIndex, failureIndex);
  }

  root.failure = root;
  root.outputLengths = [...root.terminalLengths].sort((left, right) => right - left);
  root.minimumOutputPatternIndex = mergedPatternIndex(root);
  const queue = [];
  for (const edge of root.children) {
    edge.node.failure = root;
    edge.node.outputLengths = mergedOutputs(edge.node);
    edge.node.minimumOutputPatternIndex = mergedPatternIndex(edge.node);
    queue.push(edge.node);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    for (const edge of node.children) {
      let fallback = node.failure;
      let candidate = findBuildChild(fallback, edge.character);
      while (!candidate && fallback !== root) {
        fallback = fallback.failure;
        candidate = findBuildChild(fallback, edge.character);
      }
      edge.node.failure = candidate ? candidate.node : root;
      edge.node.outputLengths = mergedOutputs(edge.node);
      edge.node.minimumOutputPatternIndex = mergedPatternIndex(edge.node);
      queue.push(edge.node);
    }
  }

  return {
    root,
    characterMatchers,
    alphabetMembership,
    singleCharacterSearch,
    maxPatternLength,
    nodeCount: nodes.length
  };
}

function getLiteralAutomaton(patterns) {
  if (patterns.length === 0) return null;
  const cacheKey = JSON.stringify(patterns);
  const cached = literalAutomatonCache.get(cacheKey);
  if (cached) {
    literalAutomatonCache.delete(cacheKey);
    literalAutomatonCache.set(cacheKey, cached);
    return cached.plan;
  }

  const plan = buildLiteralAutomaton(patterns);
  const units = cacheKey.length;
  if (units <= LITERAL_AUTOMATON_CACHE_MAX_UNITS &&
      plan.nodeCount <= LITERAL_AUTOMATON_CACHE_MAX_NODES) {
    while (literalAutomatonCache.size > 0 && (
      literalAutomatonCache.size >= LITERAL_AUTOMATON_CACHE_MAX_ENTRIES ||
      literalAutomatonCacheUnits + units > LITERAL_AUTOMATON_CACHE_MAX_UNITS ||
      literalAutomatonCacheNodes + plan.nodeCount > LITERAL_AUTOMATON_CACHE_MAX_NODES
    )) {
      const oldestKey = literalAutomatonCache.keys().next().value;
      const oldest = literalAutomatonCache.get(oldestKey);
      literalAutomatonCache.delete(oldestKey);
      literalAutomatonCacheUnits -= oldest.units;
      literalAutomatonCacheNodes -= oldest.nodes;
    }
    literalAutomatonCache.set(cacheKey, { plan, units, nodes: plan.nodeCount });
    literalAutomatonCacheUnits += units;
    literalAutomatonCacheNodes += plan.nodeCount;
  }
  return plan;
}

function createPairCache() {
  return {
    values: new Map(),
    order: new Array(NONEXACT_TRANSITION_CACHE_LIMIT),
    size: 0,
    next: 0
  };
}

function readPairCache(cache, owner, key) {
  if (cache.size === 0) return undefined;
  const values = cache.values.get(owner);
  return values ? values.get(key) : undefined;
}

function writePairCache(cache, owner, key, value) {
  let values = cache.values.get(owner);
  if (values && values.has(key)) {
    values.set(key, value);
    return;
  }

  if (cache.size === NONEXACT_TRANSITION_CACHE_LIMIT) {
    const oldest = cache.order[cache.next];
    const oldestValues = cache.values.get(oldest.owner);
    oldestValues.delete(oldest.key);
    if (oldestValues.size === 0) cache.values.delete(oldest.owner);
  } else {
    cache.size += 1;
  }
  values = cache.values.get(owner);
  if (!values) {
    values = new Map();
    cache.values.set(owner, values);
  }
  cache.order[cache.next] = { owner, key };
  cache.next = (cache.next + 1) % NONEXACT_TRANSITION_CACHE_LIMIT;
  values.set(key, value);
}

function createScanContext(plan) {
  return {
    plan,
    nonexactTransitions: createPairCache(),
    transitions: createPairCache(),
    hotChildNode: null,
    hotChildCharacter: null,
    hotChildResult: null,
    hotTransitionState: null,
    hotTransitionCharacter: null,
    hotTransitionResult: null
  };
}

function planCharacterMatcher(plan, character) {
  let matcher = plan.characterMatchers.get(character);
  if (!matcher) {
    matcher = new RegExp('^(?:' + escapeLiteral(character) + ')$', 'iu');
    plan.characterMatchers.set(character, matcher);
  }
  return matcher;
}

function runtimeChild(context, node, character) {
  const exact = node.exactChildren.get(character);
  if (exact) return exact.node;
  if (node.children.length === 0) return null;
  if (context.hotChildNode === node && context.hotChildCharacter === character) {
    return context.hotChildResult;
  }

  let result = readPairCache(context.nonexactTransitions, node, character);
  if (result === undefined) {
    if (node.membership && !node.membership.test(character)) {
      result = null;
    } else {
      const edge = node.children.find((child) =>
        planCharacterMatcher(context.plan, child.character).test(character)
      );
      result = edge ? edge.node : null;
    }
    if (result) writePairCache(context.nonexactTransitions, node, character, result);
  }
  context.hotChildNode = node;
  context.hotChildCharacter = character;
  context.hotChildResult = result;
  return result;
}

function advanceAutomaton(context, state, character) {
  if (context.hotTransitionState === state &&
      context.hotTransitionCharacter === character) {
    return context.hotTransitionResult;
  }
  const originalState = state;
  const exact = state.exactChildren.get(character);
  if (exact) {
    context.hotTransitionState = originalState;
    context.hotTransitionCharacter = character;
    context.hotTransitionResult = exact.node;
    return exact.node;
  }
  let result = readPairCache(context.transitions, state, character);
  if (result === undefined && context.plan.alphabetMembership &&
      !context.plan.alphabetMembership.test(character)) {
    result = context.plan.root;
  }
  if (result === undefined) {
    let next = runtimeChild(context, state, character);
    while (!next && state !== context.plan.root) {
      state = state.failure;
      next = runtimeChild(context, state, character);
    }
    result = next || context.plan.root;
    if (result !== context.plan.root) writePairCache(context.transitions, originalState, character, result);
  }
  context.hotTransitionState = originalState;
  context.hotTransitionCharacter = character;
  context.hotTransitionResult = result;
  return result;
}

function longestOutputAtMost(lengths, maximum) {
  let low = 0;
  let high = lengths.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lengths[middle] > maximum) low = middle + 1;
    else high = middle;
  }
  return low < lengths.length ? lengths[low] : 0;
}

function scanSingleCharacterMatches(plan, value, visit) {
  const context = createScanContext(plan);
  let offset = 0;
  let runStart = -1;
  let runEnd = 0;
  let runCount = 0;

  function flushRun() {
    if (runCount === 0) return;
    visit({ start: runStart, end: runEnd, count: runCount });
    runStart = -1;
    runCount = 0;
  }

  for (const character of value) {
    const state = runtimeChild(context, plan.root, character);
    const end = offset + character.length;
    if (state && state.outputLengths.length > 0) {
      if (runCount === 0) runStart = offset;
      runEnd = end;
      runCount += 1;
    } else {
      flushRun();
    }
    offset = end;
  }
  flushRun();
}


function scanLiteralMatches(plan, value, visit, coalesce = true) {
  const context = createScanContext(plan);
  const starts = new Int32Array(plan.maxPatternLength);
  const capacity = plan.maxPatternLength + 1;
  const chainStartSequences = new Int32Array(capacity);
  const chainEndSequences = new Int32Array(capacity);
  const chainStarts = new Int32Array(capacity);
  const chainEnds = new Int32Array(capacity);
  let state = plan.root;
  let sequence = 0;
  let offset = 0;
  let committedSequence = 0;
  let chainHead = 0;
  let chainLength = 0;
  let runStart = -1;
  let runEnd = 0;
  let runCount = 0;

  function chainSlot(index) {
    return (chainHead + index) % capacity;
  }

  function setChain(index, startSequence, endSequence, start, end) {
    const slot = chainSlot(index);
    chainStartSequences[slot] = startSequence;
    chainEndSequences[slot] = endSequence;
    chainStarts[slot] = start;
    chainEnds[slot] = end;
  }

  function dropChainHead() {
    chainHead = (chainHead + 1) % capacity;
    chainLength -= 1;
  }

  function flushRun() {
    if (runCount === 0) return;
    visit({ start: runStart, end: runEnd, count: runCount });
    runStart = -1;
    runCount = 0;
  }

  function addToRun(start, end) {
    if (runCount > 0 && runEnd !== start) flushRun();
    if (!coalesce) {
      visit({ start, end, count: 1 });
      return;
    }
    if (runCount === 0) runStart = start;
    runEnd = end;
    runCount += 1;
  }

  function activePredecessor(startSequence) {
    let low = 0;
    let high = chainLength;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (chainStartSequences[chainSlot(middle)] <= startSequence) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }

  function considerOutputs(lengths, endSequence, endOffset) {
    let minimumStart = committedSequence;
    while (minimumStart < endSequence) {
      const length = longestOutputAtMost(lengths, endSequence - minimumStart);
      if (!length) return;
      const candidateStartSequence = endSequence - length;
      const candidateStart = starts[candidateStartSequence % plan.maxPatternLength];
      const predecessorIndex = activePredecessor(candidateStartSequence);
      if (predecessorIndex >= 0) {
        const predecessorSlot = chainSlot(predecessorIndex);
        const predecessorStart = chainStartSequences[predecessorSlot];
        if (candidateStartSequence === predecessorStart) {
          if (endSequence > chainEndSequences[predecessorSlot]) {
            setChain(
              predecessorIndex,
              candidateStartSequence,
              endSequence,
              candidateStart,
              endOffset
            );
            chainLength = predecessorIndex + 1;
          }
          return;
        }
        const predecessorEnd = chainEndSequences[predecessorSlot];
        if (candidateStartSequence < predecessorEnd) {
          minimumStart = predecessorEnd;
          continue;
        }
      }
      const insertionIndex = predecessorIndex + 1;
      setChain(insertionIndex, candidateStartSequence, endSequence, candidateStart, endOffset);
      chainLength = insertionIndex + 1;
      return;
    }
  }

  function commitMatches(endSequence, atEnd) {
    while (chainLength > 0) {
      const slot = chainHead;
      const startSequence = chainStartSequences[slot];
      if (!atEnd && endSequence - startSequence < plan.maxPatternLength) break;
      const matchEndSequence = chainEndSequences[slot];
      const matchStart = chainStarts[slot];
      const matchEnd = chainEnds[slot];
      dropChainHead();
      if (startSequence < committedSequence) continue;
      addToRun(matchStart, matchEnd);
      committedSequence = matchEndSequence;
      while (chainLength > 0 &&
             chainStartSequences[chainHead] < committedSequence) {
        dropChainHead();
      }
    }
  }

  for (const character of value) {
    starts[sequence % plan.maxPatternLength] = offset;
    state = advanceAutomaton(context, state, character);
    const endSequence = sequence + 1;
    const endOffset = offset + character.length;
    if (state.outputLengths.length > 0) {
      considerOutputs(state.outputLengths, endSequence, endOffset);
    }
    commitMatches(endSequence, false);
    sequence = endSequence;
    offset = endOffset;
  }
  commitMatches(sequence, true);
  flushRun();
}

function literalPlanMatches(plan, value) {
  if (plan.singleCharacterSearch) return plan.singleCharacterSearch.test(value);
  const context = createScanContext(plan);
  let state = plan.root;
  for (const character of value) {
    state = advanceAutomaton(context, state, character);
    if (state.outputLengths.length > 0) return true;
  }
  return false;
}

function literalPlanFirstPatternIndex(plan, value) {
  const context = createScanContext(plan);
  let state = plan.root;
  let minimum = -1;
  for (const character of value) {
    state = advanceAutomaton(context, state, character);
    const current = state.minimumOutputPatternIndex;
    if (current < 0 || (minimum >= 0 && current >= minimum)) continue;
    minimum = current;
    if (minimum === 0) return minimum;
  }
  return minimum;
}

function createLiteralFilter(patterns) {
  const plan = getLiteralAutomaton(patterns);
  if (!plan) {
    return Object.freeze({
      test: () => false,
      firstPatternIndex: () => -1,
      replace: (value) => value,
      extendBoundary: (value, boundary) => boundary
    });
  }

  return Object.freeze({
    test(value) {
      return literalPlanMatches(plan, value);
    },
    firstPatternIndex(value) {
      return literalPlanFirstPatternIndex(plan, value);
    },
    replace(value, replacement = FILTERED) {
      if (plan.maxPatternLength !== 1 && !literalPlanMatches(plan, value)) return value;
      if (plan.singleCharacterSearch && !plan.singleCharacterSearch.test(value)) return value;
      const replacementText = '' + replacement;
      const chunks = [];
      let buffered = '';
      let cursor = 0;

      function append(chunk) {
        if (!chunk) return;
        if (buffered && buffered.length + chunk.length > 65536) {
          chunks.push(buffered);
          buffered = '';
        }
        buffered += chunk;
        if (buffered.length >= 65536) {
          chunks.push(buffered);
          buffered = '';
        }
      }

      function appendReplacement(count) {
        if (!replacementText || count === 0) return;
        const perChunk = Math.max(1, Math.floor(65536 / replacementText.length));
        while (count > 0) {
          const repeats = Math.min(count, perChunk);
          append(replacementText.repeat(repeats));
          count -= repeats;
        }
      }

      const scan = plan.maxPatternLength === 1
        ? scanSingleCharacterMatches
        : scanLiteralMatches;
      scan(plan, value, (match) => {
        append(value.slice(cursor, match.start));
        appendReplacement(match.count);
        cursor = match.end;
      });
      if (cursor === 0) return value;
      append(value.slice(cursor));
      if (buffered) chunks.push(buffered);
      return chunks.length === 1 ? chunks[0] : chunks.join('');
    },
    extendBoundary(value, boundary) {
      if (boundary <= 0 || boundary >= value.length) return boundary;
      if (!literalPlanMatches(plan, value)) return boundary;
      let extended = boundary;
      scanLiteralMatches(plan, value, (match) => {
        if (match.start < extended) extended = Math.max(extended, match.end);
      }, false);
      return extended;
    }
  });
}
function createMasker(patterns) {
  const filter = createLiteralFilter(patterns);
  return (value) => filter.replace(value);
}

function maskText(value, patterns) {
  return createMasker(patterns)(value);
}

function applyInputFilters(body, snapshot) {
  const blocking = snapshotPatterns(snapshot, 'input_block_patterns');
  const masking = snapshotPatterns(snapshot, 'input_mask_patterns');
  const policyNamesByPattern = snapshotBlockPolicyNames(snapshot, blocking);
  if (blocking.length > 0) {
    const block = createLiteralFilter(blocking);
    let blockedPatternIndex = -1;
    let blocked;
    if (policyNamesByPattern === null) {
      blocked = forEachChatText(body, (target, field) => block.test(target[field]));
    } else {
      forEachChatText(body, (target, field) => {
        const current = block.firstPatternIndex(target[field]);
        if (current < 0 || (blockedPatternIndex >= 0 && current >= blockedPatternIndex)) return false;
        blockedPatternIndex = current;
        return blockedPatternIndex === 0;
      });
      blocked = blockedPatternIndex >= 0;
    }
    if (blocked) {
      const error = new ApiError(400, 'Request content was filtered', 'content_filtered');
      if (policyNamesByPattern) error.filterName = policyNamesByPattern[blockedPatternIndex];
      throw error;
    }
  }
  if (masking.length === 0) return body;

  const mask = createMasker(masking);
  let clone;
  try {
    clone = structuredClone(body);
  } catch {
    throw new ApiError(400, 'Request body cannot be filtered');
  }
  forEachChatText(clone, (target, field) => {
    target[field] = mask(target[field]);
  });
  return clone;
}

function applyOutputFilters(response, snapshot) {
  const masking = snapshotPatterns(snapshot, 'output_mask_patterns');
  if (masking.length === 0) return response;
  const mask = createMasker(masking);
  try {
    const clone = structuredClone(response);
    if (clone && typeof clone === 'object' && Array.isArray(clone.choices)) {
      for (const choice of clone.choices) {
        const message = choice && typeof choice === 'object' ? choice.message : null;
        if (message && typeof message === 'object' && typeof message.content === 'string') {
          message.content = mask(message.content);
        }
      }
    }
    return clone;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'Content filter processing failed', 'filter_processing_failed');
  }
}

function assertRequestSize(body) {
  let serialized;
  try {
    serialized = JSON.stringify(body);
    if (typeof serialized !== 'string') throw new Error('not serializable');
  } catch {
    throw new ApiError(400, 'Request body cannot be serialized');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
    throw new ApiError(413, 'Filtered request body exceeds the 1 MiB limit', 'request_too_large');
  }
}

module.exports = {
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
};
