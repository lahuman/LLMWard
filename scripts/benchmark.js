const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-gateway-benchmark-'));
  process.env.ADMIN_SECRET_KEY = crypto.randomBytes(32).toString('base64url');
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'benchmark.db');
  process.env.KERNEXA_TIMEOUT = '5000';
  process.env.LOG_LEVEL = 'silent';

  const provider = http.createServer(async (req, res) => {
    if (req.url === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'benchmark' }] }));
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    if (payload.model === 'limited') await new Promise((resolve) => setTimeout(resolve, 40));
    const result = { id: 'bench', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: result.usage })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  await listen(provider);
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;

  const startupStarted = performance.now();
  const app = require('../app');
  const db = require('../db/database');
  const gateway = http.createServer(app);
  await listen(gateway);
  const startupMs = performance.now() - startupStarted;
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
  db.pragma('wal_checkpoint(TRUNCATE)');
  const idleRssMiB = process.memoryUsage().rss / 1048576;
  const defaultDatabaseBytes = fs.statSync(process.env.DATABASE_PATH).size;

  async function admin(route, options = {}) {
    const response = await fetch(`${gatewayUrl}${route}`, {
      ...options,
      headers: { 'X-Admin-Key': process.env.ADMIN_SECRET_KEY, 'Content-Type': 'application/json' },
      body: options.body && JSON.stringify(options.body)
    });
    return { status: response.status, body: await response.json() };
  }

  const providerRecord = await admin('/admin/providers', { method: 'POST', body: { provider_name: 'benchmark', display_name: 'Benchmark', base_url: providerUrl, auth_type: 'none', max_concurrent_requests: 200 } });
  for (const model of ['benchmark', 'limited']) {
    await admin('/admin/models', { method: 'POST', body: { model_name: model, display_name: model, provider_id: providerRecord.body.id, max_concurrent_requests: model === 'limited' ? 1 : 200 } });
  }

  async function createUser(index, model = 'benchmark') {
    const response = await admin('/admin/users', { method: 'POST', body: { username: `bench-${model}-${index}`, allowed_models: [model], max_daily_input_tokens: 100000, max_daily_output_tokens: 100000, max_requests_per_minute: 1000, max_concurrent_requests: 10 } });
    return response.body.apiToken;
  }

  async function chat(token, model = 'benchmark', stream = false) {
    const started = performance.now();
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'benchmark' }], max_tokens: 1 })
    });
    const text = await response.text();
    return { status: response.status, duration: performance.now() - started, text };
  }

  const directDurations = [];
  const gatewayDurations = [];
  const latencyToken = await createUser('latency');
  for (let index = 0; index < 20; index += 1) {
    let started = performance.now();
    await fetch(`${providerUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'benchmark' }) });
    directDurations.push(performance.now() - started);
    gatewayDurations.push((await chat(latencyToken)).duration);
  }

  const simulations = {};
  for (const users of [1, 10, 100]) {
    const tokens = await Promise.all(Array.from({ length: users }, (_, index) => createUser(`${users}-${index}`)));
    const started = performance.now();
    const results = await Promise.all(tokens.map((token) => chat(token)));
    simulations[users] = { duration_ms: performance.now() - started, successful: results.filter((result) => result.status === 200).length };
  }

  const stream = await chat(latencyToken, 'benchmark', true);
  const limitedA = await createUser('limited-a', 'limited');
  const limitedB = await createUser('limited-b', 'limited');
  const limited = await Promise.all([chat(limitedA, 'limited'), chat(limitedB, 'limited')]);
  db.pragma('wal_checkpoint(TRUNCATE)');

  const result = {
    measured_at: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}, Node ${process.version}`,
    startup_ms: Number(startupMs.toFixed(2)),
    idle_rss_mib: Number(idleRssMiB.toFixed(2)),
    default_database_bytes: defaultDatabaseBytes,
    direct_provider_average_ms: Number(average(directDurations).toFixed(2)),
    gateway_average_ms: Number(average(gatewayDurations).toFixed(2)),
    gateway_added_average_ms: Number((average(gatewayDurations) - average(directDurations)).toFixed(2)),
    simulations,
    streaming: { status: stream.status, received_done: stream.text.includes('[DONE]') },
    concurrency_limit_statuses: limited.map((item) => item.status).sort()
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  await close(gateway);
  await close(provider);
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

main().catch((error) => {
  process.stderr.write(`Benchmark failed: ${error.message}\n`);
  process.exitCode = 1;
});
