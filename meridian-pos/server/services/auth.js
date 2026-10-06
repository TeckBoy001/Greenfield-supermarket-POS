'use strict';
const { newId, nowIso } = require('../lib/ids');
const { verifySecret, randomToken, sha256 } = require('../lib/crypto');
const { E } = require('../lib/errors');

module.exports = function authService(app) {
  const { db } = app;
  const permCache = new Map(); // role_id -> Set

  function rolePerms(roleId) {
    if (!permCache.has(roleId)) {
      permCache.set(roleId, new Set(db.all('SELECT permission_code FROM role_permissions WHERE role_id = ?', roleId).map((r) => r.permission_code)));
    }
    return permCache.get(roleId);
  }
  const invalidateRoles = () => permCache.clear();

  function publicUser(u) {
    const role = db.get('SELECT id, code, name, max_discount_pct FROM roles WHERE id = ?', u.role_id);
    return {
      id: u.id, username: u.username, full_name: u.full_name, email: u.email, role, home_location_id: u.home_location_id,
      must_change_password: !!u.must_change_password, has_pin: !!u.pin_hash,
    };
  }

  /** Verifies credentials with lockout. Returns the user row or throws. Shared by login and supervisor overrides. */
  function checkCredentials(username, { password, pin }, auditCtx, purpose) {
    const u = db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', String(username || ''));
    const s = u ? app.settings.all(u.business_id) : app.settings.DEFAULTS;
    if (u && u.locked_until && u.locked_until > nowIso()) {
      app.audit.log(auditCtx, `${purpose}.blocked`, { entityType: 'user', entityId: u.id, reference: u.username, businessId: u.business_id, meta: { reason: 'locked' } });
      throw E.unauthorized('Account temporarily locked after repeated failed attempts. Try again later or ask a manager.');
    }
    const secretOk = u && u.is_active && (pin ? verifySecret(String(pin), u.pin_hash) : verifySecret(String(password || ''), u.password_hash));
    if (!u) verifySecret('x', null); // equalize timing
    if (!secretOk) {
      if (u) {
        const fails = u.failed_attempts + 1;
        const lock = fails >= s['security.max_failed_logins'] ? new Date(Date.now() + s['security.lockout_minutes'] * 60000).toISOString() : null;
        db.run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, lock, u.id);
        app.audit.log(auditCtx, `${purpose}.failed`, { entityType: 'user', entityId: u.id, reference: u.username, businessId: u.business_id, meta: { locked: !!lock, method: pin ? 'pin' : 'password' } });
      } else {
        app.audit.log(auditCtx, `${purpose}.failed`, { reference: String(username || '').slice(0, 64), meta: { reason: 'unknown user' } });
      }
      throw E.unauthorized(pin ? 'Invalid username or PIN' : 'Invalid username or password');
    }
    if (u.failed_attempts) db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', u.id);
    return u;
  }

  function login({ username, password, pin, registerId, client }) {
    const u = checkCredentials(username, { password, pin }, { actor: 'login' }, 'auth.login');
    let register = null;
    if (registerId) {
      register = db.get(`SELECT r.*, l.business_id, l.name AS location_name FROM registers r JOIN locations l ON l.id = r.location_id WHERE r.id = ?`, registerId);
      if (!register || register.business_id !== u.business_id || !register.is_active) throw E.validation('Unknown or inactive register for this terminal');
    }
    const token = randomToken();
    const s = app.settings.all(u.business_id);
    const now = nowIso();
    const sessionId = newId('ses');
    db.run(`INSERT INTO auth_sessions (id, token_hash, user_id, register_id, created_at, last_seen_at, expires_at, client) VALUES (?,?,?,?,?,?,?,?)`,
      sessionId, sha256(token), u.id, register ? register.id : null, now, now, new Date(Date.now() + s['security.session_max_hours'] * 3600000).toISOString(), String(client || '').slice(0, 100));
    db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now, u.id);
    const ctx = { user: u, businessId: u.business_id, registerId: register ? register.id : null };
    app.audit.log(ctx, 'auth.login', { entityType: 'user', entityId: u.id, reference: u.username, meta: { method: pin ? 'pin' : 'password', register: register ? register.code : null } });
    return { token, user: publicUser(u), permissions: [...rolePerms(u.role_id)], register_id: register ? register.id : null };
  }

  function authenticate(token) {
    if (!token) return null;
    const row = db.get('SELECT * FROM auth_sessions WHERE token_hash = ?', sha256(token));
    if (!row || row.revoked_at) return null;
    const now = new Date();
    if (row.expires_at < now.toISOString()) return null;
    const u = db.get('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!u || !u.is_active) return null;
    const s = app.settings.all(u.business_id);
    const idleMs = s['security.session_idle_minutes'] * 60000;
    if (now - new Date(row.last_seen_at) > idleMs) {
      db.run('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?', now.toISOString(), row.id);
      return null;
    }
    if (now - new Date(row.last_seen_at) > 30000) db.run('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?', now.toISOString(), row.id);
    const role = db.get('SELECT * FROM roles WHERE id = ?', u.role_id);
    return {
      user: u, role, perms: rolePerms(u.role_id), businessId: u.business_id, registerId: row.register_id, authSessionId: row.id,
    };
  }

  function logout(ctx) {
    db.run('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?', nowIso(), ctx.authSessionId);
    app.audit.log(ctx, 'auth.logout', { entityType: 'user', entityId: ctx.user.id, reference: ctx.user.username });
  }

  const can = (ctx, perm) => !!ctx && ctx.perms.has(perm);
  function require(ctx, perm) {
    if (!can(ctx, perm)) throw E.forbidden(`Your role (${ctx.role.name}) is not allowed to do this`, { permission: perm });
  }

  /**
   * Validate supervisor credentials supplied with a request: the approver must be an active user in
   * the same business holding `perm`, and cannot be the requester. Returns the approver's user row.
   */
  function verifyOverride(ctx, perm, override, what) {
    if (!override || !override.username || (!override.pin && !override.password)) throw E.overrideRequired(perm, `${what || 'This action'} needs supervisor approval`);
    const approver = checkCredentials(override.username, { pin: override.pin, password: override.password }, ctx, 'auth.override');
    if (approver.business_id !== ctx.businessId || !rolePerms(approver.role_id).has(perm)) {
      app.audit.log(ctx, 'auth.override.denied', { entityType: 'user', entityId: approver.id, reference: approver.username, meta: { permission: perm } });
      throw E.forbidden(`${approver.full_name} is not allowed to approve this`, { permission: perm });
    }
    if (approver.id === ctx.user.id) throw E.forbidden('You cannot approve your own override');
    app.audit.log(ctx, 'auth.override.granted', { entityType: 'user', entityId: approver.id, reference: approver.username, approvedBy: approver.id, meta: { permission: perm, what } });
    return approver;
  }

  /**
   * Supervisor override: returns the id of the user who authorized `perm`.
   * If the current user holds the permission it is them; otherwise `override` must carry
   * credentials of an active user in the same business who does.
   */
  function authorize(ctx, perm, override, what) {
    if (can(ctx, perm)) return ctx.user.id;
    return verifyOverride(ctx, perm, override, what).id;
  }

  /** Max discount % a user may give without override. */
  function discountLimit(userId) {
    const r = db.get('SELECT r.max_discount_pct FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?', userId);
    return r ? r.max_discount_pct : 0;
  }

  return { login, authenticate, logout, can, require, authorize, verifyOverride, publicUser, rolePerms, invalidateRoles, discountLimit, checkCredentials };
};
