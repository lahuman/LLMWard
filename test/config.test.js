const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-config-test-'));
const configPath = path.join(__dirname, '..', 'config');
const source = [
  `const config = require(${JSON.stringify(configPath)});`,
  'process.stdout.write(JSON.stringify({',
  '  providerTimeoutMs: config.providerTimeoutMs,',
  '  streamIdleTimeoutMs: config.streamIdleTimeoutMs,',
  '  streamMaxDurationMs: config.streamMaxDurationMs',
  '}));'
].join('\n');

after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

function runConfig(overrides = {}) {
  const environment = {
    ADMIN_SECRET_KEY: crypto.randomBytes(32).toString('base64url'),
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    ...overrides
  };
  if (process.platform === 'win32') {
    environment.SystemRoot = process.env.SystemRoot;
    environment.WINDIR = process.env.WINDIR;
  }
  return spawnSync(process.execPath, ['-e', source], {
    cwd: temporaryDirectory,
    env: environment,
    encoding: 'utf8'
  });
}

function readConfig(overrides) {
  const result = runConfig(overrides);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('uses bounded LLMWard timeout defaults', () => {
  assert.deepEqual(readConfig(), {
    providerTimeoutMs: 60000,
    streamIdleTimeoutMs: 120000,
    streamMaxDurationMs: 1800000
  });
});

test('uses explicit bounded LLMWard timeout settings', () => {
  assert.deepEqual(readConfig({
    LLMWARD_PROVIDER_TIMEOUT_MS: '111',
    LLMWARD_STREAM_IDLE_TIMEOUT_MS: '222',
    LLMWARD_STREAM_MAX_DURATION_MS: '333'
  }), {
    providerTimeoutMs: 111,
    streamIdleTimeoutMs: 222,
    streamMaxDurationMs: 333
  });
});

test('rejects non-positive or unsafe LLMWard timeout settings', () => {
  const names = [
    'LLMWARD_PROVIDER_TIMEOUT_MS',
    'LLMWARD_STREAM_IDLE_TIMEOUT_MS',
    'LLMWARD_STREAM_MAX_DURATION_MS'
  ];
  const values = ['0', '-1', '1.5', '9007199254740992'];

  for (const name of names) {
    for (const value of values) {
      const result = runConfig({ [name]: value });
      assert.notEqual(result.status, 0, `${name}=${value} unexpectedly started`);
      assert.match(result.stderr, new RegExp(`${name} must be a positive integer`));
    }
  }
});

test('rejects LLMWard timeout settings above the Node timer limit', () => {
  const names = [
    'LLMWARD_PROVIDER_TIMEOUT_MS',
    'LLMWARD_STREAM_IDLE_TIMEOUT_MS',
    'LLMWARD_STREAM_MAX_DURATION_MS'
  ];

  for (const name of names) {
    const result = runConfig({ [name]: '2147483648' });
    assert.notEqual(result.status, 0, `${name} unexpectedly started`);
    assert.match(result.stderr, new RegExp(`${name} must not exceed 2147483647`));
  }
});
