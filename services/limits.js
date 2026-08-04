const { ApiError } = require('./errors');

const minuteWindows = new Map();
const active = {
  user: new Map(),
  model: new Map(),
  provider: new Map()
};

function count(map, key) {
  return map.get(key) || 0;
}

function acquire(user, model) {
  const now = Date.now();
  const cutoff = now - 60000;
  const timestamps = (minuteWindows.get(user.id) || []).filter((timestamp) => timestamp > cutoff);
  if (timestamps.length >= user.max_requests_per_minute) {
    const retryAfter = Math.max(1, Math.ceil((timestamps[0] + 60000 - now) / 1000));
    throw new ApiError(429, 'Requests per minute limit exceeded', 'rate_limit_exceeded', retryAfter);
  }

  const checks = [
    ['user', user.id, user.max_concurrent_requests, 'user_concurrency_exceeded'],
    ['model', model.model_name, model.max_concurrent_requests, 'model_concurrency_exceeded'],
    ['provider', model.provider_id, model.provider_max_concurrent_requests, 'provider_concurrency_exceeded']
  ];
  for (const [type, key, maximum, code] of checks) {
    if (count(active[type], key) >= maximum) {
      throw new ApiError(429, `${type} concurrency limit exceeded`, code, 1);
    }
  }

  timestamps.push(now);
  minuteWindows.set(user.id, timestamps);
  for (const [type, key] of checks) active[type].set(key, count(active[type], key) + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const [type, key] of checks) {
      const remaining = count(active[type], key) - 1;
      if (remaining > 0) active[type].set(key, remaining);
      else active[type].delete(key);
    }
  };
}

function state() {
  return {
    users: Object.fromEntries(active.user),
    models: Object.fromEntries(active.model),
    providers: Object.fromEntries(active.provider)
  };
}

module.exports = { acquire, state };
