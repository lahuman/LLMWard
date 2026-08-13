# Built-in Reversible Korean PII Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one globally switchable, code-defined Korean PII and secret filter that pseudonymizes supported request text before provider dispatch, restores only request-owned PII in responses, and never restores secrets.

**Architecture:** Keep rule detection and request-local transformation in a DB-free CommonJS service, and reuse one small shared chat-text traversal for the existing literal filter and the new service. Store only the exact activation flag in app_settings, add it to the immutable per-request filter snapshot, and compose restoration before the existing literal output mask in both JSON and strict SSE response paths.

**Tech Stack:** CommonJS, Node.js 22 standard library, Express 5, better-sqlite3, vanilla HTML/CSS/JavaScript, node:test

## Global Constraints

- Follow Ponytail Full: reuse current code and dependencies; add no plugin framework, policy DSL, Python, Presidio, NLP model, sidecar, Redis, or schema migration.
- The built-in filter is global and inactive by default. The sole setting is built_in_pii_filter_active with exact stored values 0 and 1; a missing row means disabled.
- Any other stored value fails closed as HTTP 500 filter_configuration_invalid before provider dispatch. A valid authenticated PUT can repair it.
- Keep existing content_filters rows, CRUD endpoints, response shapes, literal matching, and model assignments unchanged.
- Detect only messages[*].content strings and text parts whose type is text. Exclude tool/function arguments, images, audio, vendor fields, top-level strings, usage data, and arbitrary nested values.
- Preserve this order: authentication/model authorization, concurrency acquisition, immutable snapshot, literal input block, literal input mask, built-in transform, quota reservation, token clamp, 1 MiB transformed-body check, provider dispatch.
- Literal input block terminates the request. Built-in matches claim only their span; later rules skip claimed spans and scan every other unclaimed span.
- Run every secret rule before every PII rule.
- Resident numbers validate boundaries, date, and resident century/sex digit but not the obsolete checksum, so post-2020 random-tail numbers are protected.
- Foreigner numbers retain boundary, date, century/sex, and foreigner checksum validation.
- Every rule has one stable ID, label, restore/redact mode, and adjacent Korean comments describing protected data, accepted forms, validation, and deliberate exclusions.
- Admin metadata contains only id, label, and mode; never regex source, scanner code, validators, matches, or examples.
- Use bounded/linear scans at 1 MiB. Registry validation rejects empty matches, broad dot-star, and nested unbounded quantifiers.
- Placeholder form is [[LLMWARD:<32 lowercase hex nonce>:<rule_id>:<6-digit counter>]]. Generate the nonce from 16 random bytes and regenerate on supported-input prefix collision.
- Reuse the token for identical PII within one request; use a different nonce across requests.
- Secret context stores only placeholder tokens, never raw secrets, reversible hashes, secret-to-token maps, or cross-request state.
- Limit a context to 200 unique PII values and 64 KiB of total UTF-8 restorable match bytes, counting repeated occurrences. Exceeding either returns HTTP 413 request_too_large before dispatch.
- Context stays handler-local and is never attached to req, snapshot, error, logger, SQLite, cache, user, or module-global restoration storage.
- Clear maps, sets, counters, nonce, and byte counts either in the service error boundary before applyInputFilter throws or, after a context is returned, through the existing handler finally path on every exit.
- Non-stream output order is owned PII restoration, owned secret token to [FILTERED], then literal output masking.
- Unknown, fabricated, modified, truncated, or previous-request placeholders remain unchanged.
- This is provider-input risk reduction, not output DLP. Provider-generated raw PII/secrets stay unchanged unless a literal output rule masks them.
- Preserve byte-transparent SSE when neither a request context nor literal output patterns exist. Otherwise preserve strict SSE validation, 1 MiB event limit, usage, backpressure, abort, and fail-closed behavior.
- Never persist/log prompts, response bodies, matches, mappings, placeholders, provider error bodies, Authorization values, admin keys, or provider credentials.
- Use synthetic fixtures only. Add no dependency, lockfile change, migration, or unrelated refactor.
- No CSS change is planned; reuse existing card, checks, help, and badge styles.

---

## File Structure

**Create**

- services/chat-content.js -- exact supported request-text traversal shared by both filters.
- services/pii-filter.js -- registry, validators/scanners, span claims, context, JSON restoration, SSE carry, clearing.
- test/pii-filter.test.js -- detector, ordering, bounds, restoration, carry, and linear-scan tests.
- THIRD_PARTY_NOTICES.md -- inspiration attribution and MIT terms.

**Modify**

- services/content-filters.js -- shared traversal, activation snapshot, built-in admin read/update.
- routes/admin.js -- static authenticated built-in routes and failure-audit target.
- routes/v1.js -- input transform, non-stream restoration, SSE composition, finally clearing.
- public/admin-dashboard.html/js -- accessible card, state, safe render, toggle.
- test/content-filters.test.js, test/admin-filters.test.js, test/admin-dashboard.test.js.
- test/filter-runtime.test.js, test/filter-streaming.test.js, test/gateway.test.js, test/server.test.js.
- README.md, docs/API.md, docs/COMPATIBILITY.md, docs/THREAT_MODEL.md, CHANGELOG.md.

**Do not modify**

- package.json, package-lock.json, db/migrations.js, Dockerfile, or the SQLite schema.

---

### Task 1: Build the shared traversal and reversible PII core

**Files:**
- Create: services/chat-content.js
- Create: services/pii-filter.js
- Create: test/pii-filter.test.js
- Modify: services/content-filters.js
- Test: test/content-filters.test.js

**Interfaces:**
- Produces: forEachChatText(body, visit) -> boolean.
- Produces: getRuleMetadata() -> deeply frozen Array<{id,label,mode}>.
- Produces: validateRuleDefinitions(definitions, probeText?) -> void; the optional probe is a narrow unit-test path through the same runtime collector and never registers rules.
- Produces: applyInputFilter(body) -> {body,context}; no match returns the same body reference and null.
- Produces: clearContext(context) -> void; null-safe, idempotent, nonthrowing.
- Later tasks add secret rules and output restoration without changing these signatures.

- [ ] **Step 1: Write RED supported-field and identity tests**

Create test/pii-filter.test.js with:

~~~js
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

const ordinary = { messages: [{ content: 'ordinary prose' }] };
assert.deepEqual(applyInputFilter(ordinary), {
  body: ordinary,
  context: null
});
~~~

- [ ] **Step 2: Run traversal tests RED**

~~~powershell
node --test --test-name-pattern="supported chat text|no accepted match" test/pii-filter.test.js
~~~

Expected: FAIL because the new services do not exist.

- [ ] **Step 3: Extract the existing traversal exactly once**

Create services/chat-content.js:

~~~js
function forEachChatText(body, visit) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return false;
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') continue;
    if (typeof message.content === 'string') {
      if (visit(message, 'content')) return true;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part && typeof part === 'object' &&
          part.type === 'text' && typeof part.text === 'string') {
        if (visit(part, 'text')) return true;
      }
    }
  }
  return false;
}
module.exports = { forEachChatText };
~~~

Import it in services/content-filters.js, replace the two current calls, and delete only the old private traversal.

- [ ] **Step 4: Write RED registry validation and metadata tests**

~~~js
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
~~~

- [ ] **Step 5: Run registry tests RED**

~~~powershell
node --test --test-name-pattern="rule definitions|rule metadata" test/pii-filter.test.js
~~~

Expected: FAIL because validation and metadata are absent.

- [ ] **Step 6: Implement immutable trusted-source definitions**

Use exactly one pattern string or custom scan function:

Matcher contract:

~~~text
pattern: string XOR scan(text: string): Array<{start:number,end:number}>
validate?(value: string, context: {text:string,start:number,end:number}): boolean
~~~

Compile pattern sources with fresh gu flags per text. scan returns increasing, non-overlapping, end-exclusive UTF-16 code-unit offsets matching String.length and String.prototype.slice; code-point indexes are forbidden. validate receives the original text coordinates for URL and token-boundary checks.

Pattern matches and custom spans use safe-integer bounds with 0 <= start < end <= text.length. Reject malformed or out-of-order custom spans as filter_processing_failed; never silently skip a defective code-defined rule. At runtime, require validate(...) to return an exact boolean: false rejects the candidate, true accepts it, and any other value or throw becomes filter_processing_failed.

~~~js
const RULE_ID = /^[a-z][a-z0-9_]{0,63}$/u;
const MODES = new Set(['restore', 'redact']);

function validateScannedSpans(spans, textLength) {
  if (!Array.isArray(spans)) throw new Error('PII scan result must be an array');
  let previousEnd = 0;
  for (const span of spans) {
    if (!span || typeof span !== 'object' ||
        !Number.isSafeInteger(span.start) ||
        !Number.isSafeInteger(span.end) ||
        span.start < previousEnd ||
        span.start < 0 ||
        span.start >= span.end ||
        span.end > textLength) {
      throw new Error('PII scan result is invalid');
    }
    previousEnd = span.end;
  }
  return spans;
}

function validateRuleDefinitions(definitions, probeText) {
  if (!Array.isArray(definitions)) throw new Error('PII rules must be an array');
  const ids = new Set();
  for (const rule of definitions) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error('PII rule must be an object');
    }
    if (!RULE_ID.test(rule.id) || ids.has(rule.id)) {
      throw new Error('PII rule id is invalid or duplicated');
    }
    ids.add(rule.id);
    if (typeof rule.label !== 'string' || !rule.label.trim()) {
      throw new Error('PII rule label is invalid');
    }
    if (!MODES.has(rule.mode)) throw new Error('PII rule mode is invalid');
    const hasPattern = typeof rule.pattern === 'string';
    const hasScan = typeof rule.scan === 'function';
    if (hasPattern === hasScan) {
      throw new Error('PII rule needs exactly one matcher');
    }
    if (hasPattern) {
      if (/[?+*{]/u.test(rule.pattern)) {
        throw new Error('PII rule pattern must use fixed-width alternatives');
      }
      if (/\\[bBAZzG]|\\[dDsSwWpP]|[\^$]/u.test(rule.pattern)) {
        throw new Error('PII rule pattern cannot contain assertions or classes');
      }
      let matcher;
      try {
        matcher = new RegExp(rule.pattern, 'gu');
      } catch {
        throw new Error('PII rule pattern is invalid');
      }
      for (const probe of ['', 'x', '0', ' ', '\n']) {
        const match = matcher.exec(probe);
        matcher.lastIndex = 0;
        if (match && match[0].length === 0) {
          throw new Error('PII rule pattern can match empty text');
        }
      }
    } else {
      for (const probe of ['', 'x', '0', ' ']) {
        validateScannedSpans(rule.scan(probe), probe.length);
      }
    }
    if (rule.validate !== undefined &&
        typeof rule.validate !== 'function') {
      throw new Error('PII rule validator is invalid');
    }
  }
  if (probeText !== undefined) {
    if (typeof probeText !== 'string') {
      throw new Error('PII rule probe must be a string');
    }
    try {
      collectClaims(definitions, probeText);
    } catch {
      throw new ApiError(
        500,
        'Content filter processing failed',
        'filter_processing_failed'
      );
    }
  }
}
validateRuleDefinitions(RULES);
for (const rule of RULES) Object.freeze(rule);
Object.freeze(RULES);
const RULE_METADATA = Object.freeze(RULES.map((rule) => Object.freeze({
  id: rule.id,
  label: rule.label,
  mode: rule.mode
})));

function getRuleMetadata() {
  return RULE_METADATA;
}
~~~

Store source strings, never shared RegExp instances. Compile a new global Unicode matcher for each request scan.
Keep collectClaims(definitions, text) module-private. applyInputFilter calls it with immutable RULES; the optional validateRuleDefinitions probe calls the same collector only to fault-inject test definitions. It neither replaces nor appends RULES and is not a registration API.

- [ ] **Step 7: Write RED Korean identifier fixtures**

Use algorithmically constructed synthetic values:

~~~js
const residentAccepted = [
  '000229-3123456', // post-2020 shape; deliberately fails legacy checksum
  '0002293123456',
  '991231-1000007',
  '991231-9123456'
];
const residentRejected = [
  '000230-3123456',
  '000229-5123456',
  '1000229-3123456',
  '000229-31234567'
];
const foreignerAccepted = [
  '000229-7020001',
  '991231-5020006'
];
const foreignerRejected = [
  '000229-5020005',
  '000229-7020009'
];

for (const value of residentAccepted.concat(foreignerAccepted)) {
  const result = applyInputFilter({ messages: [{ content: value }] });
  assert.notEqual(result.context, null);
  assert.match(result.body.messages[0].content, /^\[\[LLMWARD:/u);
}
for (const value of residentRejected.concat(foreignerRejected)) {
  const input = { messages: [{ content: value }] };
  assert.deepEqual(applyInputFilter(input), {
    body: input,
    context: null
  });
}

const residentNotForeigner = applyInputFilter({
  messages: [{ content: '000229-4020001' }]
});
assert.match(
  residentNotForeigner.body.messages[0].content,
  /:kr_resident_registration_number:/u
);
assert.doesNotMatch(residentNotForeigner.body.messages[0].content, /:kr_foreigner_registration_number:/u);
~~~

Add explicit cases for valid 2000 leap day, invalid 1900 leap day, month/day zero, optional hyphen, resident century digits 0/9/1/2/3/4, foreigner digits 5/6/7/8, and adjacent digit rejection.

- [ ] **Step 8: Write RED card, phone, email, and IPv4 fixtures**

~~~js
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
  value.slice(0, -1) +
    String((Number(value.at(-1)) + 1) % 10)
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



const accepted = [
  ...everyCardLength,
  ...acceptedLandlines,
  ...acceptedEmailBoundaries,
  '4242 4242 4242 4242',
  '4242-4242-4242-4242',
  '010-0000-0000',
  '010 0000 0000',
  '01000000000',
  '02 0000 0000',
  '0200000000',
  '031 000 0000',
  '0310000000',
  '02-000-0000',
  '031-000-0000',
  '070-0000-0000',
  'synthetic.user+tag@example.test',
  '192.0.2.1',
  '198.51.100.42',
  '203.0.113.255'
];
const rejected = [
  ...invalidCardChecks,
  '0' + everyCardLength.at(-1),
  ...rejectedEmailBoundaries,
  everyCardLength.at(-1) + '0',
  '4242-4242 4242-4242',
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
  'user@example',
  'user@-example.test',
  '256.0.0.1',
  '192.0.2.1.5',
  '1192.0.2.1',
  'http://192.0.2.1/path',
  '가상인물명',
  'host.192.0.2.1.example',
  'host.192.0.2.1.',
  '가상도 예시시 테스트로 1',
  'bank account 123-456-7890',
  'business registration 123-45-67890',
  'https://example.test/path',
  'US SSN 123-45-6789'
];
~~~

For each accepted value, surround it with '🙂 ' and ' 🙂', assert both astral characters remain byte-for-byte, and assert exactly one complete placeholder claims only the value. For each rejected value, assert original body identity and null context.

- [ ] **Step 9: Run detector tests RED**

~~~powershell
node --test --test-name-pattern="resident|foreigner|card|phone|email|IPv4" test/pii-filter.test.js
~~~

Expected: FAIL because scanners and validators are absent.

- [ ] **Step 10: Implement the six PII rules with adjacent Korean comments**

Use final PII order: resident, foreigner, card, phone, email, IPv4. Put rule-specific comments immediately above each rule. The resident comment must be:

~~~js
// 한국 주민등록번호: YYMMDD 뒤 주민 구분 숫자(0~4, 9)와 임의 6자리를 보호한다.
// 하이픈은 생년월일 뒤 한 개만 허용하고 실제 날짜와 숫자 경계를 검증한다.
// 2020-10-12 이후 뒤 6자리는 임의값이므로 구형 체크섬은 요구하지 않는다.

// 외국인등록번호: YYMMDD 뒤 외국인 구분 숫자(5~8)와 나머지 숫자를 보호한다.
// 하이픈 유무, 실제 날짜, 숫자 경계와 외국인등록번호 체크섬을 검증한다.
// 주민등록번호 체크섬과 인터넷에서 복사된 중간 숫자 짝수 조건은 사용하지 않는다.

// 결제 카드번호: 13~19자리 숫자와 일관된 공백 또는 하이픈 구분 형식을 보호한다.
// 숫자 경계와 Luhn 체크섬을 검증하고 혼합 구분자와 잘못된 체크섬은 제외한다.

// 한국 전화번호: 010, 02, 유효 지역번호와 070 번호를 연속/공백/하이픈 형식으로 보호한다.
// 그룹 길이와 일관된 구분자를 검증하고 구형 이동전화, 050x, 080, 대표번호는 제외한다.

// 이메일 주소: 보수적인 ASCII 로컬파트와 점이 포함된 도메인 형식을 보호한다.
// 로컬파트/도메인 길이와 점·하이픈 경계를 검증하고 전체 RFC 구문과 URL은 지원하지 않는다.

// IPv4 주소: 점으로 구분된 정확히 네 개의 10진수 옥텟을 보호한다.
// 각 옥텟 0~255와 숫자·점 경계를 검증하고 URL 내부 주소와 호스트명은 제외한다.
~~~

Use explicit maps:

~~~js
const RESIDENT_CENTURY = new Map([
  ['0', 1800], ['9', 1800],
  ['1', 1900], ['2', 1900],
  ['3', 2000], ['4', 2000]
]);
const FOREIGNER_CENTURY = new Map([
  ['5', 1900], ['6', 1900],
  ['7', 2000], ['8', 2000]
]);
~~~

Round-trip year/month/day using UTC components. Foreigner checksum uses weights 2,3,4,5,6,7,8,9,2,3,4,5 and:

~~~js
const expected = (11 - (sum % 11) + 2) % 10;
~~~

Do not add the copied middle-pair parity condition.

Card candidates accept contiguous 13-19 digits, plus the explicitly supported 16-digit 4-4-4-4 layout with either all spaces or all hyphens; reject every other grouping even when the underlying digits pass Luhn. Require digit boundaries and Luhn validation. Phone accepts only 010, 02, 031, 032, 033, 041, 042, 043, 044, 051, 052, 053, 054, 055, 061, 062, 063, 064, 070; require no separator or the same separator throughout. Email local part is 1-64 ASCII characters and domain at most 253 ASCII characters; reject leading/trailing/repeated local dots and domain-label edge hyphens. IPv4 requires four decimal octets 0-255 and rejects multi-digit leading zeros.

- [ ] **Step 11: Write RED ordered-span and overlap tests**

~~~js
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
~~~

This proves multiple rule families transform in text order, a validator-rejected candidate claims nothing, later rules continue scanning, and later rules skip an accepted prior span. Task 2 adds the secret-versus-card priority overlap.

- [ ] **Step 12: Implement ordered claimed spans**

For each text:

1. Keep claims sorted by start/end.
2. For each ordered rule, scan the original text with a fresh matcher.
3. Walk prior claims with a monotonic index; skip overlapping candidates before validation.
4. Call validate on the actual candidate inside the service error boundary. Exact false claims nothing; exact true accepts; a throw or non-boolean return becomes generic filter_processing_failed and never continues scanning.
5. Merge accepted same-rule candidates into claims in linear time.
6. After all rules finish collecting original-text coordinates, transform the text once from the final sorted claims.

Do not insert each claim into an array individually; that would become quadratic with many secret matches in Task 2.

- [ ] **Step 13: Write RED reuse, collision, limit, and clear tests**

- Put one email twice in a request and assert equal tokens.
- Repeat the same request and assert a different nonce.
- Stub crypto.randomBytes: first return 16 aa bytes, then 16 bb bytes. Put the aa prefix in supported input and assert the emitted token uses bb.
- Stub crypto.randomBytes to return colliding aa bytes for every call; require a generic filter_processing_failed error after 16 attempts rather than an unbounded loop.
- Put u000@example.test through u200@example.test in one supported string; require the 201st unique value to return status 413/code request_too_large.
- Build Array(count).fill('synthetic.user@example.test').join(' ') until accepted restorable occurrence bytes exceed 65536 while unique count stays one; require the same 413.
- Instrument Map.prototype.clear and Set.prototype.clear only around each 413 call; require both restoration maps and the secret set to be cleared before the original request_too_large ApiError is rethrown, then restore the native methods in finally.
- After clearContext, require all three collections empty, nonce/prefix empty, nextCounter/restorableBytes zero, and cleared true. A second clear and clearContext(null) must not throw.
- Replace restoreByToken.clear with a throwing stub and require clearContext to replace that field with a new empty Map while still clearing tokenByPii and secretTokens and resetting all scalars. Repeat for each collection field. No collection that can hold raw PII or a placeholder may remain populated merely because its clear method threw.

- [ ] **Step 14: Add RED 1 MiB non-match regression**

Build one 1 MiB near-miss per scanner family, not only an all-`x` string:

- invalid-date resident numbers;
- invalid-checksum foreigner numbers;
- Luhn-failing 13-19 digit runs;
- incomplete allowed phone prefixes/groups;
- a 65-character email local part with an invalid domain;
- repeated `999.999.999.` IPv4 lookalikes.

Separate candidates with spaces so each intended near-miss is actually scanned. For every case use a 5000 ms timeout and require the exact original body reference plus null context. Keep an all-`x` case as the cheap baseline.

- [ ] **Step 15: Run context and bound tests RED**

~~~powershell
node --test --test-name-pattern="ordered spans|reuse|collision|limit|clear|1 MiB" test/pii-filter.test.js
~~~

Expected: FAIL because request context transformation and limits are absent.

- [ ] **Step 16: Implement collision-safe request context and transformation**

~~~js
function createContext(textValues) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const prefix = '[[LLMWARD:' + nonce + ':';
    if (!textValues.some((value) => value.includes(prefix))) {
      return {
        nonce,
        prefix,
        nextCounter: 1,
        restoreByToken: new Map(),
        tokenByPii: new Map(),
        secretTokens: new Set(),
        restorableBytes: 0,
        cleared: false
      };
    }
  }
  throw new Error('placeholder nonce collision limit');
}

function clearContext(context) {
  if (!context || context.cleared) return;
  const fields = [
    ['restoreByToken', Map],
    ['tokenByPii', Map],
    ['secretTokens', Set]
  ];
  let cleared = true;
  for (const [field, Type] of fields) {
    try {
      context[field].clear();
    } catch {
      try {
        context[field] = new Type();
      } catch {
        cleared = false;
      }
    }
  }
  try { context.nonce = ''; } catch {}
  try { context.prefix = ''; } catch {}
  try { context.nextCounter = 0; } catch {}
  try { context.restorableBytes = 0; } catch {}
  try { context.cleared = cleared; } catch {}
}
~~~

Create context only after the first accepted claim. Before every restore-mode occurrence, add Buffer.byteLength(value, 'utf8') and reject totals over 64 * 1024. Before a new tokenByPii key, reject size 200. Use ApiError(413, 'PII transformation limit exceeded', 'request_too_large').

Reuse tokenByPii for identical raw PII. Format counters with padStart(6, '0'); reject a counter above 999999 with request_too_large.
Key tokenByPii by the exact raw string only, not by rule ID. If one value could satisfy more than one category, the first accepted rule in immutable order owns the token ID and later rules skip its claimed spans.

Declare `let context = null` before one service-level try that covers scanning, candidate validation, context creation, transformation, cloning, and assignment. Compute transformed strings first, structuredClone the body exactly once, then assign the transformed strings through forEachChatText in traversal order. Use this catch:

~~~js
} catch (error) {
  clearContext(context);
  if (error instanceof ApiError &&
      error.status === 413 &&
      error.code === 'request_too_large') {
    throw error;
  }
  throw new ApiError(
    500,
    'Content filter processing failed',
    'filter_processing_failed'
  );
}
~~~

This clears partial context before every throw, including request_too_large. An unmatched private-key or validator/scanner error before context creation still crosses the same boundary and calls clearContext(null), which is a no-op. Preserve only the service's exact safe 413/request_too_large; normalize every other thrown value, including an ApiError from a scanner/validator whose message might contain matched data, to fixed 500/filter_processing_failed. Add a validator that throws ApiError(500, privateMarker) for an actual candidate and require the thrown/HTTP error message and JSON to contain neither marker nor candidate.

Export the Task 1 surface explicitly:

~~~js
module.exports = {
  getRuleMetadata,
  validateRuleDefinitions,
  applyInputFilter,
  clearContext
};
~~~


- [ ] **Step 17: Run Task 1 GREEN and commit**

~~~powershell
node --test test/pii-filter.test.js test/content-filters.test.js
git add services/chat-content.js services/pii-filter.js services/content-filters.js test/pii-filter.test.js test/content-filters.test.js
git commit -m "feat: add reversible Korean PII core"
~~~

Expected before commit: zero failures.

---

### Task 2: Add irreversible secrets and exact output restoration

**Files:**
- Modify: services/pii-filter.js
- Modify: test/pii-filter.test.js

**Interfaces:**
- Preserves Task 1 signatures.
- Produces: applyOutputFilter(response, context) -> response.
- Produces: createRestorationCarry(context) -> {push(text),flush()}.
- Secret context holds placeholder tokens only.

- [ ] **Step 1: Write RED fixed-prefix secret tests**

Construct fixtures:

~~~js
const secrets = [
  'sk-proj-' + 'A'.repeat(20),
  'sk-' + 'B'.repeat(20),
  'sk-ant-' + 'C'.repeat(20),
  'AKIA' + 'D'.repeat(16),
  'ghp_' + 'e'.repeat(20),
  'gho_' + 'f'.repeat(20),
  'ghu_' + 'g'.repeat(20),
  'ghs_' + 'h'.repeat(20),
  'ghr_' + 'i'.repeat(20),
  'github_pat_' + 'j'.repeat(20),
  'xoxb-' + '1'.repeat(20),
  'xoxa-' + '2'.repeat(20),
  'xoxp-' + '3'.repeat(20),
  'xoxr-' + '4'.repeat(20),
  'xoxs-' + '5'.repeat(20),
  'https://hooks.slack.com/services/T00000000/B00000000/' +
    'a'.repeat(24),
  'sk_live_' + 'L'.repeat(16),
  'sk_test_' + 'T'.repeat(16),
  'rk_live_' + 'R'.repeat(16),
  'rk_test_' + 'Q'.repeat(16),
  'AIza' + 'A'.repeat(35)
];
~~~

Drive the fixtures and scanners from these exact code-defined grammars:

- OpenAI `sk-proj-` and generic `sk-`: 20-256 suffix characters from `[A-Za-z0-9_-]`; generic `sk-` excludes the Anthropic and Stripe prefixes.
- Anthropic `sk-ant-`: 20-256 suffix characters from `[A-Za-z0-9_-]`.
- AWS `AKIA`: exactly 16 suffix characters from `[A-Z0-9]`.
- GitHub `ghp_/gho_/ghu_/ghs_/ghr_/github_pat_`: 20-255 suffix characters from `[A-Za-z0-9_]`.
- Slack `xoxb-/xoxa-/xoxp-/xoxr-/xoxs-`: 20-255 suffix characters from `[A-Za-z0-9-]`.
- Slack webhook: HTTPS host exactly `hooks.slack.com`, then three path segments from `[A-Za-z0-9_-]` with lengths 8-64, 8-64, and 20-255.
- Stripe `sk_live_/sk_test_/rk_live_/rk_test_`: 16-255 suffix characters from `[A-Za-z0-9]`.
- Google `AIza`: exactly 35 suffix characters from `[A-Za-z0-9_-]`.

For token families, a preceding or following character from that family's suffix class invalidates a partial match. Keep these constants beside the rule comments so later edits change one reviewed definition and its generated boundary fixtures together.

For every family test exact minimum, one character short, invalid internal character, and adjacent allowed token character. Accepted raw strings must be absent from transformed text. Add a Stripe token whose suffix is also Luhn-valid and assert its placeholder contains the Stripe rule ID, proving secret precedence over card.

Generic secret-like text is deliberately outside this filter:

~~~js
const genericSecretLikeText = [
  'password=synthetic-value',
  'Authorization: Bearer synthetic-oauth-token',
  'client_id=synthetic.apps.example.test',
  'https://synthetic-project.firebaseio.com'
];
~~~

For each generic value, require the exact original body reference and null context. Do not add password assignments, generic bearer tokens, OAuth client IDs, or Firebase URLs to the built-in registry.


- [ ] **Step 2: Write RED private-key tests**

~~~js
const encoded = Buffer.from('synthetic fixture only').toString('base64');
const pem = [
  '-----BEGIN PRIVATE KEY-----',
  encoded,
  '-----END PRIVATE KEY-----'
].join('\n');
const pgp = [
  '-----BEGIN PGP PRIVATE KEY BLOCK-----',
  '',
  encoded,
  '=AAAA',
  '-----END PGP PRIVATE KEY BLOCK-----'
].join('\n');
~~~

Require complete PRIVATE KEY, ENCRYPTED PRIVATE KEY, RSA PRIVATE KEY, EC PRIVATE KEY, OPENSSH PRIVATE KEY, DSA PRIVATE KEY, and PGP PRIVATE KEY BLOCK spans to become one placeholder. Missing end or mismatched end returns HTTP 500/filter_processing_failed without a transformed body.
Run complete, missing-end, and mismatched-end fixtures with both LF and CRLF. BEGIN and END markers must occupy the whole ASCII line with only the CR from CRLF allowed after the final hyphen; `prefix-----BEGIN...` and `-----END...suffix` are not markers. A successful claim starts at the BEGIN line's first hyphen and ends at the matching END line's last hyphen, leaving surrounding line endings unchanged.

- [ ] **Step 3: Write RED secret-retention invariant test**

~~~js
const result = applyInputFilter({
  messages: [{ content: rawSecret }]
});
assert.equal(result.context.restoreByToken.size, 0);
assert.equal(result.context.tokenByPii.size, 0);
assert.equal(result.context.secretTokens.size, 1);
for (const token of result.context.secretTokens) {
  assert.match(token, /^\[\[LLMWARD:/u);
  assert.equal(token.includes(rawSecret), false);
}
~~~

Require the transformed supported text not to contain rawSecret. Context may retain only the generated secret placeholder, never the raw value or its digest.
Put the same synthetic secret in two separated occurrences and require two different placeholders, secretTokens.size === 2, and two `[FILTERED]` values after output transformation. Serialization of the context must contain neither raw occurrence nor a digest of it.

- [ ] **Step 4: Write RED unmatched-key 1 MiB regression**

Use a recognized begin line plus near-limit synthetic base64 characters and no end. Require generic HTTP 500/filter_processing_failed within a 5000 ms test timeout, and require the error text not to contain the body.
Also build a separated 1 MiB near-miss for every fixed-prefix family from its one-character-short suffix, plus whole-line PEM/PGP marker lookalikes. Each must finish within 5000 ms with the exact input body and null context. In the route suite, keep the existing maximum-density valid-secret case that expands beyond the transformed 1 MiB request limit and require request_too_large with full cleanup.

- [ ] **Step 5: Run secret tests RED**

~~~powershell
node --test --test-name-pattern="secret|private-key|precedence" test/pii-filter.test.js
~~~

Expected: FAIL because secret rules are absent.

- [ ] **Step 6: Implement secret rules before all PII rules**

Each rule gets adjacent Korean comments. The OpenAI rule comment is:

~~~js
// 개인키 블록: 지원하는 PEM/PGP BEGIN과 동일 라벨 END 사이 전체 블록을 제거한다.
// BEGIN만 있거나 END 라벨이 다르면 본문 일부가 노출되지 않도록 요청을 실패시킨다.

// OpenAI 비밀키: sk-proj- 또는 일반 sk- 뒤의 충분히 긴 토큰만 제거한다.
// 짧은 예시와 Stripe/Anthropic 전용 접두사는 제외하고 토큰 경계를 검증한다.

// Anthropic 비밀키: sk-ant- 뒤 20자 이상인 고유 토큰만 제거한다.
// 짧은 예시와 토큰 일부 일치는 제외한다.

// AWS 액세스 키 ID: AKIA 뒤 대문자 영숫자 16자리 전체만 제거한다.
// 길거나 짧은 부분 문자열과 소문자 변형은 제외한다.

// GitHub 토큰: 승인된 ghp/gho/ghu/ghs/ghr/github_pat 접두사 토큰을 제거한다.
// 접두사 뒤 20자 이상과 토큰 경계를 검증한다.

// Slack 토큰: 승인된 xoxb/xoxa/xoxp/xoxr/xoxs 접두사 토큰을 제거한다.
// 짧은 예시와 지원하지 않는 xox 접두사는 제외한다.

// Slack 웹훅: hooks.slack.com/services의 완전한 세 경로 세그먼트 URL을 제거한다.
// 불완전한 URL과 다른 호스트의 유사 경로는 제외한다.

// Stripe 비밀키: sk_live/sk_test/rk_live/rk_test 뒤 16자 이상 전체를 제거한다.
// 공개키와 짧은 예시는 제외하고 전용 접두사와 토큰 경계를 검증한다.

// Google API 키: AIza 뒤 허용 문자 정확히 35자리인 키 전체를 제거한다.
// 한 글자 짧거나 긴 부분 일치와 토큰 내부 일치는 제외한다.

// 모든 비밀 원문은 복원 맵에 저장하지 않고 요청 전용 토큰만 secretTokens에 기록한다.
~~~

Add bounded rules for OpenAI, Anthropic, AWS, GitHub, Slack tokens, Slack webhook, Stripe, and Google. Boundary validation must not accept a valid prefix of a longer token. Generic OpenAI explicitly excludes Anthropic/Stripe families.

Update the metadata test to the final stable order and labels in the same change:

~~~js
assert.deepEqual(getRuleMetadata().map(({ id, label, mode }) => ({ id, label, mode })), [
  { id: 'private_key', label: 'Private Key Block', mode: 'redact' },
  { id: 'openai_api_key', label: 'OpenAI API Key', mode: 'redact' },
  { id: 'anthropic_api_key', label: 'Anthropic API Key', mode: 'redact' },
  { id: 'aws_access_key_id', label: 'AWS Access Key ID', mode: 'redact' },
  { id: 'github_token', label: 'GitHub Token', mode: 'redact' },
  { id: 'slack_token', label: 'Slack Token', mode: 'redact' },
  { id: 'slack_webhook', label: 'Slack Webhook', mode: 'redact' },
  { id: 'stripe_secret_key', label: 'Stripe Secret or Restricted Key', mode: 'redact' },
  { id: 'google_api_key', label: 'Google API Key', mode: 'redact' },
  { id: 'kr_resident_registration_number', label: 'Korean Resident Registration Number', mode: 'restore' },
  { id: 'kr_foreigner_registration_number', label: 'Korean Foreigner Registration Number', mode: 'restore' },
  { id: 'payment_card_number', label: 'Payment Card Number', mode: 'restore' },
  { id: 'kr_phone_number', label: 'Korean Phone Number', mode: 'restore' },
  { id: 'email_address', label: 'Email Address', mode: 'restore' },
  { id: 'ipv4_address', label: 'IPv4 Address', mode: 'restore' }
]);
~~~


Scan private-key blocks linearly: find the first recognized begin line, search forward once for its exact matching end line, fail if absent or a different recognized end appears first, claim through the matching end line, then continue after it. Never use dot-star or restart from each inner marker.
Treat only exact whole-line ASCII markers as recognized, support LF and CRLF without absorbing either surrounding line ending, and preserve every byte outside the claimed block.

Generate a distinct placeholder for each secret occurrence. Add only the placeholder to secretTokens; never add raw secret data or a digest map to context.
- [ ] **Step 7: Run secret input tests GREEN**

~~~powershell
node --test --test-name-pattern="secret|private-key|precedence|secret-retention|unmatched-key" test/pii-filter.test.js
~~~

Expected: zero failures before output restoration work begins.


- [ ] **Step 8: Write RED JSON restoration tests**

~~~js
const providerResponse = {
  choices: [{
    index: 0,
    message: {
      content: piiToken + ' / ' + secretToken +
        ' / [[LLMWARD:ffffffffffffffffffffffffffffffff:email_address:000001]]',
      tool_calls: [{ function: { arguments: piiToken } }]
    }
  }],
  vendor: piiToken
};
const restored = applyOutputFilter(providerResponse, context);
assert.equal(restored.choices[0].message.content,
  originalPii + ' / [FILTERED] / ' +
  '[[LLMWARD:ffffffffffffffffffffffffffffffff:email_address:000001]]');
assert.equal(restored.choices[0].message.tool_calls[0].function.arguments,
  piiToken);
assert.equal(restored.vendor, piiToken);
assert.equal(providerResponse.choices[0].message.content.includes(piiToken),
  true);
~~~

Also require modified owned tokens and a token from another request unchanged. A provider-generated raw resident number absent from the request stays raw. Passing the original raw secret through applyOutputFilter must leave it unchanged, proving there is no raw-secret output DLP.
For non-stream responses, choices that is not an array, null choices, absent messages, and null/non-string content remain unchanged, matching the existing literal filter's optional-field behavior; only cloning or an actual restoration failure becomes 502.

- [ ] **Step 9: Write RED carry tests at every split**

~~~js
for (let split = 0; split <= token.length; split += 1) {
  const carry = createRestorationCarry(context);
  const output = carry.push(token.slice(0, split)) +
    carry.push(token.slice(split)) +
    carry.flush();
  assert.equal(output, expected);
  assert.equal(carry.flush(), '');
}
~~~

Run for a PII token and secret token. Add multiple tokens, prefix split, fabricated complete token, and incomplete EOF token; unknown/partial values remain exact.
Push one approximately 1 MiB ordinary/fake-prefix string in a single call, then flush. Require exact reconstruction, completion within 5000 ms, and first-push output length at least input length minus 115 code units. This proves the carry retains at most the longest possible token prefix and does not rescan an ever-growing buffer.

- [ ] **Step 10: Run restoration tests RED**

~~~powershell
node --test --test-name-pattern="output restoration|restoration carry" test/pii-filter.test.js
~~~

Expected: FAIL because output APIs are absent.

- [ ] **Step 11: Implement exact token restoration without dynamic regex**

Set MAX_PLACEHOLDER_LENGTH to 116 ASCII code units: 10 for [[LLMWARD:, 32 nonce hex, two separator colons, at most 64 rule-ID characters, 6 counter digits, and 2 closing brackets. Use context.prefix to find candidates, emit ordinary text before it immediately, and search no farther than that bound for ]]. For a complete grammar-valid candidate:

- restore context.restoreByToken.get(candidate) when owned;
- emit [FILTERED] when context.secretTokens has it;
- otherwise emit candidate unchanged.

Streaming push retains only the longest suffix that prefixes context.prefix, or a full prefix followed by an incomplete grammar-bounded token. If an incomplete token exceeds maximum grammar length, emit its first character and resume. flush emits carry unchanged, empties it, and is idempotent.

applyOutputFilter returns the same response when context is null. Otherwise structuredClone once and transform only choices[*].message.content strings. Unexpected failures become ApiError(502, 'Content filter processing failed', 'filter_processing_failed').

Replace the Task 1 export with the final DB-free service surface:

~~~js
module.exports = {
  getRuleMetadata,
  validateRuleDefinitions,
  applyInputFilter,
  applyOutputFilter,
  createRestorationCarry,
  clearContext
};
~~~


- [ ] **Step 12: Run Task 2 GREEN and commit**

~~~powershell
node --test test/pii-filter.test.js
git add services/pii-filter.js test/pii-filter.test.js
git commit -m "feat: redact request-owned secrets"
~~~

Expected before commit: zero failures.

---

### Task 3: Persist activation and expose authenticated administration

**Files:**
- Modify: services/content-filters.js
- Modify: routes/admin.js
- Modify: test/content-filters.test.js
- Modify: test/admin-filters.test.js

**Interfaces:**
- Produces: snapshot.built_in_pii_filter_active boolean.
- Produces: getBuiltInPiiFilter() and setBuiltInPiiFilter(input).
- Produces: GET and PUT /admin/filters/built-in-pii.
- Response: {id,name,is_active,is_global,rules}.

- [ ] **Step 1: Write RED snapshot setting tests**

In test/content-filters.test.js require:

Extend the hand-built test schema before requiring the service, and clear the row in beforeEach:

~~~sql
CREATE TABLE app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
~~~

~~~js
db.prepare('DELETE FROM app_settings').run();
~~~

Add built_in_pii_filter_active: false to the existing exact snapshot deepEqual; otherwise the new immutable field is not regression-covered.

~~~js
assert.equal(
  getEffectiveFilterSnapshot(modelId).built_in_pii_filter_active,
  false
);

db.prepare(
  "INSERT INTO app_settings VALUES " +
  "('built_in_pii_filter_active', '0', ?)"
).run(new Date().toISOString());
assert.equal(
  getEffectiveFilterSnapshot(modelId).built_in_pii_filter_active,
  false
);

db.prepare(
  "UPDATE app_settings SET setting_value = '1' " +
  "WHERE setting_key = 'built_in_pii_filter_active'"
).run();
const active = getEffectiveFilterSnapshot(modelId);
assert.equal(active.built_in_pii_filter_active, true);
assert.equal(Object.isFrozen(active), true);
~~~

For stored text values '', 'true', '2', and '01' require status 500/code filter_configuration_invalid. Add this as a new test whose name includes built-in PII activation; do not replace the existing content_filter_models SQLite regression. In its SQLITE_ERROR case, drop app_settings inside try and recreate the exact table in finally so later tests and beforeEach remain valid; assert the SQLite error is not reclassified.

- [ ] **Step 2: Run snapshot tests RED**

~~~powershell
node --test --test-name-pattern="built-in PII activation" test/content-filters.test.js
~~~

Expected: FAIL because snapshot property is absent.

- [ ] **Step 3: Read the exact setting inside fixedConfiguration**

~~~js
const BUILT_IN_PII_SETTING = 'built_in_pii_filter_active';

function builtInPiiFilterActive() {
  const row = db.prepare(
    'SELECT setting_value FROM app_settings WHERE setting_key = ?'
  ).get(BUILT_IN_PII_SETTING);
  if (!row || row.setting_value === '0') return false;
  if (row.setting_value === '1') return true;
  throw configurationError();
}
~~~

Call it inside getEffectiveFilterSnapshot's existing fixedConfiguration callback and freeze the boolean with the other fields. Reads never insert.

- [ ] **Step 4: Write RED admin API and atomic audit tests**

In test/admin-filters.test.js clear the setting key and filter audits before each test. Require:

1. Unauthenticated GET and PUT with invalid-but-parseable {is_active:'yes',extra:true} return 401 and create neither setting nor audit, proving authentication precedes body/service validation.
2. Authenticated default GET does not insert a setting and fixes id built-in-pii, name Built-in Korean PII & Secret Filter, is_global true, and is_active false.
3. Response keys are exactly id, name, is_active, is_global, rules.
4. Each rule has exactly id, label, mode; serialized response excludes pattern, source, scan, validate, validator.
5. GET /admin/filters remains only the literal-filter array.
6. PUT rejects {}, numeric/string is_active, and unknown fields.
7. Corrupt stored value makes GET return 500/filter_configuration_invalid without exposing the value; valid PUT true repairs exact string 1; PUT false stores exact string 0.
8. Success audit is filter.update/filter/built-in-pii/1/["is_active"].

Create this temporary trigger:

~~~sql
CREATE TRIGGER fail_built_in_pii_audit
BEFORE INSERT ON audit_logs
WHEN NEW.action = 'filter.update'
 AND NEW.target_id = 'built-in-pii'
BEGIN
  SELECT RAISE(ABORT, 'synthetic audit failure');
END;
~~~

Seed the setting as exact string 0, install the trigger, require PUT true to return 500, and verify the setting is still 0. Require route-level failure audit filter.change/filter/built-in-pii/0/[]. Register t.after(() => db.exec('DROP TRIGGER IF EXISTS fail_built_in_pii_audit')) before the request so the shared test DB cannot retain the trigger after success or failure.

- [ ] **Step 5: Run admin tests RED**

~~~powershell
node --test --test-name-pattern="built-in PII" test/admin-filters.test.js
~~~

Expected: FAIL with missing routes/functions.

- [ ] **Step 6: Implement built-in admin functions in content-filters.js**

Keep pii-filter.js DB-free. Import it as a namespace and use:

~~~js
const BUILT_IN_PII_ID = 'built-in-pii';
const BUILT_IN_PII_NAME = 'Built-in Korean PII & Secret Filter';

function builtInPiiResponse(isActive) {
  return {
    id: BUILT_IN_PII_ID,
    name: BUILT_IN_PII_NAME,
    is_active: isActive,
    is_global: true,
    rules: piiFilter.getRuleMetadata()
  };
}

function getBuiltInPiiFilter() {
  return builtInPiiResponse(
    fixedConfiguration(builtInPiiFilterActive)
  );
}

function setBuiltInPiiFilter(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !Object.hasOwn(input, 'is_active') ||
      typeof input.is_active !== 'boolean') {
    throw new ApiError(
      400,
      'is_active must be the only field and must be boolean'
    );
  }
  db.transaction(() => {
    db.prepare(
      'INSERT INTO app_settings ' +
      '(setting_key, setting_value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(setting_key) DO UPDATE SET ' +
      'setting_value = excluded.setting_value, ' +
      'updated_at = excluded.updated_at'
    ).run(
      BUILT_IN_PII_SETTING,
      input.is_active ? '1' : '0',
      new Date().toISOString()
    );
    audit(
      'filter.update',
      'filter',
      BUILT_IN_PII_ID,
      true,
      ['is_active']
    );
  }).immediate();
  return builtInPiiResponse(input.is_active);
}
~~~

PUT must not call builtInPiiFilterActive, so it repairs corrupt storage. Export both functions.

- [ ] **Step 7: Register static routes before /filters/:id**

~~~js
router.get('/filters/built-in-pii', (req, res, next) => {
  try { res.json(getBuiltInPiiFilter()); }
  catch (error) { next(error); }
});

router.put('/filters/built-in-pii', (req, res, next) => {
  try { res.json(setBuiltInPiiFilter(req.body)); }
  catch (error) { next(error); }
});
~~~

Place before parameterized filter routes. Add the stable failure-audit special case:

~~~js
if ((segments[0] || '').toLowerCase() === 'filters' &&
    (segments[1] || '').toLowerCase() === 'built-in-pii') {
  return {
    action: 'filter.change',
    targetType: 'filter',
    targetId: 'built-in-pii'
  };
}
~~~

- [ ] **Step 8: Run Task 3 GREEN and commit**

~~~powershell
node --test test/content-filters.test.js test/admin-filters.test.js
git add services/content-filters.js routes/admin.js test/content-filters.test.js test/admin-filters.test.js
git commit -m "feat: administer built-in PII activation"
~~~

Expected before commit: zero failures.


---

### Task 4: Integrate input and non-stream response processing

**Files:**
- Modify: routes/v1.js
- Modify: test/filter-runtime.test.js

**Interfaces:**
- Consumes snapshot.built_in_pii_filter_active and piiFilter namespace methods.
- Preserves existing quota, usage, error classification, and single finally cleanup.

- [ ] **Step 1: Extend harness and write RED default/active tests**

Import the namespace, capture originals, and restore after each test:

~~~js
const piiFilter = require('../services/pii-filter');

function setBuiltInPiiActive(active = true) {
  db.prepare(
    'INSERT INTO app_settings ' +
    '(setting_key, setting_value, updated_at) ' +
    "VALUES ('built_in_pii_filter_active', ?, ?) " +
    'ON CONFLICT(setting_key) DO UPDATE SET ' +
    'setting_value = excluded.setting_value, ' +
    'updated_at = excluded.updated_at'
  ).run(active ? '1' : '0', new Date().toISOString());
}
~~~


In filter-runtime beforeEach, DELETE the built_in_pii_filter_active setting and restore every patched piiFilter namespace method from captured originals. Mirror those restorations in after so failures cannot leak state into later tests.
Default-off: send 000229-3123456 and require provider receives it unchanged.

Active: send a resident number, the same email twice, and an AWS-shaped secret in supported text. Add a request flag or test-only provider-handler branch that echoes transformed request content only for this case; do not change the fixed provider response that existing output-mask tests depend on. Require provider payload contains none of the raw values, duplicate email tokens are equal, client PII is restored, secret becomes [FILTERED], and no placeholder reaches the client.

- [ ] **Step 2: Write RED order and scope tests**

Add concrete tests:

1. Literal block matching the resident value returns content_filtered and providerCalls remains zero.
2. Literal input mask of the resident value yields [FILTERED] before built-in scanning and no PII token.
3. Literal output mask of the resident value masks it after restoration.
4. Same raw value in tool arguments, image URL, top-level vendor field, and response vendor extension stays untouched.
5. A resident number generated only by provider stays raw for client.
6. Corrupt activation returns filter_configuration_invalid before provider/quota.
7. Unauthenticated request with corrupt activation still returns 401.
8. Let literal input masking return a changed sentinel body with no built-in match; spy that applyInputFilter returns that exact object reference and null context.

- [ ] **Step 3: Write RED limits, snapshot, failure, cleanup tests**

- 201 unique emails -> HTTP 413/request_too_large, zero provider calls/reservations, one filter failure request log, and empty user/model/provider limit state.
- Repeated accepted email above 64 KiB occurrence bytes -> the same 413/log/cleanup assertions.
- Under-limit input whose secret placeholders expand transformed JSON over 1 MiB -> existing 413.
- Start an active held request in an isolated provider branch, capture its transformed payload, disable while provider is held, then release and echo that captured content -> client receives the original PII. Do not reuse/change the fixed-response branch used by existing tests.
- Patch applyOutputFilter to throw a private marker -> HTTP 502/filter_processing_failed, usage once, marker/body absent.
- Spy the exported clearContext only after applyInputFilter has returned a context: success, provider HTTP failure, transformed 1 MiB size failure, and output error each pass that non-null context exactly once through route finally with normal quota/concurrency release. Keep input-transformation partial cleanup in Task 1's Map/Set instrumentation because a thrown applyInputFilter never assigns handler piiContext.

- [ ] **Step 4: Run runtime tests RED**

~~~powershell
node --test --test-name-pattern="built-in PII|PII order|PII limit|PII snapshot|PII cleanup" test/filter-runtime.test.js
~~~

Expected: FAIL because routes/v1.js never invokes piiFilter.

- [ ] **Step 5: Insert the built-in stage at the exact pipeline point**

At module top:

~~~js
const piiFilter = require('../services/pii-filter');
~~~

Add handler local:

~~~js
let piiContext = null;
~~~

Replace only the current snapshot/input block:

~~~js
const filterSnapshot =
  contentFilters.getEffectiveFilterSnapshot(
    req.gatewayModel.model_id
  );
let filteredBody =
  contentFilters.applyInputFilters(req.body, filterSnapshot);

if (filterSnapshot.built_in_pii_filter_active) {
  const transformed = piiFilter.applyInputFilter(filteredBody);
  filteredBody = transformed.body;
  piiContext = transformed.context;
}

reservation = reserveQuota(
  req.user,
  req.body.max_tokens,
  req.gatewayModel.max_tokens
);
~~~

Keep request-size enforcement after transformation and quota reservation exactly where it is.

- [ ] **Step 6: Compose non-stream output in approved order**

Inside the existing output try:

~~~js
const restoredResponse = piiContext
  ? piiFilter.applyOutputFilter(body, piiContext)
  : body;
filteredResponse =
  contentFilters.applyOutputFilters(
    restoredResponse,
    filterSnapshot
  );
~~~

Do not change the catch that records provider usage exactly once as filter failure.

- [ ] **Step 7: Clear context at the start of existing finally**

~~~js
try {
  piiFilter.clearContext(piiContext);
} catch {
  // Cleanup failure must not skip quota/concurrency release.
}
piiContext = null;
~~~

Never attach context to req or filterSnapshot.

- [ ] **Step 8: Run Task 4 GREEN and commit**

~~~powershell
node --test test/filter-runtime.test.js
git add routes/v1.js test/filter-runtime.test.js
git commit -m "feat: apply reversible PII in chat runtime"
~~~

Expected before commit: zero failures.

---

### Task 5: Compose request-owned restoration with strict SSE

**Files:**
- Modify: routes/v1.js
- Modify: test/filter-streaming.test.js

**Interfaces:**
- relayStream(response,res,signal,outputPatterns,piiContext).
- relayFilteredStream(response,res,signal,patterns,piiContext).
- createMaskState(patterns,piiContext).
- Per choice state is {restorer,carry,finished}.
- Restoration feeds the existing literal mask stage.

- [ ] **Step 1: Extend stream request helper and write RED token-split test**

~~~js
function streamRequest(overrides = {}) {
  return fetch(baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + user.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'filter-streaming',
      stream: true,
      max_tokens: 20,
      messages: [{ role: 'user', content: 'ordinary' }],
      ...overrides
    })
  });
}
~~~

Add setting helper and clear it before each test. With active filtering and a resident request, capture provider placeholder. Return it split across raw bytes and across data events at boundaries inside prefix, nonce, rule ID, counter, and closing brackets. Require one restored resident number in client stream.

- [ ] **Step 2: Write RED finish/DONE/EOF/interleaving tests**

Use explicit events for:

- token finishing in event with finish_reason;
- token immediately before [DONE];
- clean EOF without [DONE];
- interleaved choice 0/1 fragments;
- secret token split across events -> [FILTERED];
- fabricated complete and incomplete EOF tokens unchanged;
- restored resident containing a literal output pattern -> masked last;
- usage and vendor delta fields unchanged.

- [ ] **Step 3: Write RED mapping-only fail-closed tests**

Create a separate mapping-only helper/parameter mode that installs no literal output filter, enables built-in, and sends a resident value so context is non-null. Do not reuse the existing malformed loop's unconditional addOutputFilter(['foo']). Under this mode run invalid UTF-8, invalid JSON, invalid choice index, colonless data, oversized unterminated event, and unterminated EOF. Require 502 before headers or abort after headers and one filter failure log.

With built-in enabled but ordinary no-match input, relay arbitrary SSE Buffer exactly byte-for-byte; null context must not activate strict parsing.

- [ ] **Step 4: Run all mapping stream tests RED**

~~~powershell
node --test --test-name-pattern="request-owned PII stream|PII stream terminal|mapping-only" test/filter-streaming.test.js
~~~

Expected: FAIL because literal-output patterns are empty and relay is byte-transparent.

- [ ] **Step 5: Select strict SSE for either transformation source**

Pass the request-local context in the handler's existing call:

~~~js
streamUsage = await relayStream(
  response,
  res,
  controller.signal,
  filterSnapshot.output_mask_patterns,
  piiContext
);
~~~

Then change relayStream:

~~~js
async function relayStream(
  response,
  res,
  signal,
  outputPatterns,
  piiContext
) {
  if (outputPatterns.length > 0 || piiContext !== null) {
    return relayFilteredStream(
      response,
      res,
      signal,
      outputPatterns,
      piiContext
    );
  }
  // Keep the existing byte-transparent branch unchanged.
}
~~~

- [ ] **Step 6: Add restoration before literal masking**

~~~js
function createMaskState(patterns, piiContext) {
  return {
    filter: contentFilters.createLiteralFilter(patterns),
    maxPatternLength: Math.max(
      1,
      ...patterns.map((pattern) => pattern.length)
    ),
    piiContext,
    choices: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    usageSeen: false,
    done: false
  };
}
~~~
Change relayFilteredStream's signature, state construction, and clean-EOF normalization together:

~~~js
async function relayFilteredStream(
  response,
  res,
  signal,
  patterns,
  piiContext
) {
  const streamState = createMaskState(patterns, piiContext);
  const pending = createEventAccumulator();
  for await (const chunk of response.body) {
    await writeCompleteEvents(
      response,
      res,
      signal,
      pending,
      chunk,
      streamState
    );
  }

  if (pending.length > 0) throw filterStreamError(streamState);
  let finalOutput;
  try {
    finalOutput = streamState.done
      ? []
      : flushChoices(streamState, '\n\n');
  } catch {
    throw filterStreamError(streamState);
  }
  for (const event of finalOutput) {
    await writeStreamChunk(response, res, event, signal);
  }
  if (!res.headersSent) {
    setStreamHeaders(response, res);
    res.flushHeaders();
  }
  res.end();
  return {
    inputTokens: streamState.inputTokens,
    outputTokens: streamState.outputTokens
  };
}
~~~



Per choice:

~~~js
state = {
  restorer: streamState.piiContext
    ? piiFilter.createRestorationCarry(
        streamState.piiContext
      )
    : null,
  carry: '',
  finished: false
};
~~~

Compose:

~~~js
function restoreThenMask(
  state,
  content,
  streamState,
  terminal = false
) {
  let restored = state.restorer
    ? state.restorer.push(content)
    : content;
  if (terminal && state.restorer) {
    restored += state.restorer.flush();
  }
  return maskIncrementally(
    state,
    restored,
    streamState,
    terminal
  );
}
~~~

Replace every transformDataEvent/flushChoices maskIncrementally call with restoreThenMask.
At the existing writeCompleteEvents boundary, remove any branch that rethrows an incoming error merely because its code already equals filter_processing_failed:

~~~js
} catch {
  throw filterStreamError(streamState);
}
~~~

Normalize every parse, restoration, and literal-mask exception to a fresh safe stream error. filterStreamError may reattach only the already-observed usage counters; it must never preserve an upstream/restorer message or body marker.

- [ ] **Step 7: Flush hidden restoration carry on terminal events**

~~~js
function flushChoices(streamState, delimiter) {
  const choices = [];
  for (const [index, state] of streamState.choices) {
    if (state.finished) continue;
    const content =
      restoreThenMask(state, '', streamState, true);
    if (content) {
      choices.push({
        index,
        delta: { content },
        finish_reason: null
      });
    }
  }
  if (choices.length === 0) return [];
  return [
    'data: ' + JSON.stringify({ choices }) + delimiter
  ];
}
~~~

Do not skip because literal carry is empty. At clean EOF, normalize flush errors through filterStreamError so already-seen usage is retained.

- [ ] **Step 8: Run Task 5 GREEN and commit**

~~~powershell
node --test test/filter-streaming.test.js
git add routes/v1.js test/filter-streaming.test.js
git commit -m "feat: restore request PII in SSE"
~~~

Expected before commit: zero failures.


---

### Task 6: Add the accessible built-in filter card

**Files:**
- Modify: public/admin-dashboard.html
- Modify: public/admin-dashboard.js
- Modify: test/admin-filters.test.js
- Modify: test/admin-dashboard.test.js

**Interfaces:**
- Consumes GET/PUT /admin/filters/built-in-pii.
- Produces form built-in-pii-form and checkbox name isActive.
- Produces built-in-pii-state and built-in-pii-rules through safe DOM.
- Toggle reloads configuration including built-in metadata, never Usage statistics.

- [ ] **Step 1: Write RED static UI contract assertions**

Require semantic section/heading, connected checkbox help, labelled read-only rule list, and copy stating:

- global for every model;
- inactive by default;
- rules are reviewed code;
- mappings are request-scoped;
- secrets return [FILTERED] and never restore;
- not a general DLP system;
- literal policies below remain organization-specific.

Keep unsafe-sink scan requiring no innerHTML, outerHTML, insertAdjacentHTML, or document.write.
Put these assertions in a separately named test containing `built-in PII` so the focused Step 3 command actually selects it.

- [ ] **Step 2: Write RED dashboard interaction test and harness**

Set FakeNode.checked = false. Add:

~~~js
const builtInPiiForm = new FakeForm();
builtInPiiForm.elements.isActive = new FakeNode();
elements.set('built-in-pii-rules', new FakeNode());
elements.set('built-in-pii-form', builtInPiiForm);
elements.set('built-in-pii-state', new FakeNode());
~~~

Add default GET/PUT fixtures and return form/rule/state nodes. Submit checked true:
Back those fixtures with a mutable builtInPiiActive boolean: PUT parses the body and updates it, and the following GET returns metadata with that current value. This matches production, where the submit handler ignores the PUT response and rerenders from loadAll.

~~~js
assert.deepEqual(
  JSON.parse(put.options.body),
  { is_active: true }
);
~~~

After PUT, require all configuration GETs including built-in and no /admin/stats. An active response sets checkbox true/state Active and renders rule li nodes.
Then submit once with checked false and require exact JSON `{is_active:false}`, a follow-up GET rendering Inactive, and still no stats fetch.
Update both existing exact loadAll route arrays in test/admin-dashboard.test.js to include /admin/filters/built-in-pii while retaining their existing order otherwise.


- [ ] **Step 3: Run UI tests RED**

~~~powershell
node --test --test-name-pattern="built-in PII" test/admin-filters.test.js test/admin-dashboard.test.js
~~~

Expected: FAIL because card/loading are absent.

- [ ] **Step 4: Add separate card at the start of the Filters tab**
Insert the card immediately after the opening tab-filters section and before filter-usage-guide. This preserves the existing assertion that the guide remains directly adjacent to the literal Create filter card.


~~~html
<section id="built-in-pii-filter" class="card"
         aria-labelledby="built-in-pii-title">
  <h2 id="built-in-pii-title">
    Built-in Korean PII &amp; Secret Filter
  </h2>
  <p class="help">
    Global for every model and inactive by default. Reviewed code
    defines the rules; the browser can only enable or disable them.
  </p>
  <p class="help">
    PII mappings exist for one request only. Secrets are never
    restored and return as <code>[FILTERED]</code>. This reduces
    supported provider-input disclosure; it is not general DLP.
  </p>
  <form id="built-in-pii-form">
    <div class="checks">
      <label>
        <input name="isActive" type="checkbox"
               aria-describedby="built-in-pii-help">
        Enable globally
      </label>
      <span id="built-in-pii-state"
            class="badge">Inactive</span>
    </div>
    <p id="built-in-pii-help" class="help">
      Use literal filters below for organization-specific values.
    </p>
    <button type="submit">Save built-in filter</button>
  </form>
  <h3 id="built-in-pii-rules-title">Compiled rules</h3>
  <ul id="built-in-pii-rules"
      aria-labelledby="built-in-pii-rules-title"></ul>
</section>
~~~

Do not add editable regex/code or CSS.

- [ ] **Step 5: Load and render metadata safely**

Add builtInPii: null to state and include GET in loadAll Promise.all. Assign and call:

~~~js
function renderBuiltInPii() {
  const filter = state.builtInPii;
  const form = el('built-in-pii-form');
  form.elements.isActive.checked = filter.is_active;
  const stateNode = el('built-in-pii-state');
  stateNode.textContent = filter.is_active ? 'Active' : 'Inactive';
  stateNode.className = 'badge' + (filter.is_active ? ' active' : '');
  const items = filter.rules.map((rule) => node(
    'li',
    rule.label + ' - ' +
      (rule.mode === 'restore'
        ? 'request-scoped restoration'
        : 'irreversible redaction')
  ));
  el('built-in-pii-rules').replaceChildren(...items);
}
~~~

Use node/textContent/replaceChildren/checked only.

- [ ] **Step 6: Submit strict boolean and reload configuration**

~~~js
el('built-in-pii-form').addEventListener(
  'submit',
  async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const isActive = form.elements.isActive.checked;
    try {
      await api('/admin/filters/built-in-pii', {
        method: 'PUT',
        body: JSON.stringify({ is_active: isActive })
      });
      await loadAll();
      showStatus(T.saved, 'success');
    } catch (error) {
      showStatus(error.message, 'error');
    }
  }
);
~~~

- [ ] **Step 7: Run Task 6 GREEN and commit**

~~~powershell
node --check public/admin-dashboard.js
node --test test/admin-filters.test.js test/admin-dashboard.test.js
git add public/admin-dashboard.html public/admin-dashboard.js test/admin-filters.test.js test/admin-dashboard.test.js
git commit -m "feat: add built-in PII admin toggle"
~~~

Expected before commit: zero failures.

---

### Task 7: Verify lifecycle cleanup and privacy invariants

**Files:**
- Modify: test/filter-runtime.test.js
- Modify: test/filter-streaming.test.js
- Modify: test/gateway.test.js
- Modify: test/server.test.js

**Interfaces:**
- Consumes completed request/SSE pipeline.
- Produces evidence for timeout, disconnect, backpressure, abortInFlight, SIGTERM, storage, logs, audits, and errors.

- [ ] **Step 1: Write mapping-active provider timeout test**

Add a dedicated timeout provider-handler branch; do not reuse the held-request gate because its resolver can be overwritten during teardown. The branch parses the request, emits started, waits for request/response close, then emits closed. Store the runtime provider ID in harness state (or query it by the fixture model) so its slot can be asserted. Temporarily set config.providerTimeout = 200 and restore with t.after, await started before the final response and closed before teardown, and use an outer 3-second test timeout or AbortSignal. Send resident 000229-3123456. Require:

- HTTP 504/provider_timeout;
- provider saw placeholder, not raw value;
- a spy that counts only non-null arguments observes clearContext exactly once for the request context (the route may also make its intentional no-op clearContext(null) call);
- one failure request log;
- zero quota reservation;
- no user/model/provider concurrency slot.

The provider-slot assertion must address the stored runtime provider ID, not only user/model IDs.

- [ ] **Step 2: Exercise context in stream disconnect/backpressure**

In existing test/filter-streaming disconnect test, enable built-in, send resident instead of ordinary, and assert provider payload has placeholder. Keep one upstream close, zero reservation, and empty limits assertions.

Change the existing gateway backpressure test callback from async () to async (t). First make its mock SSE choice strict-parser-valid by adding index: 0 to every emitted choice. Capture any existing activation row including setting_value and updated_at; t.after restores both when present, otherwise deletes the inserted key. Send a resident value; receivedPayloads must exclude the raw value. Keep exact one-close and all-slot assertions.

- [ ] **Step 3: Exercise context in abortInFlight**

Activate the setting for the existing abort-in-flight test and restore/delete it in t.after. Send a resident value and assert the held provider received a placeholder. Call abortInFlight twice. Preserve exact one upstream close and idempotent reservation/concurrency cleanup.

- [ ] **Step 4: Exercise context in SIGTERM**

In server test, authenticated PUT built-in active after setup. Replace prompt marker with synthetic resident; capture provider placeholder. Require:

- provider value differs from raw and matches token grammar;
- SIGTERM exit code 0;
- one upstream close;
- no quota reservation;
- stdout/stderr contains neither raw PII nor placeholder;
- after child exit and closing any readonly DB handle, read only existing databasePath, databasePath + '-wal', and databasePath + '-shm' files before teardown; their bytes contain neither value.

- [ ] **Step 5: Add consolidated non-persistence test**

Send successful and forced-provider-error requests with resident 000229-3123456, synthetic.user@example.test, and synthetic AWS-shaped key. Capture provider placeholders.

Query fixed non-secret fields from request_logs, usage_logs, audit_logs, app_settings, users, models, and providers. Assert serialization, application logger capture, and HTTP errors contain none of the raw values/placeholders. Never select stored_api_key or raw token columns.

- [ ] **Step 6: Run Task 7 GREEN and commit**

~~~powershell
node --test test/filter-runtime.test.js test/filter-streaming.test.js test/gateway.test.js test/server.test.js
git add test/filter-runtime.test.js test/filter-streaming.test.js test/gateway.test.js test/server.test.js
git commit -m "test: verify PII filter lifecycle privacy"
~~~

Expected before commit: zero failures.


---

### Task 8: Document behavior, boundaries, and attribution

**Files:**
- Create: THIRD_PARTY_NOTICES.md
- Modify: README.md
- Modify: docs/API.md
- Modify: docs/COMPATIBILITY.md
- Modify: docs/THREAT_MODEL.md
- Modify: CHANGELOG.md
- Modify: test/admin-filters.test.js

**Interfaces:**
- Documents exact admin/public behavior and unsupported cases.
- Adds no runtime code.

- [ ] **Step 1: Write RED documentation contract assertions**

Require these anchors across documentation/notice:

- /admin/filters/built-in-pii
- built_in_pii_filter_active
- disabled by default
- 200 unique values
- 64 KiB
- messages[*].content
- {type:"text", text}
- [FILTERED]
- not output DLP
- October 12, 2020 resident random tail
- Reversible PII / Secret Pseudonymization Filter v3.2.5
- Isidro Spencer
- supplied OpenWebUI source URL
- MIT License

- [ ] **Step 2: Run docs contract RED**

~~~powershell
node --test --test-name-pattern="built-in PII documentation" test/admin-filters.test.js
~~~

Expected: FAIL because docs/notice are incomplete.

- [ ] **Step 3: Update README and API**

README explains enabling the global/default-off card, editing reviewed rules only in services/pii-filter.js with tests, and request-local mappings.

docs/API.md includes:

- GET/PUT request and response;
- strict boolean and unknown-field rejection;
- missing/0/1/corrupt setting behavior;
- HTTP 413 request_too_large and HTTP 500 filter_processing_failed for input;
- HTTP 502 filter_processing_failed for non-stream output transformation;
- corrupt admin GET returns HTTP 500 filter_configuration_invalid without its stored value;
- streaming transformation fails as HTTP 502 before headers or aborts the response after headers, always with a fresh safe error;
- exact pipeline order;
- supported fields and mapping bounds;
- JSON/SSE output ordering.

Never publish matcher source or secret fixtures in admin contract.

- [ ] **Step 4: Update compatibility and threat model**

docs/COMPATIBILITY.md states:

- modern resident date/type validation without legacy checksum, citing the Ministry of the Interior and Safety change notice: https://www.mois.go.kr/frt/bbs/type002/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000205&nttId=75077;
- separate foreigner checksum;
- included/excluded PII/secret categories and phone prefixes;
- byte-transparent no-context versus strict context/literal SSE;
- provider-generated values are not output-detected.

docs/THREAT_MODEL.md states:

- provider sees placeholders only for supported input;
- nonce collision prevention/exact-owned restoration;
- raw secrets never enter restoration maps;
- context dies in finally and never persists/logs;
- tool/attachment/vendor fields remain disclosure paths;
- PII false positives restore, secret matches are irreversible;
- feature is not a compliance guarantee/general DLP.

- [ ] **Step 5: Create exact third-party notice**

Create THIRD_PARTY_NOTICES.md:

~~~text
# Third-Party Notices

## Reversible PII / Secret Pseudonymization Filter v3.2.5

LLMWard's built-in filter was independently designed with inspiration from
"Reversible PII / Secret Pseudonymization Filter v3.2.5" by Isidro Spencer.

Source:
https://openwebui.com/posts/reversible_pii_secret_pseudonymization_filter_v325_091de1cd

The LLMWard implementation does not copy the original runtime architecture.
It deliberately excludes process-global session maps, cross-session fallback,
debug content logging, broad recursive request mutation, Python, and Presidio.

MIT License

Author (as published): Isidro Spencer
Version (as published): 3.2.5
License (as published): MIT
The source page supplies no separate copyright notice or year; none is invented here.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
~~~

- [ ] **Step 6: Update changelog without version change**

Add bullets for Korean PII pseudonymization, distinctive secret redaction, global default-off administration, request-local JSON/SSE restoration, and intentional exclusions.

- [ ] **Step 7: Run Task 8 GREEN and commit**

~~~powershell
node --test --test-name-pattern="built-in PII documentation|dashboard exposes" test/admin-filters.test.js
git add THIRD_PARTY_NOTICES.md README.md docs/API.md docs/COMPATIBILITY.md docs/THREAT_MODEL.md CHANGELOG.md test/admin-filters.test.js
git commit -m "docs: describe built-in PII filter"
~~~

Expected before commit: selected tests pass.

---

### Task 9: Complete verification and scope audit

**Files:**
- Verify only; no planned production changes.

**Interfaces:**
- Consumes Tasks 1-8.
- Produces fresh regression, operational, startup, security, and diff evidence.

- [ ] **Step 1: Run syntax and patch hygiene**

~~~powershell
node --check services/chat-content.js
node --check services/pii-filter.js
node --check services/content-filters.js
node --check routes/admin.js
node --check routes/v1.js
node --check public/admin-dashboard.js
git diff --check
~~~

Expected: every command exits zero.

- [ ] **Step 2: Run focused filter suite**

~~~powershell
node --test test/pii-filter.test.js test/content-filters.test.js test/admin-filters.test.js test/admin-dashboard.test.js test/filter-runtime.test.js test/filter-streaming.test.js
~~~

Expected: zero failures.

- [ ] **Step 3: Run lifecycle/shutdown tests**

~~~powershell
node --test test/gateway.test.js test/server.test.js
~~~

Expected: zero failures and no fixture leak in output.

- [ ] **Step 4: Run complete regression**

~~~powershell
npm.cmd test
~~~

Expected: zero failures.

- [ ] **Step 5: Run operational/security checks**

~~~powershell
npm.cmd run doctor
npm.cmd run benchmark
npm.cmd audit --omit=dev
~~~

Expected: doctor exits zero without secrets, benchmark remains within repository thresholds, and audit reports zero known production vulnerabilities.

- [ ] **Step 6: Run temporary-database startup health**

Create a fresh temporary directory and strong synthetic admin key. Start npm.cmd start with DATABASE_PATH inside it, poll /health to HTTP 200, terminate normally, then open only that temporary DB and require integrity_check ok and foreign_key_check empty. Verify the resolved target remains under the temporary directory before removing it. Never use data/gateway.db.

- [ ] **Step 7: Audit final scope/privacy**

~~~powershell
git status --short
git diff --stat HEAD~8..HEAD
git diff -- package.json package-lock.json db/migrations.js Dockerfile
rg -n "console\\.log|logger\\..*(messages|content|prompt|response)|built_in_pii_filter_active|LLMWARD:" services routes public
~~~

Require:

- no package, lockfile, schema, Docker, plugin, Python, or Presidio change;
- setting references only in intended service/routes/tests;
- placeholder grammar only in PII service/tests/docs;
- no prompt/response/match/mapping/placeholder/secret logging;
- no matcher source/validator in admin JSON;
- no unrelated refactor.

- [ ] **Step 8: Review rule comments and extension safety**

For every immutable RULES entry, verify adjacent Korean comments name protected information, accepted separators/prefixes, validation, and exclusions. A future rule must require only one code entry plus positive, negative, boundary, overlap, and 1 MiB non-match fixtures; never a registration API or loader.

- [ ] **Step 9: Record final evidence**

The handoff reports exact focused/full/doctor/audit/startup commands and results. It also states that names, free-form addresses, bank accounts, business numbers, URLs, attachments, tool arguments, and provider-generated raw PII remain outside detection.
