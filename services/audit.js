const db = require('../db/database');

function audit(action, targetType, targetId, success, changedFields = []) {
  const fields = [...new Set(changedFields.filter((field) => typeof field === 'string'))].sort();
  db.prepare(`
    INSERT INTO audit_logs (action, target_type, target_id, success, changed_fields, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(action, targetType, targetId == null ? null : String(targetId), success ? 1 : 0, JSON.stringify(fields), new Date().toISOString());
}

module.exports = { audit };
