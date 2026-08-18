const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const gatewayUrl = String(process.env.GATEWAY_URL || 'http://gateway:3000').replace(/\/$/, '');
const adminKey = process.env.ADMIN_SECRET_KEY;
const outputPath = process.env.STRESS_RESULT_PATH || '';
const concurrencies = String(process.env.STRESS_CONCURRENCIES || '1,10,50,100')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value > 0);
const rounds = Number(process.env.STRESS_ROUNDS || 3);

if (!adminKey || adminKey.length < 32 || !concurrencies.length || !Number.isSafeInteger(rounds) || rounds <= 0) {
  throw new Error('Docker stress-test configuration is invalid');
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index];
}

function round(value) {
  return Number(value.toFixed(2));
}

function statusCounts(results) {
  return results.reduce((counts, result) => {
    counts[result.status] = (counts[result.status] || 0) + 1;
    return counts;
  }, {});
}

function chat(token, model = 'stress-chat', stream = false) {
  const started = performance.now();
  return fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'stress-test' }]
    })
  }).then(async (response) => ({
    status: response.status,
    duration_ms: performance.now() - started,
    body: await response.text()
  }));
}

async function waitForHealth() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${gatewayUrl}/health`);
      if (response.ok) return;
    } catch {
      // The gateway is expected to be starting during the first few attempts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Gateway did not become healthy within 60 seconds');
}

async function admin(route, body) {
  const response = await fetch(`${gatewayUrl}${route}`, {
    method: 'POST',
    headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const responseBody = await response.json();
  if (!response.ok) throw new Error(`Administrative setup failed for ${route}: HTTP ${response.status}`);
  return responseBody;
}

async function provision() {
  const provider = await admin('/admin/providers', {
    provider_name: 'stress-provider',
    display_name: 'Stress provider',
    base_url: 'http://mock-provider:8080/v1',
    auth_type: 'none',
    max_concurrent_requests: 300
  });
  await admin('/admin/models', {
    model_name: 'stress-chat',
    display_name: 'Stress chat',
    provider_id: provider.id,
    max_tokens: 8,
    max_concurrent_requests: 300
  });
  await admin('/admin/models', {
    model_name: 'stress-limited',
    display_name: 'Stress limited',
    provider_id: provider.id,
    max_tokens: 8,
    max_concurrent_requests: 1
  });
  const standard = await admin('/admin/users', {
    username: 'stress-user',
    allowed_models: ['stress-chat'],
    max_daily_input_tokens: 0,
    max_daily_output_tokens: 0,
    max_requests_per_minute: 2000,
    max_concurrent_requests: 300
  });
  const limited = await admin('/admin/users', {
    username: 'limited-user',
    allowed_models: ['stress-limited'],
    max_daily_input_tokens: 0,
    max_daily_output_tokens: 0,
    max_requests_per_minute: 100,
    max_concurrent_requests: 2
  });
  return { standardToken: standard.apiToken, limitedToken: limited.apiToken };
}

async function runScenario(token, concurrency) {
  const results = [];
  const started = performance.now();
  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    results.push(...await Promise.all(Array.from({ length: concurrency }, () => chat(token))));
  }
  const durationMs = performance.now() - started;
  const durations = results.map((result) => result.duration_ms);
  return {
    concurrency,
    rounds,
    requests: results.length,
    successful: results.filter((result) => result.status === 200).length,
    status_counts: statusCounts(results),
    elapsed_ms: round(durationMs),
    throughput_requests_per_second: round(results.length / (durationMs / 1000)),
    latency_ms: {
      p50: round(percentile(durations, 0.5)),
      p95: round(percentile(durations, 0.95)),
      max: round(Math.max(...durations))
    }
  };
}

async function main() {
  await waitForHealth();
  const tokens = await provision();
  await Promise.all(Array.from({ length: 10 }, () => chat(tokens.standardToken)));
  const scenarios = [];
  for (const concurrency of concurrencies) scenarios.push(await runScenario(tokens.standardToken, concurrency));

  const stream = await chat(tokens.standardToken, 'stress-chat', true);
  const limited = await Promise.all([
    chat(tokens.limitedToken, 'stress-limited'),
    chat(tokens.limitedToken, 'stress-limited')
  ]);
  const concurrencyStatuses = limited.map((result) => result.status).sort((left, right) => left - right);
  const result = {
    schema_version: 1,
    measured_at: new Date().toISOString(),
    environment: {
      runner: `Docker, Node ${process.version}, ${process.platform} ${process.arch}`,
      gateway: 'LLMWard production Docker image',
      provider: 'isolated local mock provider with an 8 ms response delay'
    },
    workload: {
      concurrencies,
      rounds_per_concurrency: rounds,
      request_body: 'one short synthetic chat message; max_tokens=1'
    },
    scenarios,
    streaming: { status: stream.status, received_done: stream.body.includes('[DONE]') },
    concurrency_limit_statuses: concurrencyStatuses
  };
  const hasFailure = scenarios.some((scenario) => scenario.successful !== scenario.requests) ||
    stream.status !== 200 || !result.streaming.received_done ||
    JSON.stringify(concurrencyStatuses) !== JSON.stringify([200, 429]);

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`@@LLMWARD_STRESS_RESULT@@${JSON.stringify(result)}\n`);
  if (hasFailure) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Docker stress test failed: ${error.message}\n`);
  process.exitCode = 1;
});
