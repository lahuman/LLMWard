const crypto = require('crypto');
const config = require('../config');
const db = require('../db/database');
const { hashToken } = require('../db/migrations');

function validateToken(req, res, next) {
  const header = req.get('authorization');
  if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length <= 7) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const tokenHash = hashToken(header.slice(7));
  const user = db.prepare(`
    SELECT u.id, u.username, u.max_daily_input_tokens, u.max_daily_output_tokens,
           u.max_requests_per_minute, u.max_concurrent_requests,
           u.is_active, u.allowed_models, t.id AS token_id
    FROM user_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.is_active = 1 AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > ?)
      AND u.is_active = 1
  `).get(tokenHash, new Date().toISOString());

  if (!user) {
    return res.status(401).json({ error: 'Invalid or inactive API token' });
  }
  db.prepare('UPDATE user_tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), user.token_id);
  req.user = user;
  next();
}

function validateAdmin(req, res, next) {
  const provided = req.get('x-admin-key');
  if (!provided) {
    return res.status(401).json({ error: 'Admin credentials are required' });
  }

  const expectedBuffer = Buffer.from(config.adminKey);
  const providedBuffer = Buffer.from(provided);
  const valid = expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  if (!valid) {
    return res.status(403).json({ error: 'Invalid admin credentials' });
  }
  next();
}

module.exports = { validateToken, validateAdmin };
