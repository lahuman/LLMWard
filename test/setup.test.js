const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const setupScript = path.join(projectRoot, 'scripts', 'setup.js');

function runSetup(root, cwd) {
  return new Promise((resolve) => {
    const environment = {
      LLM_GATEWAY_SETUP_ROOT: root,
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP
    };
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete environment[name];
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    let timeout;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, ...result });
    };
    const child = spawn(process.execPath, [setupScript], {
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
  assert.ok(key);
  assert.ok(key.length >= 32);
  assert.match(key, /^[A-Za-z0-9_-]+$/);
  assert.equal(contents, fs.readFileSync(examplePath, 'utf8').replace(/^ADMIN_SECRET_KEY=.*$/m, `ADMIN_SECRET_KEY=${key}`));
  assert.equal((results.map(({ stdout }) => stdout).join('').match(new RegExp(key, 'g')) || []).length, 1);
  assert.equal(results.filter(({ stdout }) => stdout.includes('Save this administrator key now')).length, 1);
  assert.equal(results.filter(({ stdout }) => stdout.includes('Existing .env was preserved')).length, 7);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')), []);

  const later = await runSetup(root, cwd);
  assert.equal(later.status, 0, `${later.event}:${later.status}`);
  assert.equal(fs.readFileSync(envPath, 'utf8'), contents);
  assert.equal(later.stdout.includes(key), false);
  assert.match(later.stdout, /Existing \.env was preserved/);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')), []);
});
