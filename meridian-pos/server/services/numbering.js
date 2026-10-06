'use strict';
/** Human-readable, gap-free document numbers (per business, per series). Must be called inside a transaction. */
module.exports = function numbering(app) {
  const { db } = app;
  function next(businessId, series, prefix, pad = 6) {
    db.run(`INSERT INTO counters (business_id, name, value) VALUES (?, ?, 1)
            ON CONFLICT(business_id, name) DO UPDATE SET value = value + 1`, businessId, series);
    const n = db.value('SELECT value FROM counters WHERE business_id = ? AND name = ?', businessId, series);
    return `${prefix}${String(n).padStart(pad, '0')}`;
  }
  return { next };
};
