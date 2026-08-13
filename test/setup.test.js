const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const setupScript = path.join(projectRoot, 'scripts', 'setup.js');

function countOccurrences(value, needle) {
  let count = 0;
  let index = value.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(needle, index + needle.length);
  }
  return count;
}

function runSetup(root, cwd, environmentOverrides = {}) {
  return new Promise((resolve) => {
    const environment = {
      LLMWARD_SETUP_ROOT: root,
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP
    };
    Object.assign(environment, environmentOverrides);
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete environment[name];
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    let timeout;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ pid: child?.pid, stdout, stderr, ...result });
    };
    child = spawn(process.execPath, [setupScript], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    timeout = setTimeout(() => {
      child.kill();
      finish({ event: 'timeout', status: null });
    }, 10_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ event: error.code || 'error', status: null }));
    child.on('close', (status) => finish({ event: 'close', status }));
  });
}

test('concurrent setup creates and discloses one administrator key once', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-setup-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-setup-cwd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const examplePath = path.join(root, '.env.example');
  fs.copyFileSync(path.join(projectRoot, '.env.example'), examplePath);

  const results = await Promise.all(Array.from({ length: 8 }, () => runSetup(root, cwd)));
  assert.deepEqual(
    results.map(({ status }) => status),
    Array(8).fill(0),
    results.map(({ event, status }) => `${event}:${status}`).join(', ')
  );

  const envPath = path.join(root, '.env');
  assert.ok(fs.existsSync(envPath));
  const contents = fs.readFileSync(envPath, 'utf8');
  const key = contents.match(/^ADMIN_SECRET_KEY=(.+)$/m)?.[1];
  assert.equal(typeof key === 'string', true);
  assert.equal(key.length >= 32, true);
  assert.equal(/^[A-Za-z0-9_-]+$/.test(key), true);
  assert.equal(contents === fs.readFileSync(examplePath, 'utf8').replace(/^ADMIN_SECRET_KEY=.*$/m, `ADMIN_SECRET_KEY=${key}`), true);
  const concurrentOutput = results.map(({ stdout, stderr }) => stdout + stderr).join('');
  assert.equal(countOccurrences(concurrentOutput, key), 1);
  assert.equal(results.filter(({ stdout, stderr }) => (stdout + stderr).includes('Save this administrator key now')).length, 1);
  assert.equal(results.filter(({ stdout, stderr }) => (stdout + stderr).includes('Existing .env was preserved')).length, 7);
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')).length, 0);

  const later = await runSetup(root, cwd);
  assert.equal(later.status, 0, `${later.event}:${later.status}`);
  assert.equal(fs.readFileSync(envPath, 'utf8') === contents, true);
  const laterOutput = later.stdout + later.stderr;
  assert.equal(countOccurrences(laterOutput, key), 0);
  assert.equal(laterOutput.includes('Existing .env was preserved'), true);
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('setup preserves a pre-existing temporary collision', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-setup-collision-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llmward-setup-collision-cwd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.copyFileSync(path.join(projectRoot, '.env.example'), path.join(root, '.env.example'));

  const fixturePath = path.join(cwd, 'preload.js');
  const suffix = '010203040506';
  fs.writeFileSync(fixturePath, [
    "const crypto = require('crypto');",
    "const fs = require('fs');",
    "const path = require('path');",
    "const randomBytes = crypto.randomBytes;",
    `const temporaryPath = path.join(process.env.LLMWARD_SETUP_ROOT, '.env.' + process.pid + '.${suffix}.tmp');`,
    "fs.writeFileSync(temporaryPath, 'sentinel', { flag: 'wx', mode: 0o600 });",
    `crypto.randomBytes = (size) => size === 6 ? Buffer.from('${suffix}', 'hex') : randomBytes(size);`
  ].join('\n'));

  const result = await runSetup(root, cwd, { NODE_OPTIONS: `--require=${fixturePath}` });
  const sentinelPath = path.join(root, `.env.${result.pid}.${suffix}.tmp`);
  assert.equal(result.status === 0, false);
  assert.equal(fs.existsSync(sentinelPath), true);
  assert.equal(fs.readFileSync(sentinelPath, 'utf8') === 'sentinel', true);
});
