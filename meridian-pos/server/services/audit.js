'use strict';
const { newId, nowIso } = require('../lib/ids');
const { sha256 } = require('../lib/crypto');

/**
 * Append-only, hash-chained audit log. Each row's hash covers its content and the previous
 * row's hash, so any tampering with history (even by someone with raw DB access who bypasses
 * the no-update triggers) is detectable with verify().
 */
module.exports = function auditService(app) {
  const { db } = app;

  function canonical(row) {
    return JSON.stringify([row.id, row.business_id, row.occurred_at, row.user_id, row.username, row.approved_by, row.action,
      row.entity_type, row.entity_id, row.reference, row.old_value, row.new_value, row.meta, row.terminal, row.prev_hash]);
  }

  function log(ctx, action, { entityType = null, entityId = null, reference = null, oldValue, newValue, meta, approvedBy = null, businessId } = {}) {
    const prev = db.get('SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1');
    const row = {
      id: newId('aud'),
      business_id: businessId || (ctx && ctx.businessId) || null,
      occurred_at: nowIso(),
      user_id: ctx && ctx.user ? ctx.user.id : null,
      username: ctx && ctx.user ? ctx.user.username : (ctx && ctx.actor) || 'system',
      approved_by: approvedBy,
      action,
      entity_type: entityType,
      entity_id: entityId,
      reference,
      old_value: oldValue === undefined ? null : JSON.stringify(oldValue),
      new_value: newValue === undefined ? null : JSON.stringify(newValue),
      meta: meta === undefined ? null : JSON.stringify(meta),
      terminal: ctx && ctx.registerId ? ctx.registerId : null,
      prev_hash: prev ? prev.hash : 'GENESIS',
    };
    row.hash = sha256(canonical(row));
    db.run(`INSERT INTO audit_logs (id,business_id,occurred_at,user_id,username,approved_by,action,entity_type,entity_id,reference,old_value,new_value,meta,terminal,prev_hash,hash)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.id, row.business_id, row.occurred_at, row.user_id, row.username, row.approved_by, row.action, row.entity_type, row.entity_id,
    row.reference, row.old_value, row.new_value, row.meta, row.terminal, row.prev_hash, row.hash);
    return row.id;
  }

  function verify() {
    let prev = 'GENESIS';
    let count = 0;
    for (const row of db.all('SELECT * FROM audit_logs ORDER BY seq')) {
      count++;
      if (row.prev_hash !== prev) return { ok: false, count, brokenAt: row.seq, reason: 'chain link mismatch' };
      if (sha256(canonical(row)) !== row.hash) return { ok: false, count, brokenAt: row.seq, reason: 'content hash mismatch' };
      prev = row.hash;
    }
    return { ok: true, count };
  }

  function list(ctx, { action, entityType, entityId, userId, from, to, q, limit = 200, offset = 0 }) {
    const where = ['(business_id = ? OR business_id IS NULL)'];
    const p = [ctx.businessId];
    if (action) { where.push('action LIKE ?'); p.push(`${action}%`); }
    if (entityType) { where.push('entity_type = ?'); p.push(entityType); }
    if (entityId) { where.push('entity_id = ?'); p.push(entityId); }
    if (userId) { where.push('user_id = ?'); p.push(userId); }
    if (from) { where.push('occurred_at >= ?'); p.push(from); }
    if (to) { where.push('occurred_at < ?'); p.push(to); }
    if (q) { where.push('(reference LIKE ? OR username LIKE ? OR action LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const rows = db.all(`SELECT seq,id,occurred_at,user_id,username,approved_by,action,entity_type,entity_id,reference,old_value,new_value,meta,terminal
      FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ? OFFSET ?`, ...p, Math.min(limit, 1000), offset);
    const approverIds = [...new Set(rows.map((r) => r.approved_by).filter(Boolean))];
    const names = {};
    approverIds.forEach((id) => { const u = db.get('SELECT username FROM users WHERE id=?', id); if (u) names[id] = u.username; });
    return rows.map((r) => ({ ...r, approved_by_name: r.approved_by ? names[r.approved_by] || r.approved_by : null }));
  }

  return { log, verify, list };
};
