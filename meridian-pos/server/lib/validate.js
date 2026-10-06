'use strict';
const { E } = require('./errors');

/** Small, explicit input validation. Every route validates its body with these. */
function fail(field, msg) { return E.validation(`${field}: ${msg}`, { field }); }

const v = {
  str(obj, field, { required = false, max = 500, min = 0, pattern, trim = true, label } = {}) {
    let x = obj ? obj[field] : undefined;
    if (x === undefined || x === null || x === '') {
      if (required) throw fail(label || field, 'is required');
      return null;
    }
    if (typeof x !== 'string' && typeof x !== 'number') throw fail(label || field, 'must be text');
    x = String(x);
    if (trim) x = x.trim();
    if (required && !x) throw fail(label || field, 'is required');
    if (x.length > max) throw fail(label || field, `must be at most ${max} characters`);
    if (x.length < min) throw fail(label || field, `must be at least ${min} characters`);
    if (pattern && x && !pattern.test(x)) throw fail(label || field, 'has an invalid format');
    return x || null;
  },
  int(obj, field, { required = false, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, label } = {}) {
    const x = obj ? obj[field] : undefined;
    if (x === undefined || x === null || x === '') { if (required) throw fail(label || field, 'is required'); return null; }
    const n = typeof x === 'string' ? Number(x) : x;
    if (!Number.isInteger(n)) throw fail(label || field, 'must be a whole number');
    if (n < min || n > max) throw fail(label || field, `must be between ${min} and ${max}`);
    return n;
  },
  /** money in minor units */
  money(obj, field, opts = {}) { return v.int(obj, field, { min: 0, max: 1e13, ...opts }); },
  num(obj, field, { required = false, min = -1e12, max = 1e12, label } = {}) {
    const x = obj ? obj[field] : undefined;
    if (x === undefined || x === null || x === '') { if (required) throw fail(label || field, 'is required'); return null; }
    const n = Number(x);
    if (!Number.isFinite(n)) throw fail(label || field, 'must be a number');
    if (n < min || n > max) throw fail(label || field, `must be between ${min} and ${max}`);
    return n;
  },
  bool(obj, field, def = null) {
    const x = obj ? obj[field] : undefined;
    if (x === undefined || x === null) return def;
    if (x === true || x === 1 || x === '1' || x === 'true') return true;
    if (x === false || x === 0 || x === '0' || x === 'false') return false;
    throw fail(field, 'must be true or false');
  },
  oneOf(obj, field, values, { required = false, def = null } = {}) {
    const x = obj ? obj[field] : undefined;
    if (x === undefined || x === null || x === '') { if (required) throw fail(field, 'is required'); return def; }
    if (!values.includes(x)) throw fail(field, `must be one of ${values.join(', ')}`);
    return x;
  },
  email(obj, field, opts = {}) { return v.str(obj, field, { max: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, ...opts }); },
  phone(obj, field, opts = {}) { return v.str(obj, field, { max: 30, pattern: /^\+?[0-9 ()-]{6,30}$/, ...opts }); },
  id(obj, field, opts = {}) { return v.str(obj, field, { max: 64, pattern: /^[a-z]{2,6}_[0-9a-z]{16,40}$/, ...opts }); },
  arr(obj, field, { required = false, max = 500 } = {}) {
    const x = obj ? obj[field] : undefined;
    if (x === undefined || x === null) { if (required) throw fail(field, 'is required'); return []; }
    if (!Array.isArray(x)) throw fail(field, 'must be a list');
    if (x.length > max) throw fail(field, `must have at most ${max} entries`);
    return x;
  },
};

module.exports = { v };
