const crypto = require('node:crypto');

const { ApiError } = require('./errors');
const { forEachChatText } = require('./chat-content');

const RULE_ID = /^[a-z][a-z0-9_]{0,63}$/u;
const MODES = new Set(['restore', 'redact']);
const RESIDENT_CENTURY = new Map([
  ['0', 1800], ['9', 1800],
  ['1', 1900], ['2', 1900],
  ['3', 2000], ['4', 2000]
]);
const FOREIGNER_CENTURY = new Map([
  ['5', 1900], ['6', 1900],
  ['7', 2000], ['8', 2000]
]);
const FOREIGNER_WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
const LANDLINE_PREFIXES = new Set([
  '02',
  '031', '032', '033',
  '041', '042', '043', '044',
  '051', '052', '053', '054', '055',
  '061', '062', '063', '064'
]);
const PHONE_PREFIXES = ['010', '070', ...LANDLINE_PREFIXES];
const MAX_UNIQUE_VALUES = 200;
const MAX_RESTORABLE_BYTES = 64 * 1024;
const MAX_COUNTER = 999999;

function isDigit(character) {
  return character >= '0' && character <= '9';
}

function isDigits(value) {
  if (!value) return false;
  for (const character of value) {
    if (!isDigit(character)) return false;
  }
  return true;
}

function validDate(digits, centuryByCode) {
  const century = centuryByCode.get(digits[6]);
  if (century === undefined) return false;
  const year = century + Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function scanKoreanIdentifiers(text) {
  const matcher = /[0-9]{6}-?[0-9]{7}/gu;
  const spans = [];
  for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (isDigit(text[start - 1]) || isDigit(text[end])) continue;
    spans.push({ start, end });
  }
  return spans;
}

function normalizeIdentifier(value) {
  return value.includes('-') ? value.slice(0, 6) + value.slice(7) : value;
}

function validateResident(value) {
  const digits = normalizeIdentifier(value);
  return digits.length === 13 && isDigits(digits) &&
    validDate(digits, RESIDENT_CENTURY);
}

function validateForeigner(value) {
  const digits = normalizeIdentifier(value);
  if (digits.length !== 13 || !isDigits(digits) ||
      !validDate(digits, FOREIGNER_CENTURY)) {
    return false;
  }
  let sum = 0;
  for (let index = 0; index < FOREIGNER_WEIGHTS.length; index += 1) {
    sum += Number(digits[index]) * FOREIGNER_WEIGHTS[index];
  }
  const expected = (11 - (sum % 11) + 2) % 10;
  return Number(digits[12]) === expected;
}

function scanCards(text) {
  const spans = [];
  let index = 0;
  while (index < text.length) {
    if (!isDigit(text[index])) {
      index += 1;
      continue;
    }
    const start = index;
    if (!isDigit(text[start - 1]) && start + 19 <= text.length) {
      const candidate = text.slice(start, start + 19);
      const separator = candidate[4];
      if ((separator === ' ' || separator === '-') &&
          candidate[9] === separator && candidate[14] === separator &&
          isDigits(candidate.slice(0, 4)) &&
          isDigits(candidate.slice(5, 9)) &&
          isDigits(candidate.slice(10, 14)) &&
          isDigits(candidate.slice(15, 19)) &&
          !isDigit(text[start + 19]) &&
          text[start + 19] !== '-') {
        spans.push({ start, end: start + 19 });
        index = start + 19;
        continue;
      }
    }
    while (isDigit(text[index])) index += 1;
    const length = index - start;
    if (length >= 13 && length <= 19 && !isDigit(text[start - 1])) {
      spans.push({ start, end: index });
    }
  }
  return spans;
}

function validateCard(value) {
  const digits = value.replace(/[ -]/gu, '');
  if (digits.length < 13 || digits.length > 19 || !isDigits(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function phoneCandidate(text, start, prefix, firstGroupLength, separator) {
  let cursor = start + prefix.length;
  if (separator) {
    if (text[cursor] !== separator) return null;
    cursor += 1;
  }
  if (!isDigits(text.slice(cursor, cursor + firstGroupLength))) return null;
  cursor += firstGroupLength;
  if (separator) {
    if (text[cursor] !== separator) return null;
    cursor += 1;
  }
  if (!isDigits(text.slice(cursor, cursor + 4))) return null;
  cursor += 4;
  if (isDigit(text[cursor]) || (separator === '-' && text[cursor] === '-')) {
    return null;
  }
  return cursor;
}

function scanPhones(text) {
  const spans = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '0' || isDigit(text[index - 1])) {
      index += 1;
      continue;
    }
    let end = null;
    for (const prefix of PHONE_PREFIXES) {
      if (!text.startsWith(prefix, index)) continue;
      const afterPrefix = text[index + prefix.length];
      const separator = afterPrefix === '-' || afterPrefix === ' '
        ? afterPrefix
        : '';
      const groupLengths = prefix === '010' || prefix === '070'
        ? [4]
        : [4, 3];
      for (const groupLength of groupLengths) {
        end = phoneCandidate(text, index, prefix, groupLength, separator);
        if (end !== null) break;
      }
      break;
    }
    if (end === null) {
      index += 1;
      continue;
    }
    spans.push({ start: index, end });
    index = end;
  }
  return spans;
}

function isAsciiLetterOrDigit(character) {
  return character >= 'A' && character <= 'Z' ||
    character >= 'a' && character <= 'z' ||
    isDigit(character);
}

function isEmailLocalCharacter(character) {
  return isAsciiLetterOrDigit(character) ||
    ".!#$%&'*+/=?^_`{|}~-".includes(character);
}

function isEmailDomainCharacter(character) {
  return isAsciiLetterOrDigit(character) || character === '.' || character === '-';
}

function scanEmails(text) {
  const spans = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '@') {
      index += 1;
      continue;
    }
    let start = index;
    while (start > 0 && isEmailLocalCharacter(text[start - 1])) start -= 1;
    let end = index + 1;
    while (end < text.length && isEmailDomainCharacter(text[end])) end += 1;
    const previous = spans.at(-1);
    if (previous && start < previous.end) {
      previous.start = Math.min(previous.start, start);
      previous.end = Math.max(previous.end, end);
    } else {
      spans.push({ start, end });
    }
    index = Math.max(index + 1, end);
  }
  return spans;
}

function validateEmail(value) {
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || domain.length > 253 ||
      local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return false;
  }
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!label || label.length > 63 || label.startsWith('-') ||
        label.endsWith('-') || !/^[A-Za-z0-9-]+$/u.test(label)) {
      return false;
    }
  }
  return true;
}

function findUrlStart(value) {
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] !== '/' || value[index + 1] !== '/') continue;
    if (index === 0 || value[index - 1] === ':' ||
        '=([{<\"\''.includes(value[index - 1])) {
      return index;
    }
  }
  return -1;
}

function scanIpv4(text) {
  const tokenMatcher = /\S+/gu;
  const candidateMatcher = /[0-9.]+/gu;
  const spans = [];
  for (let token = tokenMatcher.exec(text); token; token = tokenMatcher.exec(text)) {
    const urlStart = findUrlStart(token[0]);
    candidateMatcher.lastIndex = 0;
    for (let candidate = candidateMatcher.exec(token[0]); candidate;
      candidate = candidateMatcher.exec(token[0])) {
      if (urlStart >= 0 && candidate.index >= urlStart) continue;
      const start = token.index + candidate.index;
      spans.push({ start, end: start + candidate[0].length });
    }
  }
  return spans;
}

function validateIpv4(value, context) {
  const octets = value.split('.');
  if (octets.length !== 4) return false;
  for (const octet of octets) {
    if (!isDigits(octet) || (octet.length > 1 && octet[0] === '0') ||
        Number(octet) > 255) {
      return false;
    }
  }
  const before = context.text.slice(Math.max(0, context.start - 16), context.start);
  const after = context.text.slice(context.end, context.end + 1);
  return !/[A-Za-z0-9.-]$/u.test(before) &&
    !/^[A-Za-z0-9./-]/u.test(after) &&
    !/[A-Za-z][A-Za-z0-9+.-]*:\/\/$/u.test(before);
}

// ?쒓뎅 二쇰??깅줉踰덊샇: YYMMDD ??二쇰? 援щ텇 ?レ옄(0~4, 9)? ?꾩쓽 6?먮━瑜?蹂댄샇?쒕떎.
// ?섏씠?덉? ?앸뀈?붿씪 ????媛쒕쭔 ?덉슜?섍퀬 ?ㅼ젣 ?좎쭨? ?レ옄 寃쎄퀎瑜?寃利앺븳??
// 2020-10-12 ?댄썑 ??6?먮━???꾩쓽媛믪씠誘濡?援ы삎 泥댄겕?ъ? ?붽뎄?섏? ?딅뒗??
const RULES = [{
  id: 'kr_resident_registration_number',
  label: 'Korean resident registration number',
  mode: 'restore',
  scan: scanKoreanIdentifiers,
  validate: validateResident
},

// ?멸뎅?몃벑濡앸쾲?? YYMMDD ???멸뎅??援щ텇 ?レ옄(5~8)? ?섎㉧吏 ?レ옄瑜?蹂댄샇?쒕떎.
// ?섏씠???좊Т, ?ㅼ젣 ?좎쭨, ?レ옄 寃쎄퀎? ?멸뎅?몃벑濡앸쾲??泥댄겕?ъ쓣 寃利앺븳??
// 二쇰??깅줉踰덊샇 泥댄겕?ш낵 ?명꽣?룹뿉??蹂듭궗??以묎컙 ?レ옄 吏앹닔 議곌굔? ?ъ슜?섏? ?딅뒗??
{
  id: 'kr_foreigner_registration_number',
  label: 'Korean foreigner registration number',
  mode: 'restore',
  scan: scanKoreanIdentifiers,
  validate: validateForeigner
},

// 寃곗젣 移대뱶踰덊샇: 13~19?먮━ ?レ옄? ?쇨???怨듬갚 ?먮뒗 ?섏씠??援щ텇 ?뺤떇??蹂댄샇?쒕떎.
// ?レ옄 寃쎄퀎? Luhn 泥댄겕?ъ쓣 寃利앺븯怨??쇳빀 援щ텇?먯? ?섎せ??泥댄겕?ъ? ?쒖쇅?쒕떎.
{
  id: 'payment_card_number',
  label: 'Payment card number',
  mode: 'restore',
  scan: scanCards,
  validate: validateCard
},

// ?쒓뎅 ?꾪솕踰덊샇: 010, 02, ?좏슚 吏??쾲?몄? 070 踰덊샇瑜??곗냽/怨듬갚/?섏씠???뺤떇?쇰줈 蹂댄샇?쒕떎.
// 洹몃９ 湲몄씠? ?쇨???援щ텇?먮? 寃利앺븯怨?援ы삎 ?대룞?꾪솕, 050x, 080, ??쒕쾲?몃뒗 ?쒖쇅?쒕떎.
{
  id: 'kr_phone_number',
  label: 'Korean phone number',
  mode: 'restore',
  scan: scanPhones
},

// ?대찓??二쇱냼: 蹂댁닔?곸씤 ASCII 濡쒖뺄?뚰듃? ?먯씠 ?ы븿???꾨찓???뺤떇??蹂댄샇?쒕떎.
// 濡쒖뺄?뚰듃/?꾨찓??湲몄씠? ?먃룻븯?댄뵂 寃쎄퀎瑜?寃利앺븯怨??꾩껜 RFC 援щЦ怨?URL? 吏?먰븯吏 ?딅뒗??
{
  id: 'email_address',
  label: 'Email address',
  mode: 'restore',
  scan: scanEmails,
  validate: validateEmail
},

// IPv4 二쇱냼: ?먯쑝濡?援щ텇???뺥솗????媛쒖쓽 10吏꾩닔 ?ν뀩??蹂댄샇?쒕떎.
// 媛??ν뀩 0~255? ?レ옄쨌??寃쎄퀎瑜?寃利앺븯怨?URL ?대? 二쇱냼? ?몄뒪?몃챸? ?쒖쇅?쒕떎.
{
  id: 'ipv4_address',
  label: 'IPv4 address',
  mode: 'restore',
  scan: scanIpv4,
  validate: validateIpv4
}];

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

function scanRule(rule, text) {
  if (typeof rule.pattern === 'string') {
    const matcher = new RegExp(rule.pattern, 'gu');
    const spans = [];
    for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
    return spans;
  }
  return validateScannedSpans(rule.scan(text), text.length);
}

function mergeClaims(left, right) {
  const merged = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    if (rightIndex >= right.length ||
        (leftIndex < left.length && left[leftIndex].start <= right[rightIndex].start)) {
      merged.push(left[leftIndex]);
      leftIndex += 1;
    } else {
      merged.push(right[rightIndex]);
      rightIndex += 1;
    }
  }
  return merged;
}

function collectClaims(definitions, text) {
  let claims = [];
  for (const rule of definitions) {
    const accepted = [];
    const spans = scanRule(rule, text);
    let claimIndex = 0;
    for (const span of spans) {
      while (claimIndex < claims.length && claims[claimIndex].end <= span.start) {
        claimIndex += 1;
      }
      if (claimIndex < claims.length && claims[claimIndex].start < span.end) {
        continue;
      }
      if (rule.validate !== undefined) {
        const verdict = rule.validate(text.slice(span.start, span.end), {
          text,
          start: span.start,
          end: span.end
        });
        if (verdict === false) continue;
        if (verdict !== true) throw new Error('PII rule validator result is invalid');
      }
      accepted.push({ ...span, rule });
    }
    claims = mergeClaims(claims, accepted);
  }
  return claims;
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
    if (rule.validate !== undefined && typeof rule.validate !== 'function') {
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

function transformationLimit() {
  return new ApiError(
    413,
    'PII transformation limit exceeded',
    'request_too_large'
  );
}

function tokenForClaim(context, rule, value) {
  if (rule.mode !== 'restore') return '[REDACTED]';
  const bytes = Buffer.byteLength(value, 'utf8');
  if (context.restorableBytes + bytes > MAX_RESTORABLE_BYTES) {
    throw transformationLimit();
  }
  context.restorableBytes += bytes;
  const existing = context.tokenByPii.get(value);
  if (existing !== undefined) return existing;
  if (context.tokenByPii.size >= MAX_UNIQUE_VALUES ||
      context.nextCounter > MAX_COUNTER) {
    throw transformationLimit();
  }
  const token = context.prefix + rule.id + ':' +
    String(context.nextCounter).padStart(6, '0') + ']]';
  context.nextCounter += 1;
  context.tokenByPii.set(value, token);
  context.restoreByToken.set(token, value);
  return token;
}

function transformText(text, claims, context) {
  const chunks = [];
  let cursor = 0;
  for (const claim of claims) {
    chunks.push(text.slice(cursor, claim.start));
    const value = text.slice(claim.start, claim.end);
    chunks.push(tokenForClaim(context, claim.rule, value));
    cursor = claim.end;
  }
  chunks.push(text.slice(cursor));
  return chunks.join('');
}

function applyInputFilter(body) {
  let context = null;
  try {
    const textValues = [];
    forEachChatText(body, (target, field) => {
      textValues.push(target[field]);
    });
    const collected = textValues.map((text) => collectClaims(RULES, text));
    if (collected.every((claims) => claims.length === 0)) {
      return { body, context: null };
    }
    context = createContext(textValues);
    const transformed = textValues.map((text, index) =>
      transformText(text, collected[index], context)
    );
    const clone = structuredClone(body);
    let index = 0;
    forEachChatText(clone, (target, field) => {
      target[field] = transformed[index];
      index += 1;
    });
    return { body: clone, context };
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
}

module.exports = {
  getRuleMetadata,
  validateRuleDefinitions,
  applyInputFilter,
  clearContext
};
