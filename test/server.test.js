const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const repositoryRoot = path.join(__dirname, '..');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort() {
  const server = http.createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}

async function request(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let body = null;
  try { body = await response.json(); } catch {}
  return { status: response.status, body };
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited during startup with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('server health check timed out');
}

test('SIGTERM aborts held requests and exits cleanly before the force limit', async (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-gateway-server-test-'));
  const databasePath = path.join(temporaryDirectory, 'server.test.db');
  const adminKey = crypto.randomBytes(32).toString('base64url');
  const providerKey = crypto.randomBytes(24).toString('base64url');
  const promptMarker = `shutdown-${crypto.randomBytes(12).toString('hex')}`;
  const providerEvents = new EventEmitter();
  let upstreamCloses = 0;
  let child;

  const providerServer = http.createServer(async (req, res) => {
    if (req.url !== '/chat/completions' || req.method !== 'POST') {
      res.writeHead(404);
      return res.end();
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    if (payload.model !== 'shutdown-held') {
      res.writeHead(404);
      return res.end();
    }
    res.once('close', () => {
      if (!res.writableEnded) upstreamCloses += 1;
      providerEvents.emit('closed');
    });
    providerEvents.emit('started');
  });

  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    if (providerServer.listening) {
      if (typeof providerServer.closeAllConnections === 'function') providerServer.closeAllConnections();
      await close(providerServer);
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  await listen(providerServer);
  const providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverPath = path.join(repositoryRoot, 'server.js');
  const childEnvironment = {
    ADMIN_SECRET_KEY: adminKey,
    DATABASE_PATH: databasePath,
    HOST: '127.0.0.1',
    PORT: String(port),
    KERNEXA_TIMEOUT: '30000',
    CORS_ORIGIN: 'http://127.0.0.1',
    LOG_LEVEL: 'silent'
  };
  if (process.platform === 'win32') {
    childEnvironment.SystemRoot = process.env.SystemRoot;
    childEnvironment.WINDIR = process.env.WINDIR;
  }

  const windowsWrapper = [
    `const { startServer } = require(${JSON.stringify(serverPath)});`,
    'startServer();',
    "process.on('message', (message) => {",
    "  if (message !== 'SIGTERM') return;",
    '  process.disconnect();',
    "  process.emit('SIGTERM');",
    '});'
  ].join('\n');
  child = process.platform === 'win32'
    ? spawn(process.execPath, ['-e', windowsWrapper], {
      cwd: temporaryDirectory, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    : spawn(process.execPath, [serverPath], {
      cwd: temporaryDirectory, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe']
    });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(9000) });

  await waitForHealth(baseUrl, child);
  const adminHeaders = { 'X-Admin-Key': adminKey };
  const provider = await request(`${baseUrl}/admin/providers`, {
    method: 'POST', headers: adminHeaders,
    body: {
      provider_name: 'shutdown-provider', display_name: 'Shutdown Provider',
      base_url: providerBaseUrl, auth_type: 'api_key', stored_api_key: providerKey
    }
  });
  assert.equal(provider.status, 201);
  const model = await request(`${baseUrl}/admin/models`, {
    method: 'POST', headers: adminHeaders,
    body: {
      model_name: 'shutdown-held', display_name: 'Shutdown Held',
      provider_id: provider.body.id, max_tokens: 4
    }
  });
  assert.equal(model.status, 201);
  const user = await request(`${baseUrl}/admin/users`, {
    method: 'POST', headers: adminHeaders,
    body: {
      username: 'shutdown-user', max_daily_input_tokens: 100,
      max_daily_output_tokens: 100, allowed_models: ['shutdown-held']
    }
  });
  assert.equal(user.status, 201);
  const started = once(providerEvents, 'started', { signal: AbortSignal.timeout(3000) });
  const closed = once(providerEvents, 'closed', { signal: AbortSignal.timeout(3000) });
  const heldRequest = request(`${baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${user.body.apiToken}` },
    body: {
      model: 'shutdown-held', messages: [{ role: 'user', content: promptMarker }], max_tokens: 1
    }
  }).catch(() => null);
  await started;

  if (process.platform === 'win32') child.send('SIGTERM');
  else child.kill('SIGTERM');
  await closed;
  const [exitCode, exitSignal] = await exited;
  await heldRequest;

  assert.equal(exitSignal, null);
  assert.equal(exitCode, 0);
  assert.equal(upstreamCloses, 1);
  const migrated = new Database(databasePath, { readonly: true });
  assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM quota_reservations').get().count, 0);
  migrated.close();
  const output = stdout + stderr;
  assert.equal(output.includes(adminKey), false);
  assert.equal(output.includes(providerKey), false);
  assert.equal(output.includes(user.body.apiToken), false);
  assert.equal(output.includes(promptMarker), false);
});
