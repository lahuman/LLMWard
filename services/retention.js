const db = require('../db/database');
const config = require('../config');
const { audit } = require('./audit');

function retentionDays() {
  const row = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'request_log_retention_days'").get();
  if (!row) return config.requestLogRetentionDays;
  const value = Number(row.setting_value);
  return Number.isSafeInteger(value) && value >= 0 ? value : config.requestLogRetentionDays;
}

function cleanupRequestLogs() {
  const days = retentionDays();
  if (days === 0) return { days, deleted: 0, disabled: true };
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const result = db.transaction(() => db.prepare('DELETE FROM request_logs WHERE created_at < ?').run(cutoff)).immediate();
  audit('retention.cleanup', 'request_logs', null, true, ['created_at']);
  return { days, deleted: result.changes, disabled: false };
}

function setRetentionDays(days) {
  db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES ('request_log_retention_days', ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
  `).run(String(days), new Date().toISOString());
  audit('retention.update', 'setting', 'request_log_retention_days', true, ['setting_value']);
  return days;
}

module.exports = { retentionDays, cleanupRequestLogs, setRetentionDays };
