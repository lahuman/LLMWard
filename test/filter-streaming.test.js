const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-filter-streaming-'));
const databasePath = path.join(temporaryDirectory, 'filter-streaming.db');
const adminKey = crypto.randomBytes(32).toString('base64url');

process.env.ADMIN_SECRET_KEY = adminKey;
process.env.DATABASE_PATH = databasePath;
process.env.LLMWARD_PROVIDER_TIMEOUT_MS = '3000';
process.env.LOG_LEVEL = 'silent';

const config = require('../config');
const { state } = require('../services/limits');

let gatewayServer;
let providerServer;
let baseUrl;
let providerBaseUrl;
let db;
let user;
let providerId;
let modelId;
let providerHandler;
let providerEvents;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request(route, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let body = null;
  try { body = await response.json(); } catch {}
  return { status: response.status, body, headers: response.headers };
}

function admin(route, options = {}) {
  return request(route, {
    ...options,
    headers: { 'X-Admin-Key': adminKey, ...(options.headers || {}) }
  });
}

function streamRequest(overrides = {}) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'filter-streaming',
      stream: true,
      max_tokens: 20,
      messages: [{ role: 'user', content: 'ordinary' }], ...overrides
    })
  });
}

function addOutputFilter(patterns) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO content_filters
      (name, patterns, input_action, output_action, is_active, is_global, created_at, updated_at)
    VALUES (?, ?, NULL, 'mask', 1, 1, ?, ?)
  `).run(crypto.randomUUID(), JSON.stringify(patterns), now, now);

  return Number(result.lastInsertRowid);
}

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

function addInputOnlyFilter(patterns) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO content_filters
      (name, patterns, input_action, output_action, is_active, is_global, created_at, updated_at)
    VALUES (?, ?, 'mask', NULL, 1, 1, ?, ?)
  `).run(crypto.randomUUID(), JSON.stringify(patterns), now, now);
}

function requestLogs() {
  return db.prepare(`
    SELECT status, error_type, input_tokens, output_tokens, total_tokens
    FROM request_logs ORDER BY id
  `).all();
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function writeChunks(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  for (const chunk of chunks) {
    res.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
  res.end();
}

async function partialBodyUntilFailure(response) {
  const chunks = [];
  const reader = response.body.getReader();
  await assert.rejects(async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      chunks.push(Buffer.from(value));
    }
  });
  return Buffer.concat(chunks);
}

function splitBuffer(buffer, positions) {
  const chunks = [];
  let offset = 0;
  for (const position of positions) {
    chunks.push(buffer.subarray(offset, position));
    offset = position;
  }
  chunks.push(buffer.subarray(offset));
  return chunks.filter((chunk) => chunk.length > 0);
}

function dataEvents(text) {
  const values = [];
  for (const rawEvent of text.split(/\r?\n\r?\n/)) {
    if (!rawEvent) continue;
    const data = rawEvent.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data.trim() === '[DONE]') continue;
    values.push(JSON.parse(data));
  }
  return values;
}

function streamedContent(events, choiceIndex) {
  return events.flatMap((event) => event.choices || [])
    .filter((choice) => choice.index === choiceIndex && typeof choice.delta?.content === 'string')
    .map((choice) => choice.delta.content)
    .join('');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function useStreamingTimeouts(t, values) {
  const previous = {
    providerTimeoutMs: config.providerTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    streamMaxDurationMs: config.streamMaxDurationMs
  };
  Object.assign(config, values);
  t.after(() => { Object.assign(config, previous); });
}

async function writeActiveEvents(res, contents) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  res.flushHeaders();
  for (const content of contents) {
    await delay(50);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
  }
  res.write('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
  res.end('data: [DONE]\n\n');
}

async function waitForReleasedResources() {
  await waitFor(
    () => db.prepare(
      'SELECT COUNT(*) FROM quota_reservations WHERE user_id = ?'
    ).pluck().get(user.id) === 0 &&
      state().users[user.id] === undefined &&
      state().models['filter-streaming'] === undefined &&
      state().providers[providerId] === undefined,
    'stream timeout cleanup did not finish'
  );
}

function timeoutFailureLog() {
  return {
    status: 'failure', error_type: 'timeout',
    input_tokens: 0, output_tokens: 0, total_tokens: 0
  };
}

before(async () => {
  providerEvents = new EventEmitter();
  providerServer = http.createServer(async (req, res) => {
    if (req.url !== '/chat/completions' || req.method !== 'POST') {
      res.writeHead(404);
      return res.end();
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    await providerHandler(req, res, payload);
  });
  await listen(providerServer);
  providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;

  const app = require('../app');
  db = require('../db/database');
  gatewayServer = http.createServer(app);
  await listen(gatewayServer);
  baseUrl = `http://127.0.0.1:${gatewayServer.address().port}`;

  const provider = await admin('/admin/providers', {
    method: 'POST',
    body: {
      provider_name: 'filter-streaming-provider',
      display_name: 'Filter streaming provider',
      base_url: providerBaseUrl,
      auth_type: 'none'
    }
  });
  assert.equal(provider.status, 201);
  providerId = provider.body.id;
  const model = await admin('/admin/models', {
    method: 'POST',
    body: {
      model_name: 'filter-streaming',
      display_name: 'Filter streaming',
      provider_id: providerId,
      max_tokens: 20
    }
  });
  assert.equal(model.status, 201);
  modelId = model.body.id;
  const createdUser = await admin('/admin/users', {
    method: 'POST',
    body: {
      username: 'filter-streaming-user',
      max_daily_input_tokens: 10000,
      max_daily_output_tokens: 10000,
      allowed_models: []
    }
  });
  assert.equal(createdUser.status, 201);
  user = { id: createdUser.body.userId, token: createdUser.body.apiToken };
});

beforeEach(() => {
  db.exec(`
    DELETE FROM content_filter_models;
    DELETE FROM content_filters;
    DELETE FROM quota_reservations;
    DELETE FROM usage_logs;
    DELETE FROM request_logs;
    DELETE FROM app_settings WHERE setting_key = 'built_in_pii_filter_active';
  `);
  providerEvents.removeAllListeners();
  providerHandler = async (req, res) => writeChunks(res, [
    'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
    'data: [DONE]\n\n'
  ]);
});

after(async () => {
  await close(gatewayServer);
  await close(providerServer);
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('no output filter keeps the byte-transparent relay, including malformed data and CRLF', async () => {
  addInputOnlyFilter(['ordinary']);
  const original = Buffer.concat([
    Buffer.from('event: vendor\r\ndata: {not-json}\r\n\r\n'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('\r\ndata: [DONE]\r\n\r\n')
  ]);
  providerHandler = async (req, res) => writeChunks(res, splitBuffer(original, [1, 7, 31, 36]));

  const response = await streamRequest();
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  assert.deepEqual(requestLogs(), [{
    status: 'success', error_type: null, input_tokens: 0, output_tokens: 0, total_tokens: 0
  }]);
});

test('active filtering masks split literal content per choice and preserves tool, vendor, and usage fields', async () => {
  addOutputFilter(['foo', 'foobar', 'a.b', '秘密']);
  const source = [
    'data: {"id":"one","choices":[{"index":0,"delta":{"content":"FOO"},"vendor_choice":{"keep":1}}],"vendor_top":"keep"}\r\n\r\n',
    'data: {"choices":[{"index":1,"delta":{"content":"fo"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"BAR / A"}}]}\r\n\r\n',
    'data: {"choices":[{"index":1,"delta":{"content":"x","tool_calls":[{"function":{"arguments":"foo"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":".B / 秘"}}]}\r\n\r\n',
    'data: {"choices":[{"index":0,"delta":{"content":"密 / foo"}}]}\n\n',
    'data: {"choices":[],\r\n',
    'data: "usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7},"vendor_usage":"keep"}\r\n\r\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop","vendor_finish":true},{"index":1,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\r\n\r\n'
  ].join('');
  const bytes = Buffer.from(source);
  const firstDelimiter = bytes.indexOf(Buffer.from('\r\n\r\n'));
  const secondDataField = bytes.indexOf(Buffer.from('data:'), firstDelimiter + 4);
  const multiDataField = bytes.indexOf(Buffer.from('data: "usage"'));
  const secretOffset = bytes.indexOf(Buffer.from('秘密'));
  const splitPositions = [...new Set([
    1,
    secondDataField + 2,
    secondDataField + 5,
    firstDelimiter + 1,
    firstDelimiter + 2,
    firstDelimiter + 3,
    multiDataField + 2,
    multiDataField + 5,
    secretOffset + 1,
    secretOffset + 2,
    secretOffset + 4,
    secretOffset + 5,
    bytes.length - 3,
    bytes.length - 1
  ])].filter((value) => value > 0 && value < bytes.length).sort((left, right) => left - right);
  providerHandler = async (req, res) => writeChunks(res, splitBuffer(bytes, splitPositions));

  const response = await streamRequest();
  assert.equal(response.status, 200);
  const text = await response.text();
  const events = dataEvents(text);
  assert.equal(streamedContent(events, 0), '[FILTERED] / [FILTERED] / [FILTERED] / [FILTERED]');
  assert.equal(streamedContent(events, 1), 'fox');
  const first = events.find((event) => event.id === 'one');
  assert.deepEqual(first.vendor_top, 'keep');
  assert.deepEqual(first.choices[0].vendor_choice, { keep: 1 });
  const tool = events.flatMap((event) => event.choices || [])
    .find((choice) => Array.isArray(choice.delta?.tool_calls));
  assert.equal(tool.delta.tool_calls[0].function.arguments, 'foo');
  const usage = events.find((event) => event.usage);
  assert.deepEqual(usage.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  assert.equal(usage.vendor_usage, 'keep');
  const finish = events.flatMap((event) => event.choices || []).find((choice) => choice.finish_reason === 'stop');
  assert.equal(finish.vendor_finish, true);
  assert.ok(text.includes('[DONE]'));
  assert.deepEqual(requestLogs(), [{
    status: 'success', error_type: null, input_tokens: 3, output_tokens: 4, total_tokens: 7
  }]);
});

test('finish_reason flushes held content in that choice before the finish marker', async () => {
  addOutputFilter(['foobar']);
  providerHandler = async (req, res) => writeChunks(res, [
    'data: {"choices":[{"index":0,"delta":{"content":"foo"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"bar"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ]);

  const response = await streamRequest();
  const events = dataEvents(await response.text());
  const finish = events.flatMap((event) => event.choices || []).find((choice) => choice.finish_reason === 'stop');
  assert.equal(finish.delta.content, '[FILTERED]');
});

test('DONE flushes unfinished choices through synthetic content events before the marker', async () => {
  addOutputFilter(['foo', 'foobar']);
  providerHandler = async (req, res) => writeChunks(res, [
    'data: {"choices":[{"index":2,"delta":{"content":"foo"}}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n'
  ]);

  const response = await streamRequest();
  const text = await response.text();
  const events = dataEvents(text);
  const synthetic = events.flatMap((event) => event.choices || [])
    .find((choice) => choice.delta?.content === '[FILTERED]');
  assert.equal(streamedContent(events, 2), '[FILTERED]');
  assert.equal(synthetic.finish_reason, null);
  assert.ok(text.indexOf('[FILTERED]') < text.indexOf('[DONE]'));
});

test('clean EOF flushes unfinished choices through synthetic content events', async () => {
  addOutputFilter(['foo', 'foobar']);
  providerHandler = async (req, res) => writeChunks(res, [
    'data: {"choices":[{"index":0,"delta":{"content":"tail foo"}}]}\n\n'
  ]);

  const response = await streamRequest();
  const text = await response.text();
  const events = dataEvents(text);
  const synthetic = events.flatMap((event) => event.choices || [])
    .find((choice) => choice.finish_reason === null);
  assert.equal(streamedContent(events, 0), 'tail [FILTERED]');
  assert.equal(synthetic.delta.content, 'l [FILTERED]');
  assert.equal(synthetic.finish_reason, null);
  assert.equal(text.includes('[DONE]'), false);
});

for (const fixture of [
  { name: 'invalid JSON', chunks: ['data: {private-invalid-json}\n\n'] },
  { name: 'colonless empty data', chunks: ['data\n\n'] },
  { name: 'invalid UTF-8', chunks: [Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28, 0x0a, 0x0a])] },
  { name: 'invalid choice index', chunks: ['data: {"choices":[{"index":"private-index","delta":{"content":"foo"}}]}\n\n'] },
  { name: 'unterminated event', chunks: ['data: {"choices":[]}'] }
]) {
  test(`active filtering fails closed before headers for ${fixture.name}`, async () => {
    addOutputFilter(['foo']);
    providerHandler = async (req, res) => writeChunks(res, fixture.chunks);

    const response = await streamRequest();
    assert.equal(response.status, 502);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    const body = await response.json();
    assert.equal(body.code, 'filter_processing_failed');
    assert.equal(JSON.stringify(body).includes('private'), false);
    assert.deepEqual(requestLogs(), [{
      status: 'failure', error_type: 'filter', input_tokens: 0, output_tokens: 0, total_tokens: 0
    }]);
    assert.equal(db.prepare('SELECT COUNT(*) FROM quota_reservations').pluck().get(), 0);
  });
}

test('usage is read before a same-event filter failure and charged exactly once', async () => {
  addOutputFilter(['foo']);
  providerHandler = async (req, res) => writeChunks(res, [
    'data: {"usage":{"prompt_tokens":5,"completion_tokens":6,"total_tokens":11},"choices":[{"index":"private-index","delta":{}}]}\n\n'
  ]);

  const response = await streamRequest();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'filter_processing_failed');
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'filter', input_tokens: 5, output_tokens: 6, total_tokens: 11
  }]);
  assert.deepEqual(db.prepare(`
    SELECT input_tokens, output_tokens, total_tokens FROM usage_logs WHERE user_id = ?
  `).get(user.id), { input_tokens: 5, output_tokens: 6, total_tokens: 11 });
  assert.equal(db.prepare('SELECT COUNT(*) FROM quota_reservations').pluck().get(), 0);
});

test('active filtering preserves upstream, quota, and concurrency cleanup on disconnect', async (t) => {
  addOutputFilter(['foo']);
  setBuiltInPiiActive();
  const resident = '000229-3123456';
  let providerContent;
  let interval;
  let upstreamClosed = false;
  providerHandler = async (req, res, payload) => {
    providerContent = payload.messages[0].content;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.on('close', () => {
      upstreamClosed = true;
      clearInterval(interval);
      providerEvents.emit('closed');
    });
    providerEvents.emit('started');
    let sequence = 0;
    interval = setInterval(() => {
      res.write(`data: {"choices":[{"index":0,"delta":{"content":"safe-${sequence++}-"}}]}\n\n`);
    }, 1);
  };

  const started = once(providerEvents, 'started', { signal: AbortSignal.timeout(3000) });
  const closed = once(providerEvents, 'closed', { signal: AbortSignal.timeout(3000) });
  const client = http.request(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json'
    }
  });
  client.on('error', () => {});
  client.on('response', (response) => {
    response.once('error', () => {});
    client.destroy();
  });
  client.end(JSON.stringify({
    model: 'filter-streaming', stream: true, max_tokens: 20,
    messages: [{ role: 'user', content: resident }]
  }));
  t.after(() => {
    clearInterval(interval);
    client.destroy();
  });

  await started;
  await closed;
  await waitFor(
    () => db.prepare('SELECT COUNT(*) FROM quota_reservations WHERE user_id = ?').pluck().get(user.id) === 0,
    'disconnect reservation cleanup did not finish'
  );
  assert.equal(upstreamClosed, true);
  assert.equal(providerContent.includes(resident), false);
  assert.match(providerContent, /^\[\[LLMWARD:/u);
  assert.equal(state().users[user.id], undefined);
  assert.equal(state().models['filter-streaming'], undefined);
  assert.equal(state().providers[providerId], undefined);
  assert.equal(modelId > 0, true);
});

test('overlapping matches keep leftmost priority across several content events', async () => {
  addOutputFilter(['aba', 'bab']);
  providerHandler = async (req, res) => writeChunks(res, [
    'data: {"choices":[{"index":0,"delta":{"content":"ab"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"b"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ]);

  const response = await streamRequest();
  assert.equal(response.status, 200);
  assert.equal(streamedContent(dataEvents(await response.text()), 0), '[FILTERED]b');
});

test('non-text null delta content is preserved', async () => {
  addOutputFilter(['foo']);
  providerHandler = async (req, res) => writeChunks(res, [
    'data: {"choices":[{"index":0,"delta":{"content":null,"vendor_delta":"keep"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ]);

  const response = await streamRequest();
  const choice = dataEvents(await response.text()).flatMap((event) => event.choices || [])[0];
  assert.equal(choice.delta.content, null);
  assert.equal(choice.delta.vendor_delta, 'keep');
});

test('filtered output is relayed before the provider finishes', async (t) => {
  addOutputFilter(['secret']);
  let releaseProvider;
  const gate = new Promise((resolve) => { releaseProvider = resolve; });
  t.after(() => releaseProvider());
  providerHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"visible-prefix-xxxxxxxx"}}]}\n\n');
    providerEvents.emit('waiting');
    await gate;
    res.end('data: [DONE]\n\n');
  };

  const waiting = once(providerEvents, 'waiting', { signal: AbortSignal.timeout(3000) });
  const responsePromise = streamRequest();
  await waiting;
  const response = await Promise.race([
    responsePromise,
    new Promise((resolve, reject) => setTimeout(
      () => reject(new Error('filtered prefix was buffered until provider completion')),
      1000
    ))
  ]);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise((resolve, reject) => setTimeout(
      () => reject(new Error('filtered prefix was not relayed incrementally')),
      1000
    ))
  ]);
  assert.match(new TextDecoder().decode(first.value), /visible-prefix/);
  releaseProvider();
  while (!(await reader.read()).done) {}
});

test('a valid event is committed before a coalesced invalid event closes the stream', async () => {
  addOutputFilter(['foo']);
  providerHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.end(
      'data: {"choices":[{"index":0,"delta":{"content":"visible"}}]}\n\n' +
      'data: {private-invalid-json}\n\n'
    );
  };

  const response = await streamRequest();
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
  await waitFor(() => requestLogs().length === 1, 'coalesced filter failure was not finalized');
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'filter', input_tokens: 0, output_tokens: 0, total_tokens: 0
  }]);
});

test('an invalid filtered event aborts an upstream stream that remains open', async () => {
  addOutputFilter(['foo']);
  let upstreamClosed = false;
  providerHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const closed = once(res, 'close');
    res.write('data: {private-invalid-json}\n\n');
    providerEvents.emit('invalid-sent');
    await closed;
    upstreamClosed = true;
    providerEvents.emit('invalid-closed');
  };

  const sent = once(providerEvents, 'invalid-sent', { signal: AbortSignal.timeout(3000) });
  const closed = once(providerEvents, 'invalid-closed', { signal: AbortSignal.timeout(3000) });
  const responsePromise = streamRequest();
  await sent;
  const response = await responsePromise;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'filter_processing_failed');
  await closed;
  assert.equal(upstreamClosed, true);
});

test('an oversized unterminated filtered event fails closed and aborts upstream', async () => {
  addOutputFilter(['foo']);
  const eventByteLimit = 1024 * 1024;
  let upstreamClosed = false;
  providerHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const closed = once(res, 'close');
    res.write(Buffer.alloc(eventByteLimit + 1, 0x78));
    providerEvents.emit('oversized-sent');
    await closed;
    upstreamClosed = true;
    providerEvents.emit('oversized-closed');
  };

  const sent = once(providerEvents, 'oversized-sent', { signal: AbortSignal.timeout(5000) });
  const closed = once(providerEvents, 'oversized-closed', { signal: AbortSignal.timeout(5000) });
  const responsePromise = streamRequest();
  await sent;
  const response = await responsePromise;

  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'filter_processing_failed');
  await closed;
  assert.equal(upstreamClosed, true);
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'filter', input_tokens: 0, output_tokens: 0, total_tokens: 0
  }]);
  assert.equal(db.prepare('SELECT COUNT(*) FROM quota_reservations').pluck().get(), 0);
});

test('many small filtered transport chunks do not recopy the accumulated event quadratically', async (t) => {
  addOutputFilter(['foo']);
  const content = 'x'.repeat(8 * 1024);
  const event = Buffer.from(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\n`
  );
  providerHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    for (const byte of event) {
      res.write(Buffer.from([byte]));
      await new Promise((resolve) => setImmediate(resolve));
    }
    res.end('data: [DONE]\n\n');
  };

  const nativeConcat = Buffer.concat;
  let concatCalls = 0;
  let concatenatedBytes = 0;
  Buffer.concat = function (parts, ...args) {
    if (Array.isArray(parts) && parts.every(Buffer.isBuffer)) {
      concatCalls += 1;
      concatenatedBytes += parts.reduce((total, part) => total + part.length, 0);
    }
    return nativeConcat.call(this, parts, ...args);
  };
  t.after(() => { Buffer.concat = nativeConcat; });

  const response = await streamRequest();
  assert.equal(response.status, 200);
  assert.equal(streamedContent(dataEvents(await response.text()), 0), content);
  assert.ok(concatCalls <= 2, `expected at most two event assemblies, got ${concatCalls}`);
  assert.ok(
    concatenatedBytes <= event.length * 3,
    `expected linear event assembly, copied ${concatenatedBytes} bytes for ${event.length} input bytes`
  );
});

test('a near-limit UTF-8 filtered event survives split CRLF and LF delimiters', async () => {
  addOutputFilter(['???']);
  const eventByteLimit = 1024 * 1024;
  const makeEvent = (content) => Buffer.from(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\r\n\r\n`
  );
  const overhead = makeEvent('').length;
  const secret = '???';
  const content = 'x'.repeat(eventByteLimit - overhead - Buffer.byteLength(secret)) + secret;
  const event = makeEvent(content);
  const done = Buffer.from('data: [DONE]\n\n');
  const source = Buffer.concat([event, done]);
  const secretOffset = event.indexOf(Buffer.from(secret));
  const splitPositions = [
    secretOffset + 1,
    secretOffset + 2,
    secretOffset + 4,
    secretOffset + 5,
    event.length - 3,
    event.length - 2,
    event.length - 1,
    event.length + done.length - 1
  ];
  providerHandler = async (req, res) => writeChunks(res, splitBuffer(source, splitPositions));

  assert.equal(event.length, eventByteLimit);
  const response = await streamRequest();
  assert.equal(response.status, 200);
  assert.equal(
    streamedContent(dataEvents(await response.text()), 0),
    `${'x'.repeat(eventByteLimit - overhead - Buffer.byteLength(secret))}[FILTERED]`
  );
});

test('active filtering waits for drain after downstream backpressure', async (t) => {
  addOutputFilter(['foo']);
  let writeReturnedFalse = false;
  let drainWaited = false;
  const originalWrite = http.ServerResponse.prototype.write;
  const originalOnce = http.ServerResponse.prototype.once;
  http.ServerResponse.prototype.write = function (...args) {
    const result = originalWrite.apply(this, args);
    if (this.getHeader('X-Accel-Buffering') === 'no' && !result) writeReturnedFalse = true;
    return result;
  };
  http.ServerResponse.prototype.once = function (eventName, ...args) {
    if (this.getHeader('X-Accel-Buffering') === 'no' && eventName === 'drain') drainWaited = true;
    return originalOnce.call(this, eventName, ...args);
  };
  t.after(() => {
    http.ServerResponse.prototype.write = originalWrite;
    http.ServerResponse.prototype.once = originalOnce;
  });
  const content = 'x'.repeat(128 * 1024);
  providerHandler = async (req, res) => writeChunks(res, [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n'
  ]);

  const response = await streamRequest();
  assert.equal(response.status, 200);
  assert.equal(streamedContent(dataEvents(await response.text()), 0), content);
  assert.equal(writeReturnedFalse, true);
  assert.equal(drainWaited, true);
});

test('a valid usage event is written and charged before coalesced invalid UTF-8 fails', async (t) => {
  addOutputFilter(['foo']);
  const writtenChunks = [];
  const originalWrite = http.ServerResponse.prototype.write;
  http.ServerResponse.prototype.write = function (chunk, ...args) {
    if (this.getHeader('X-Accel-Buffering') === 'no') {
      writtenChunks.push(Buffer.from(chunk));
    }
    return originalWrite.call(this, chunk, ...args);
  };
  t.after(() => {
    http.ServerResponse.prototype.write = originalWrite;
  });
  const payload = Buffer.concat([
    Buffer.from(
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":6,"total_tokens":11}}\r\n\n'
    ),
    Buffer.from('data: '),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('\n\r\n')
  ]);
  providerHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.end(payload);
  };

  const response = await streamRequest();
  assert.equal(response.status, 200);
  await partialBodyUntilFailure(response);
  assert.match(Buffer.concat(writtenChunks).toString('utf8'), /"prompt_tokens":5/);
  await waitFor(() => requestLogs().length === 1, 'invalid UTF-8 failure was not finalized');
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'filter', input_tokens: 5, output_tokens: 6, total_tokens: 11
  }]);
  assert.deepEqual(db.prepare(`
    SELECT input_tokens, output_tokens, total_tokens FROM usage_logs WHERE user_id = ?
  `).get(user.id), { input_tokens: 5, output_tokens: 6, total_tokens: 11 });
});

test('filtered relay preserves byte-split blank and no-data events around DONE', async () => {
  addOutputFilter(['foo']);
  const chunks = [
    Buffer.from('\r'),
    Buffer.from('\n'),
    Buffer.from('data: [DONE]\n\n'),
    Buffer.from('\n'),
    Buffer.from(': allowed-after-done\r\n\r\n'),
    Buffer.from('\r'),
    Buffer.from('\n')
  ];
  const source = Buffer.concat(chunks);
  providerHandler = async (req, res) => writeChunks(res, chunks);

  const response = await streamRequest();
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), source);
  assert.deepEqual(requestLogs(), [{
    status: 'success', error_type: null, input_tokens: 0, output_tokens: 0, total_tokens: 0
  }]);
});

test('filtered relay permits non-data events after DONE but rejects colonless data', async () => {
  addOutputFilter(['foo']);
  providerHandler = async (req, res) => writeChunks(res, [
    'data: [DONE]\n\n',
    ': allowed-after-done\n\n',
    '\n',
    'database: still-not-data\n\n',
    'data\n\n'
  ]);

  const response = await streamRequest();
  assert.equal(response.status, 200);
  const partial = await partialBodyUntilFailure(response);
  assert.match(partial.toString('utf8'), /: allowed-after-done\n\n/);
  assert.match(partial.toString('utf8'), /database: still-not-data\n\n/);
  await waitFor(() => requestLogs().length === 1, 'post-DONE data failure was not finalized');
  assert.deepEqual(requestLogs(), [{
    status: 'failure', error_type: 'filter', input_tokens: 0, output_tokens: 0, total_tokens: 0
  }]);
});

test('filtered streaming creates one deterministic filter plan per stream', async () => {
  const pattern = 'stream-secret';
  addOutputFilter([pattern]);
  providerHandler = async (req, res) => writeChunks(res, [
    'data: {"choices":[{"index":0,"delta":{"content":"stream-"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"secret"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ]);
  const contentFilters = require('../services/content-filters');
  const originalCreateLiteralFilter = contentFilters.createLiteralFilter;
  let planCreations = 0;
  contentFilters.createLiteralFilter = function (patterns) {
    planCreations += 1;
    return originalCreateLiteralFilter(patterns);
  };
  let text;
  try {
    const response = await streamRequest();
    assert.equal(response.status, 200);
    text = await response.text();
  } finally {
    contentFilters.createLiteralFilter = originalCreateLiteralFilter;
  }

  assert.equal(streamedContent(dataEvents(text), 0), '[FILTERED]');
  assert.equal(planCreations, 1);
});

test('max-pattern streaming avoids full-text regular-expression scans', async () => {
  const patterns = Array.from(
    { length: 200 },
    (_, index) => 'a'.repeat(255) + String.fromCodePoint(0x1000 + index)
  );
  addOutputFilter(patterns);
  providerHandler = async (req, res) => writeChunks(res, [
    'data: {"choices":[{"index":0,"delta":{"content":"visible"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ]);
  const NativeRegExp = global.RegExp;
  let fullTextMatchers = 0;
  global.RegExp = class CountingRegExp extends NativeRegExp {
    constructor(source, flags) {
      super(source, flags);
      if (flags === 'giu') fullTextMatchers += 1;
    }
  };
  let text;
  try {
    const response = await streamRequest();
    assert.equal(response.status, 200);
    text = await response.text();
  } finally {
    global.RegExp = NativeRegExp;
  }

  assert.equal(streamedContent(dataEvents(text), 0), 'visible');
  assert.equal(fullTextMatchers, 0);
});

test('filtered pre-header idle timeout returns 504 and releases resources', async (t) => {
  useStreamingTimeouts(t, {
    providerTimeoutMs: 100,
    streamIdleTimeoutMs: 200,
    streamMaxDurationMs: 1000
  });
  addOutputFilter(['secret']);
  providerHandler = async (req, res) => {
    res.once('close', () => providerEvents.emit('pre-header-idle:closed'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    providerEvents.emit('pre-header-idle:started');
  };

  const started = once(providerEvents, 'pre-header-idle:started', { signal: AbortSignal.timeout(3000) });
  const closed = once(providerEvents, 'pre-header-idle:closed', { signal: AbortSignal.timeout(3000) });
  const responsePromise = streamRequest();
  await started;
  const response = await responsePromise;
  await closed;

  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'provider_timeout');
  await waitForReleasedResources();
  assert.deepEqual(requestLogs(), [timeoutFailureLog()]);
});

test('fragmented raw chunks keep a filtered stream alive before an SSE event completes', async (t) => {
  useStreamingTimeouts(t, {
    providerTimeoutMs: 100,
    streamIdleTimeoutMs: 300,
    streamMaxDurationMs: 2000
  });
  addOutputFilter(['secret']);
  const event = Buffer.from(
    'data: {"choices":[{"index":0,"delta":{"content":"secret-fragmented"}}]}\n\n'
  );
  const chunks = splitBuffer(event, [10, 20, 30, 40]);
  providerHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) await delay(100);
      res.write(chunks[index]);
    }
    res.write('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
    res.end('data: [DONE]\n\n');
  };

  const startedAt = Date.now();
  const response = await streamRequest();
  assert.equal(response.status, 200);
  const text = await response.text();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 300, `expected fragmented event to take at least 300 ms, got ${elapsed}`);
  assert.equal(text.includes('secret'), false);
  assert.ok(text.includes('[FILTERED]'));
  assert.ok(text.includes('[DONE]'));
  assert.deepEqual(requestLogs(), [{
    status: 'success', error_type: null, input_tokens: 1, output_tokens: 1, total_tokens: 2
  }]);
});

test('active transparent stream outlives the response-start timeout', async (t) => {
  useStreamingTimeouts(t, {
    providerTimeoutMs: 100,
    streamIdleTimeoutMs: 300,
    streamMaxDurationMs: 1000
  });
  providerHandler = async (req, res) => writeActiveEvents(
    res,
    ['safe-0', 'safe-1', 'safe-2', 'safe-3', 'safe-4']
  );

  const startedAt = Date.now();
  const response = await streamRequest();
  assert.equal(response.status, 200);
  const text = await response.text();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 200, `expected active stream to outlive 200 ms, got ${elapsed}`);
  assert.ok(text.includes('[DONE]'));
  assert.deepEqual(requestLogs(), [{
    status: 'success', error_type: null, input_tokens: 1, output_tokens: 1, total_tokens: 2
  }]);
});

test('post-header idle timeout destroys the connection after relayed bytes', async (t) => {
  useStreamingTimeouts(t, {
    providerTimeoutMs: 100,
    streamIdleTimeoutMs: 200,
    streamMaxDurationMs: 1000
  });
  let upstreamClosed = false;
  providerHandler = async (req, res) => {
    res.once('close', () => {
      upstreamClosed = true;
      providerEvents.emit('post-header-idle:closed');
    });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    res.write('data: {"choices":[{"index":0,"delta":{"content":"safe-partial"}}]}\n\n');
    providerEvents.emit('post-header-idle:started');
  };

  const started = once(providerEvents, 'post-header-idle:started', { signal: AbortSignal.timeout(3000) });
  const closed = once(providerEvents, 'post-header-idle:closed', { signal: AbortSignal.timeout(3000) });
  const startedAt = Date.now();
  const responsePromise = streamRequest();
  await started;
  const response = await responsePromise;
  assert.equal(response.status, 200);
  const partial = await partialBodyUntilFailure(response);
  const elapsed = Date.now() - startedAt;
  await closed;

  assert.ok(partial.length > 0);
  assert.equal(upstreamClosed, true);
  assert.ok(elapsed >= 150, `expected idle timeout after 150 ms, got ${elapsed}`);
  assert.ok(elapsed < 700, `expected idle timeout before 700 ms, got ${elapsed}`);
  await waitForReleasedResources();
  assert.deepEqual(requestLogs(), [timeoutFailureLog()]);
});

test('stream maximum duration aborts despite continued progress', async (t) => {
  useStreamingTimeouts(t, {
    providerTimeoutMs: 100,
    streamIdleTimeoutMs: 300,
    streamMaxDurationMs: 450
  });
  let interval;
  let upstreamClosed = false;
  providerHandler = async (req, res) => {
    res.once('close', () => {
      upstreamClosed = true;
      clearInterval(interval);
      providerEvents.emit('maximum-duration:closed');
    });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    let sequence = 0;
    interval = setInterval(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `safe-${sequence++}` } }] })}\n\n`);
    }, 50);
  };
  t.after(() => { clearInterval(interval); });

  const closed = once(providerEvents, 'maximum-duration:closed', { signal: AbortSignal.timeout(3000) });
  const startedAt = Date.now();
  const response = await streamRequest();
  assert.equal(response.status, 200);
  const partial = await partialBodyUntilFailure(response);
  const elapsed = Date.now() - startedAt;
  await closed;

  assert.ok(partial.length > 0);
  assert.equal(upstreamClosed, true);
  assert.ok(elapsed >= 350, `expected hard timeout after 350 ms, got ${elapsed}`);
  assert.ok(elapsed < 1000, `expected hard timeout before 1000 ms, got ${elapsed}`);
  await waitForReleasedResources();
  assert.deepEqual(requestLogs(), [timeoutFailureLog()]);
});

test('stream idle timeout bounds downstream backpressure', async (t) => {
  useStreamingTimeouts(t, {
    providerTimeoutMs: 100,
    streamIdleTimeoutMs: 200,
    streamMaxDurationMs: 1000
  });
  const originalWrite = http.ServerResponse.prototype.write;
  const originalOnce = http.ServerResponse.prototype.once;
  http.ServerResponse.prototype.write = function (...args) {
    const result = originalWrite.apply(this, args);
    if (this.getHeader('X-Accel-Buffering') === 'no') return false;
    return result;
  };
  http.ServerResponse.prototype.once = function (eventName, ...args) {
    if (this.getHeader('X-Accel-Buffering') === 'no' && eventName === 'drain') return this;
    return originalOnce.call(this, eventName, ...args);
  };
  t.after(() => {
    http.ServerResponse.prototype.write = originalWrite;
    http.ServerResponse.prototype.once = originalOnce;
  });

  let interval;
  let upstreamClosed = false;
  providerHandler = async (req, res) => {
    res.once('close', () => {
      upstreamClosed = true;
      clearInterval(interval);
      providerEvents.emit('idle-backpressure:closed');
    });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    let sequence = 0;
    const writeEvent = () => {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `safe-${sequence++}` } }] })}\n\n`);
    };
    writeEvent();
    interval = setInterval(writeEvent, 25);
  };
  t.after(() => { clearInterval(interval); });

  const closed = once(providerEvents, 'idle-backpressure:closed', { signal: AbortSignal.timeout(3000) });
  const startedAt = Date.now();
  const response = await streamRequest();
  assert.equal(response.status, 200);
  const partial = await partialBodyUntilFailure(response);
  const elapsed = Date.now() - startedAt;
  await closed;

  assert.ok(partial.length > 0);
  assert.equal(upstreamClosed, true);
  assert.ok(elapsed >= 150, `expected backpressure idle timeout after 150 ms, got ${elapsed}`);
  assert.ok(elapsed < 700, `expected backpressure idle timeout before 700 ms, got ${elapsed}`);
  await waitForReleasedResources();
  assert.deepEqual(requestLogs(), [timeoutFailureLog()]);
});


test('request-owned PII stream restoration survives byte and event token splits', async () => {
  const resident = '000229-3123456';
  let placeholder;
  setBuiltInPiiActive();
  providerHandler = async (req, res, payload) => {
    placeholder = payload.messages[0].content;
    const parts = [
      placeholder.slice(0, 8),
      placeholder.slice(8, 25),
      placeholder.slice(25, -2),
      placeholder.slice(-2)
    ];
    const source = parts.map((content, index) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: index === 3 ? 'stop' : null }] })}\n\n`
    );
    await writeChunks(res, source.concat('data: [DONE]\n\n'));
  };

  const response = await streamRequest({ messages: [{ role: 'user', content: resident }] });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(streamedContent(dataEvents(text), 0), resident);
  assert.equal(text.includes(placeholder), false);
});


test('request-owned PII streaming handles interleaving, terminal flushes, and token splits', async () => {
  const resident = '000229-3123456';
  const secret = 'AKIAABCDEFGHIJKLMNOP';
  setBuiltInPiiActive();
  let requestNumber = 0;
  providerHandler = async (req, res, payload) => {
    requestNumber += 1;
    const providerContent = payload.messages[0].content;
    assert.equal(providerContent.includes(resident), false);
    assert.equal(providerContent.includes(secret), false);
    const tokens = providerContent.match(/\[\[LLMWARD:[^\]]+\]\]/gu);
    const piiToken = tokens.find((token) => token.includes(':kr_resident_registration_number:'));
    const secretToken = tokens.find((token) => token.includes(':aws_access_key_id:'));
    if (requestNumber === 2) {
      const event = Buffer.from('data: ' + JSON.stringify({
        choices: [{ index: 0, delta: { content: piiToken } }]
      }) + '\n\n');
      await writeChunks(res, splitBuffer(event, [1, 6, event.length - 1]));
      return;
    }

    const fabricated = piiToken.replace(/:\d{6}\]\]$/u, ':999999]]');
    const partial = piiToken.slice(0, -2);
    const event = (choices) => 'data: ' + JSON.stringify({ choices }) + '\n\n';
    const parts = [
      event([{ index: 0, delta: { content: piiToken.slice(0, 9) } }]),
      event([{ index: 1, delta: { content: secretToken.slice(0, 17) } }]),
      event([{ index: 2, delta: { content: fabricated + ' / ' + partial }, finish_reason: 'stop' }]),
      event([{ index: 0, delta: { content: piiToken.slice(9) }, finish_reason: 'stop' }]),
      event([{ index: 1, delta: { content: secretToken.slice(17) } }]),
      'data: [DONE]\n\n'
    ];
    const source = Buffer.from(parts.join(''));
    await writeChunks(res, splitBuffer(source, [1, 5, 23, source.length - 3]));
  };

  let response = await streamRequest({
    messages: [{ role: 'user', content: resident + ' ' + secret }]
  });
  assert.equal(response.status, 200);
  let events = dataEvents(await response.text());
  assert.equal(streamedContent(events, 0), resident);
  assert.equal(streamedContent(events, 1), '[FILTERED]');
  const untouched = streamedContent(events, 2);
  assert.match(untouched, /:999999\]\] \/ \[\[LLMWARD:/u);
  assert.equal(untouched.endsWith(']]'), false);

  response = await streamRequest({
    messages: [{ role: 'user', content: resident + ' ' + secret }]
  });
  assert.equal(response.status, 200);
  events = dataEvents(await response.text());
  assert.equal(streamedContent(events, 0), resident);
  assert.equal(requestNumber, 2);
});

test('mapping-only malformed and oversized SSE fail closed with one safe log each', async () => {
  const resident = '000229-3123456';
  setBuiltInPiiActive();
  const fixtures = [
    [Buffer.from('data: {private-invalid-json}\n\n')],
    [Buffer.alloc(1024 * 1024 + 1, 0x78)]
  ];
  for (const chunks of fixtures) {
    providerHandler = async (req, res, payload) => {
      assert.equal(payload.messages[0].content.includes(resident), false);
      await writeChunks(res, chunks);
    };
    const response = await streamRequest({
      messages: [{ role: 'user', content: resident }]
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'filter_processing_failed');
    assert.deepEqual(requestLogs(), [{
      status: 'failure', error_type: 'filter', input_tokens: 0, output_tokens: 0, total_tokens: 0
    }]);
    assert.equal(db.prepare('SELECT COUNT(*) FROM quota_reservations').pluck().get(), 0);
    db.prepare('DELETE FROM request_logs').run();
  }
});
