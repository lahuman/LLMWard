const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  getRuleMetadata,
  validateRuleDefinitions,
  applyInputFilter,
  clearContext
} = require('../services/pii-filter');
const { ApiError } = require('../services/errors');

test('supported chat text is transformed without touching unsupported fields or the input', () => {
  const body = {
    messages: [
      { content: 'synthetic.user@example.test' },
      {
        content: [
          { type: 'text', text: '010-0000-0000' },
          { type: 'image_url', image_url: { url: 'synthetic.user@example.test' } },
          { type: 'input_audio', data: '010-0000-0000' }
        ],
        tool_calls: [{
          function: { arguments: '{"email":"synthetic.user@example.test"}' }
        }]
      }
    ],
    vendor_text: '010-0000-0000'
  };

  const result = applyInputFilter(body);

  assert.notEqual(result.body, body);
  assert.notEqual(result.context, null);
  assert.doesNotMatch(result.body.messages[0].content, /synthetic\.user/u);
  assert.doesNotMatch(result.body.messages[1].content[0].text, /010-0000/u);
  assert.equal(result.body.messages[1].content[1].image_url.url,
    'synthetic.user@example.test');
  assert.equal(result.body.messages[1].tool_calls[0].function.arguments,
    '{"email":"synthetic.user@example.test"}');
  assert.equal(result.body.vendor_text, '010-0000-0000');
  assert.equal(body.messages[0].content, 'synthetic.user@example.test');
});

test('no accepted match preserves the exact body identity and has no context', () => {
  const ordinary = { messages: [{ content: 'ordinary prose' }] };

  assert.deepEqual(applyInputFilter(ordinary), {
    body: ordinary,
    context: null
  });
});

test('rule definitions reject invalid declarations and normalize runtime faults', () => {
  for (const definitions of [
    [
      { id: 'duplicate', label: 'One', mode: 'restore', pattern: 'x' },
      { id: 'duplicate', label: 'Two', mode: 'restore', pattern: 'y' }
    ],
    [{ id: 'bad_mode', label: 'Bad', mode: 'mask', pattern: 'x' }],
    [{ id: 'bad_validator', label: 'Bad validator', mode: 'restore', pattern: 'x', validate: 'no' }],
    [{ id: 'bad_pattern', label: 'Bad', mode: 'restore', pattern: '[' }],
    [{ id: 'empty', label: 'Empty', mode: 'restore', pattern: '(?:)' }],
    [{ id: 'dot_star', label: 'Broad', mode: 'redact', pattern: '.*secret' }],
    [{ id: 'nested', label: 'Nested', mode: 'redact', pattern: '(a+)+$' }],
    [{ id: 'lookahead', label: 'Zero', mode: 'redact', pattern: '(?=z)' }],
    [{
      id: 'zero_span', label: 'Zero span', mode: 'redact',
      scan() { return [{ start: 0, end: 0 }]; }
    }],
    [{
      id: 'reverse_spans', label: 'Reverse', mode: 'redact',
      scan() { return [{ start: 1, end: 2 }, { start: 0, end: 1 }]; }
    }],
    [{ id: 'missing', label: 'Missing', mode: 'restore' }],
    [{
      id: 'both', label: 'Both', mode: 'restore', pattern: 'x',
      scan() { return []; }
    }]
  ]) {
    assert.throws(() => validateRuleDefinitions(definitions));
  }

  const runtimeFaults = [
    [{
      id: 'runtime_span', label: 'Runtime span', mode: 'redact',
      scan(text) {
        return text === 'candidate'
          ? [{ start: 1, end: 2 }, { start: 0, end: 1 }]
          : [];
      }
    }],
    [{
      id: 'runtime_verdict', label: 'Runtime verdict', mode: 'restore',
      pattern: 'candidate',
      validate() { return undefined; }
    }],
    [{
      id: 'runtime_throw', label: 'Runtime throw', mode: 'restore',
      pattern: 'candidate',
      validate() { throw new ApiError(500, 'private-marker'); }
    }]
  ];
  for (const definitions of runtimeFaults) {
    assert.throws(
      () => validateRuleDefinitions(definitions, 'candidate'),
      (error) => error.code === 'filter_processing_failed' &&
        !/private-marker/u.test(error.message)
    );
  }
});

test('rule metadata exposes only the deeply frozen ordered public fields', () => {
  const metadata = getRuleMetadata();

  assert.deepEqual(metadata.map(({ id, mode }) => [id, mode]), [
    ['kr_resident_registration_number', 'restore'],
    ['kr_foreigner_registration_number', 'restore'],
    ['payment_card_number', 'restore'],
    ['kr_phone_number', 'restore'],
    ['email_address', 'restore'],
    ['ipv4_address', 'restore']
  ]);
  assert.equal(Object.isFrozen(metadata), true);
  assert.ok(metadata.every(Object.isFrozen));
  assert.equal(JSON.stringify(metadata).includes('pattern'), false);
  assert.equal(JSON.stringify(metadata).includes('validator'), false);
});

const ASTRAL = '\u{1f9ea}';

function onlyToken(result) {
  const value = result.body.messages[0].content;
  const prefix = ASTRAL + ' ';
  const suffix = ' ' + ASTRAL;
  assert.equal(value.startsWith(prefix), true);
  assert.equal(value.endsWith(suffix), true);
  const token = value.slice(prefix.length, -suffix.length);
  const match = /^(\[\[LLMWARD:[0-9a-f]{32}:([^:]+):\d{6}\]\])$/u.exec(token);
  assert.notEqual(match, null);
  return { token: match[1], ruleId: match[2] };
}

function assertAccepted(value, ruleId) {
  const result = applyInputFilter({ messages: [{ content: `${ASTRAL} ${value} ${ASTRAL}` }] });
  assert.notEqual(result.context, null, value);
  const token = onlyToken(result);
  assert.equal(token.ruleId, ruleId, value);
  assert.equal(result.context.restoreByToken.get(token.token), value, value);
}

function assertRejected(value) {
  const body = { messages: [{ content: value }] };
  assert.deepEqual(applyInputFilter(body), { body, context: null }, value);
}

test('resident identifiers enforce dates, century digits, checksums, hyphens, and digit boundaries', () => {
  const residentAccepted = [
    '000229-3123456',
    '0002293123456',
    '991231-1000007',
    '991231-9123456',
    '991231-0000004',
    '991231-2000000',
    '991231-3000002',
    '991231-4000005'
  ];
  const residentRejected = [
    '000230-3123456',
    '000229-5123456',
    '000229-1000006',
    '000000-1000003',
    '991300-1000005',
    '1000229-3123456',
    '000229-31234567'
  ];

  for (const value of residentAccepted) {
    assertAccepted(value, 'kr_resident_registration_number');
  }
  for (const value of residentRejected) assertRejected(value);
});

test('foreigner identifiers enforce dates, century digits, checksum, and resident precedence', () => {
  const foreignerAccepted = [
    '000229-7020001',
    '991231-5020006',
    '991231-6020009',
    '000229-8020003'
  ];
  const foreignerRejected = [
    '000229-5020005',
    '000229-7020009',
    '000230-7020001',
    '1000229-7020001',
    '000229-70200010'
  ];

  for (const value of foreignerAccepted) {
    assertAccepted(value, 'kr_foreigner_registration_number');
  }
  for (const value of foreignerRejected) assertRejected(value);

  assertAccepted('000229-4020001', 'kr_resident_registration_number');
});

function luhnCard(length) {
  const prefix = '4'.repeat(length - 1);
  let sum = 0;
  for (let index = 0; index < prefix.length; index += 1) {
    let digit = Number(prefix[index]);
    if (index % 2 === length % 2) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return prefix + String((10 - (sum % 10)) % 10);
}

const everyCardLength = Array.from(
  { length: 7 },
  (_, index) => luhnCard(13 + index)
);
const invalidCardChecks = everyCardLength.map((value) =>
  value.slice(0, -1) + String((Number(value.at(-1)) + 1) % 10)
);

const LANDLINE_PREFIXES = [
  '02',
  '031', '032', '033',
  '041', '042', '043', '044',
  '051', '052', '053', '054', '055',
  '061', '062', '063', '064'
];
const acceptedLandlines = LANDLINE_PREFIXES.flatMap((prefix) => [
  prefix + '-000-0000',
  prefix + '-0000-0000'
]);

const domain253 = [
  'a'.repeat(63),
  'b'.repeat(63),
  'c'.repeat(63),
  'd'.repeat(61)
].join('.');
const acceptedEmailBoundaries = [
  'a'.repeat(64) + '@example.test',
  'user@' + 'a'.repeat(63) + '.test',
  'user@' + domain253
];
const rejectedEmailBoundaries = [
  'a'.repeat(65) + '@example.test',
  'user@' + 'a'.repeat(64) + '.test',
  'user@' + domain253 + 'x',
  'user.@example.test',
  'user@example-.test',
  'user@example..test',
  'user@example.test.'
];

const acceptedByRule = new Map([
  ['payment_card_number', [
    ...everyCardLength,
    '4242 4242 4242 4242',
    '4242-4242-4242-4242'
  ]],
  ['kr_phone_number', [
    ...acceptedLandlines,
    '010-0000-0000',
    '010 0000 0000',
    '01000000000',
    '02 0000 0000',
    '0200000000',
    '031 000 0000',
    '0310000000',
    '02-000-0000',
    '031-000-0000',
    '070-0000-0000'
  ]],
  ['email_address', [
    ...acceptedEmailBoundaries,
    'synthetic.user+tag@example.test'
  ]],
  ['ipv4_address', [
    '192.0.2.1',
    '198.51.100.42',
    '203.0.113.255'
  ]]
]);

test('card, phone, email, and IPv4 accepted fixtures preserve astral neighbors and exact claims', () => {
  for (const [ruleId, values] of acceptedByRule) {
    for (const value of values) assertAccepted(value, ruleId);
  }
});

test('card, phone, email, and IPv4 reject invalid checks, layouts, boundaries, URLs, and lookalikes', () => {
  const rejected = [
    ...invalidCardChecks,
    '0' + everyCardLength.at(-1),
    ...rejectedEmailBoundaries,
    everyCardLength.at(-1) + '0',
    '4242-4242 4242-4242',
    '4242-4242-4242-4242-',
    '4242 4242 4242 4243',
    '42-4242-4242-424242',
    '4242-42424242-4242',
    '011-000-0000',
    '016-000-0000',
    '017-000-0000',
    '018-000-0000',
    '019-000-0000',
    '050-0000-0000',
    '080-000-0000',
    '0505-000-0000',
    '1588-0000',
    '1600-0000',
    '1800-0000',
    '010--0000-0000',
    '010-0000-0000-',
    '0010-0000-0000',
    '010-0000 0000',
    '.user@example.test',
    'user..name@example.test',
    'a@b.c@d.e',
    'user@example',
    'user@-example.test',
    '256.0.0.1',
    '192.0.2.1.5',
    '1192.0.2.1',
    'http://192.0.2.1/path',
    '가상개인문맥',
    'host.192.0.2.1.example',
    'host.192.0.2.1.',
    '가상도 예시인 테스트로 1',
    'bank account 123-456-7890',
    'business registration 123-45-67890',
    'https://example.test/path',
    'US SSN 123-45-6789'
  ];

  for (const value of rejected) assertRejected(value);
});

test('ordered spans preserve text order, skip rejected candidates, and honor earlier overlap claims', () => {
  const invalidCard = '4242 4242 4242 4243';
  const mixed = [
    invalidCard,
    'synthetic.user+tag@example.test',
    '010-0000-0000',
    '4242 4242 4242 4242'
  ].join(' / ');
  const mixedResult = applyInputFilter({ messages: [{ content: mixed }] });
  const transformed = mixedResult.body.messages[0].content;
  assert.equal(transformed.includes(invalidCard), true);
  const ids = [
    ...transformed.matchAll(
      /\[\[LLMWARD:[0-9a-f]{32}:([^:]+):\d{6}\]\]/gu
    )
  ].map((match) => match[1]);
  assert.deepEqual(ids, [
    'email_address',
    'kr_phone_number',
    'payment_card_number'
  ]);

  const overlap = applyInputFilter({
    messages: [{ content: '010-0000-0000@example.test' }]
  }).body.messages[0].content;
  assert.match(overlap, /:kr_phone_number:/u);
  assert.doesNotMatch(overlap, /:email_address:/u);
});

function assertTransformationLimitAndCleanup(body) {
  const nativeMapClear = Map.prototype.clear;
  const nativeSetClear = Set.prototype.clear;
  let mapClears = 0;
  let setClears = 0;
  Map.prototype.clear = function observedMapClear() {
    mapClears += 1;
    return nativeMapClear.call(this);
  };
  Set.prototype.clear = function observedSetClear() {
    setClears += 1;
    return nativeSetClear.call(this);
  };
  try {
    assert.throws(() => applyInputFilter(body), (error) => {
      assert.equal(error.status, 413);
      assert.equal(error.code, 'request_too_large');
      assert.equal(error.message, 'PII transformation limit exceeded');
      return true;
    });
  } finally {
    Map.prototype.clear = nativeMapClear;
    Set.prototype.clear = nativeSetClear;
  }
  assert.equal(mapClears, 2);
  assert.equal(setClears, 1);
}

test('reuse returns one token per raw value while each request gets a fresh nonce', () => {
  const pii = 'synthetic.user@example.test';
  const first = applyInputFilter({
    messages: [{ content: `${pii} then ${pii}` }]
  });
  const tokens = [
    ...first.body.messages[0].content.matchAll(
      /\[\[LLMWARD:[0-9a-f]{32}:email_address:\d{6}\]\]/gu
    )
  ].map((match) => match[0]);
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0], tokens[1]);
  assert.equal(first.context.restoreByToken.size, 1);
  assert.equal(first.context.tokenByPii.size, 1);

  const second = applyInputFilter({ messages: [{ content: pii }] });
  assert.notEqual(first.context.nonce, second.context.nonce);
});

test('nonce collision retries once and uses the next collision-free prefix', () => {
  const nativeRandomBytes = crypto.randomBytes;
  const aa = 'aa'.repeat(16);
  const bb = 'bb'.repeat(16);
  let call = 0;
  crypto.randomBytes = () => Buffer.from(call++ === 0 ? aa : bb, 'hex');
  try {
    const result = applyInputFilter({
      messages: [{
        content: `existing [[LLMWARD:${aa}: marker synthetic.user@example.test`
      }]
    });
    assert.equal(result.context.nonce, bb);
    assert.match(result.body.messages[0].content, new RegExp(
      '\\\[\\\[LLMWARD:' + bb + ':email_address:',
      'u'
    ));
  } finally {
    crypto.randomBytes = nativeRandomBytes;
  }
});

test('collision limit fails closed after sixteen attempts without leaking input', () => {
  const nativeRandomBytes = crypto.randomBytes;
  const aa = 'aa'.repeat(16);
  let calls = 0;
  crypto.randomBytes = () => {
    calls += 1;
    return Buffer.from(aa, 'hex');
  };
  try {
    assert.throws(() => applyInputFilter({
      messages: [{
        content: `private-candidate [[LLMWARD:${aa}: synthetic.user@example.test`
      }]
    }), (error) => {
      assert.equal(error.status, 500);
      assert.equal(error.code, 'filter_processing_failed');
      assert.equal(error.message, 'Content filter processing failed');
      assert.doesNotMatch(error.message, /private-candidate/u);
      return true;
    });
  } finally {
    crypto.randomBytes = nativeRandomBytes;
  }
  assert.equal(calls, 16);
});

test('unique value limit throws safe 413 and clears both maps and the secret set', () => {
  const values = Array.from(
    { length: 201 },
    (_, index) => `u${String(index).padStart(3, '0')}@example.test`
  );
  assertTransformationLimitAndCleanup({
    messages: [{ content: values.join(' ') }]
  });
});

test('restorable byte limit counts every occurrence and clears partial context', () => {
  const value = 'synthetic.user@example.test';
  const count = Math.floor((64 * 1024) / Buffer.byteLength(value, 'utf8')) + 1;
  assertTransformationLimitAndCleanup({
    messages: [{ content: Array(count).fill(value).join(' ') }]
  });
});

function assertCleared(context) {
  assert.equal(context.restoreByToken.size, 0);
  assert.equal(context.tokenByPii.size, 0);
  assert.equal(context.secretTokens.size, 0);
  assert.equal(context.nonce, '');
  assert.equal(context.prefix, '');
  assert.equal(context.nextCounter, 0);
  assert.equal(context.restorableBytes, 0);
  assert.equal(context.cleared, true);
}

test('clear is null-safe, idempotent, and resets every collection and scalar', () => {
  const context = applyInputFilter({
    messages: [{ content: 'synthetic.user@example.test' }]
  }).context;
  context.secretTokens.add('secret-placeholder');

  clearContext(context);
  assertCleared(context);
  assert.doesNotThrow(() => clearContext(context));
  assert.doesNotThrow(() => clearContext(null));
});

test('clear replaces each collection whose clear method throws and still clears the others', () => {
  for (const [field, Type] of [
    ['restoreByToken', Map],
    ['tokenByPii', Map],
    ['secretTokens', Set]
  ]) {
    const context = applyInputFilter({
      messages: [{ content: 'synthetic.user@example.test' }]
    }).context;
    context.secretTokens.add('secret-placeholder');
    context[field].clear = () => { throw new Error('clear failed'); };

    assert.doesNotThrow(() => clearContext(context));

    assert.equal(context[field] instanceof Type, true);
    assertCleared(context);
  }
});

test('validator faults for actual candidates are normalized without marker or candidate leakage', () => {
  const marker = 'private-marker';
  const candidate = 'private-candidate';
  assert.throws(() => validateRuleDefinitions([{
    id: 'runtime_private',
    label: 'Runtime private',
    mode: 'restore',
    pattern: candidate,
    validate() { throw new ApiError(500, marker); }
  }], candidate), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.code, 'filter_processing_failed');
    assert.doesNotMatch(error.message, new RegExp(marker + '|' + candidate, 'u'));
    return true;
  });
});

function oneMiBNearMiss(fragment) {
  const size = 1024 * 1024;
  const repetitions = Math.floor((size - 1) / (fragment.length + 1));
  const candidates = Array(repetitions).fill(fragment).join(' ');
  return candidates + ' '.repeat(size - candidates.length);
}

const nonMatchMiBCases = new Map([
  ['all-x baseline', 'x'.repeat(1024 * 1024)],
  ['resident invalid dates', oneMiBNearMiss('000230-3123456')],
  ['foreigner invalid checksums', oneMiBNearMiss('000229-7020009')],
  ['card invalid Luhn checks', oneMiBNearMiss(invalidCardChecks.at(-1))],
  ['phone incomplete groups', oneMiBNearMiss('010-0000-000')],
  ['email oversized local and invalid domain',
    oneMiBNearMiss('a'.repeat(65) + '@invalid')],
  ['IPv4 invalid octets', oneMiBNearMiss('999.999.999.')]
]);

for (const [name, content] of nonMatchMiBCases) {
  test(`1 MiB ${name} preserves body identity with no context`, { timeout: 5000 }, () => {
    assert.equal(content.length, 1024 * 1024);
    const body = { messages: [{ content }] };
    const result = applyInputFilter(body);
    assert.equal(result.body, body);
    assert.equal(result.context, null);
  });
}
