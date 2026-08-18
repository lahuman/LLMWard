const http = require('node:http');

const port = Number(process.env.MOCK_PROVIDER_PORT || 8080);
const delayMs = Number(process.env.MOCK_PROVIDER_DELAY_MS || 8);

if (!Number.isSafeInteger(port) || port <= 0 || !Number.isSafeInteger(delayMs) || delayMs < 0) {
  throw new Error('Mock provider configuration is invalid');
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'stress-chat' }, { id: 'stress-limited' }] }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  await wait(body.model === 'stress-limited' ? Math.max(delayMs, 80) : delayMs);
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (body.stream === true) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'stress-response',
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
    usage
  }));
});

server.listen(port, '0.0.0.0');
