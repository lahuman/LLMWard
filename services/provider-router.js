const db = require('../db/database');
const config = require('../config');
const { ApiError } = require('./errors');
const ENCODED_SEPARATOR = /%2f|%5c/i;
const DOT_SEGMENT = /(?:^|\/)(?:(?:\.|%2e){1,2})(?:\/|$)/i;

function normalizeProviderBaseUrl(value) {
  const raw = String(value).trim();
  if (ENCODED_SEPARATOR.test(raw) || DOT_SEGMENT.test(raw)) {
    throw new ApiError(400, 'base_url contains an unsafe path', 'invalid_request');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiError(400, 'base_url must be a valid URL', 'invalid_request');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash) {
    throw new ApiError(400, 'base_url must be an HTTP(S) URL without credentials, query, or fragment', 'invalid_request');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.href.replace(/\/$/, '');
}

function buildProviderEndpoint(baseUrl, relativePath) {
  const endpoint = new URL(normalizeProviderBaseUrl(baseUrl));
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${String(relativePath).replace(/^\/+/, '')}`;
  return endpoint.href;
}

const PROVIDER_PRESETS = Object.freeze([
  { id: 'generic', name: 'Generic OpenAI-compatible', base_url: 'http://localhost:8000/v1', description: 'Any OpenAI-compatible HTTP server' },
  { id: 'ollama', name: 'Ollama', base_url: 'http://localhost:11434/v1', description: 'Ollama OpenAI-compatible API' },
  { id: 'vllm', name: 'vLLM', base_url: 'http://localhost:8000/v1', description: 'vLLM OpenAI-compatible server' },
  { id: 'lm-studio', name: 'LM Studio', base_url: 'http://localhost:1234/v1', description: 'LM Studio local server' },
  { id: 'llama-cpp', name: 'llama.cpp server', base_url: 'http://localhost:8080/v1', description: 'llama.cpp OpenAI-compatible server' },
  { id: 'localai', name: 'LocalAI', base_url: 'http://localhost:8080/v1', description: 'LocalAI OpenAI-compatible API' },
  { id: 'nvidia-nim', name: 'NVIDIA NIM', base_url: 'http://localhost:8000/v1', description: 'NVIDIA NIM OpenAI-compatible endpoint' }
]);

function getProviderById(providerId) {
  return db.prepare(`
    SELECT id, provider_name, display_name, base_url, auth_type,
           api_key_env_name, stored_api_key, is_active, health_status,
           last_health_check, last_health_latency_ms
    FROM providers WHERE id = ?
  `).get(providerId);
}

function getProviderForModel(modelName) {
  return db.prepare(`
    SELECT p.id, p.provider_name, p.display_name, p.base_url, p.auth_type,
           p.api_key_env_name, p.stored_api_key
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.model_name = ? AND m.is_active = 1 AND p.is_active = 1
  `).get(modelName);
}

function getAuthHeaders(provider) {
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = (provider.api_key_env_name && process.env[provider.api_key_env_name]) ||
    provider.stored_api_key;
  if (apiKey && (provider.auth_type === 'api_key' || provider.auth_type === 'bearer_token')) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function testProvider(providerId) {
  const provider = getProviderById(providerId);
  if (!provider) return { status: 'unhealthy', error: 'Provider not found' };
  if (!provider.is_active) return { status: 'unhealthy', error: 'Provider is inactive' };
  if (!provider.base_url) return { status: 'unhealthy', error: 'Provider URL is not configured' };

  const startedAt = Date.now();
  let status = 'unhealthy';
  let result;
  try {
    const response = await fetch(buildProviderEndpoint(provider.base_url, 'models'), {
      headers: getAuthHeaders(provider),
      signal: AbortSignal.timeout(Math.min(config.providerTimeout, 10000)),
      redirect: 'manual'
    });
    status = response.ok ? 'healthy' : 'unhealthy';
    result = response.ok
      ? { status, latency_ms: Date.now() - startedAt, message: 'Connection successful' }
      : { status, latency_ms: Date.now() - startedAt, error: response.status >= 300 && response.status < 400 ? 'Provider redirect was rejected' : `Provider returned status ${response.status}` };
  } catch {
    result = { status, latency_ms: Date.now() - startedAt, error: 'Connection failed' };
  }

  const latencyMs = Date.now() - startedAt;
  result.latency_ms = latencyMs;
  db.prepare(`
    UPDATE providers
    SET health_status = ?, last_health_check = ?, last_health_latency_ms = ?
    WHERE id = ?
  `).run(status, new Date().toISOString(), latencyMs, providerId);
  return result;
}

async function discoverModels(providerId) {
  const provider = getProviderById(providerId);
  if (!provider || !provider.is_active) throw new Error('Provider is unavailable');
  const response = await fetch(buildProviderEndpoint(provider.base_url, 'models'), {
    headers: getAuthHeaders(provider),
    signal: AbortSignal.timeout(Math.min(config.providerTimeout, 10000)),
    redirect: 'manual'
  });
  if (response.status >= 300 && response.status < 400) throw new Error('Provider redirect was rejected');
  if (!response.ok) throw new Error(`Provider returned status ${response.status}`);
  const body = await response.json();
  const items = Array.isArray(body) ? body : body && Array.isArray(body.data) ? body.data : null;
  if (!items) throw new Error('Provider returned an unsupported model list');
  const existing = new Set(db.prepare('SELECT model_name FROM models').all().map((row) => row.model_name));
  const seen = new Set();
  return items.flatMap((item) => {
    const modelId = typeof item === 'string' ? item : item && (item.id || item.name);
    if (typeof modelId !== 'string' || !modelId.trim() || seen.has(modelId) || existing.has(modelId)) return [];
    seen.add(modelId);
    return [{ model_name: modelId, display_name: modelId, already_registered: false }];
  });
}

function getActiveModelsWithProviders() {
  return db.prepare(`
    SELECT m.id, m.model_name, m.display_name, m.model_type, m.max_tokens,
           p.id AS provider_id, p.provider_name, p.display_name AS provider_display_name
    FROM models m
    JOIN providers p ON p.id = m.provider_id AND p.is_active = 1
    WHERE m.is_active = 1
    ORDER BY m.id
  `).all();
}

module.exports = {
  PROVIDER_PRESETS, discoverModels, getProviderById, getProviderForModel,
  getAuthHeaders, testProvider, getActiveModelsWithProviders,
  normalizeProviderBaseUrl, buildProviderEndpoint
};
