'use strict';
const { newId, nowIso } = require('../lib/ids');
const { E } = require('../lib/errors');
const { v } = require('../lib/validate');
const { hashSecret, randomToken } = require('../lib/crypto');
const { PERMISSIONS } = require('./permissions');
const { REGISTRY } = require('./payments/providers');

/** Business administration: staff, roles, business profile, locations, registers, payment methods & providers. */
module.exports = function adminService(app) {
  const { db } = app;

  // ── users ──
  function listUsers(ctx) {
    app.auth.require(ctx, 'user.manage');
    return db.all(`SELECT u.id, u.username, u.full_name, u.email, u.phone, u.is_active, u.last_login_at, u.locked_until, u.role_id, r.name AS role_name, r.code AS role_code,
        u.home_location_id, l.name AS location_name, (u.pin_hash IS NOT NULL) AS has_pin
      FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN locations l ON l.id = u.home_location_id WHERE u.business_id = ? ORDER BY u.is_active DESC, u.full_name`, ctx.businessId);
  }

  function validatePassword(pw) {
    if (!pw || pw.length < 8) throw E.validation('Password must be at least 8 characters');
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw E.validation('Password must contain letters and numbers');
  }
  function validatePin(pin) {
    if (!/^\d{4,8}$/.test(pin)) throw E.validation('PIN must be 4–8 digits');
    if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) throw E.validation('PIN is too easy to guess');
  }

  function ownersLeft(excludeUserId) {
    return db.value(`SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'owner' AND u.is_active = 1 AND u.id <> ?`, excludeUserId || '');
  }

  function saveUser(ctx, id, body) {
    app.auth.require(ctx, 'user.manage');
    const d = {
      full_name: v.str(body, 'full_name', { required: true, max: 120 }),
      username: v.str(body, 'username', { required: !id, max: 40, pattern: /^[a-z0-9._-]{3,40}$/i }),
      email: v.email(body, 'email'), phone: v.phone(body, 'phone'),
      role_id: v.str(body, 'role_id', { required: true, max: 64 }), home_location_id: v.str(body, 'home_location_id', { max: 64 }),
      is_active: v.bool(body, 'is_active', true) ? 1 : 0,
    };
    const role = db.get('SELECT * FROM roles WHERE id = ? AND business_id = ?', d.role_id, ctx.businessId);
    if (!role) throw E.validation('Unknown role');
    // Only owners may create/assign owner accounts (prevents privilege escalation by managers with user.manage).
    if (role.code === 'owner' && ctx.role.code !== 'owner') throw E.forbidden('Only an owner can grant the Owner role');
    const password = v.str(body, 'password', { max: 200, trim: false });
    const pin = v.str(body, 'pin', { max: 8 });
    if (password) validatePassword(password);
    if (pin) validatePin(pin);
    return db.tx(() => {
      const now = nowIso();
      if (id) {
        const before = db.get('SELECT * FROM users WHERE id = ? AND business_id = ?', id, ctx.businessId);
        if (!before) throw E.notFound('User');
        const beforeRole = db.get('SELECT code FROM roles WHERE id = ?', before.role_id);
        if (beforeRole.code === 'owner' && ctx.role.code !== 'owner') throw E.forbidden('Only an owner can modify an owner account');
        if (beforeRole.code === 'owner' && (role.code !== 'owner' || !d.is_active) && !ownersLeft(id)) throw E.conflict('At least one active owner account must remain');
        if (id === ctx.user.id && !d.is_active) throw E.conflict('You cannot deactivate your own account');
        db.run(`UPDATE users SET full_name=?, email=?, phone=?, role_id=?, home_location_id=?, is_active=?, updated_at=? WHERE id=?`, d.full_name, d.email, d.phone, d.role_id, d.home_location_id, d.is_active, now, id);
        if (password) db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL WHERE id = ?', hashSecret(password), id);
        if (pin) db.run('UPDATE users SET pin_hash = ? WHERE id = ?', hashSecret(pin), id);
        if (!d.is_active) db.run('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, id);
        if (before.role_id !== d.role_id) {
          db.run('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, id);
          app.audit.log(ctx, 'user.role_change', { entityType: 'user', entityId: id, reference: before.username, oldValue: { role: beforeRole.code }, newValue: { role: role.code } });
        }
        app.audit.log(ctx, 'user.update', { entityType: 'user', entityId: id, reference: before.username, oldValue: { is_active: before.is_active, full_name: before.full_name }, newValue: { is_active: d.is_active, full_name: d.full_name, password_reset: !!password, pin_set: !!pin } });
        return id;
      }
      if (!password) throw E.validation('password: is required for new users');
      if (db.get('SELECT 1 FROM users WHERE business_id = ? AND username = ? COLLATE NOCASE', ctx.businessId, d.username)) throw E.conflict('Username is taken');
      const nid = newId('usr');
      db.run(`INSERT INTO users (id,business_id,username,full_name,email,phone,password_hash,pin_hash,role_id,home_location_id,is_active,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        nid, ctx.businessId, d.username, d.full_name, d.email, d.phone, hashSecret(password), pin ? hashSecret(pin) : null, d.role_id, d.home_location_id, d.is_active, 1, now, now);
      app.audit.log(ctx, 'user.create', { entityType: 'user', entityId: nid, reference: d.username, newValue: { role: role.code, full_name: d.full_name } });
      return nid;
    });
  }

  function changeOwnPassword(ctx, body) {
    const current = v.str(body, 'current_password', { required: true, trim: false });
    const next = v.str(body, 'new_password', { required: true, trim: false });
    const u = db.get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    app.auth.checkCredentials(u.username, { password: current }, ctx, 'auth.password_change');
    validatePassword(next);
    if (next === current) throw E.validation('New password must be different');
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', hashSecret(next), nowIso(), ctx.user.id);
    db.run('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', nowIso(), ctx.user.id, ctx.authSessionId);
    app.audit.log(ctx, 'auth.password_change', { entityType: 'user', entityId: ctx.user.id, reference: u.username });
    return { ok: true };
  }
  function changeOwnPin(ctx, body) {
    const password = v.str(body, 'password', { required: true, trim: false });
    const pin = v.str(body, 'pin', { required: true });
    app.auth.checkCredentials(ctx.user.username, { password }, ctx, 'auth.pin_change');
    validatePin(pin);
    db.run('UPDATE users SET pin_hash = ? WHERE id = ?', hashSecret(pin), ctx.user.id);
    app.audit.log(ctx, 'auth.pin_change', { entityType: 'user', entityId: ctx.user.id, reference: ctx.user.username });
    return { ok: true };
  }

  // ── roles ──
  function listRoles(ctx) {
    return db.all(`SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.is_active = 1) AS users FROM roles r WHERE business_id = ? ORDER BY r.is_system DESC, r.name`, ctx.businessId)
      .map((r) => ({ ...r, permissions: [...app.auth.rolePerms(r.id)] }));
  }
  function saveRole(ctx, id, body) {
    app.auth.require(ctx, 'user.manage');
    const d = {
      name: v.str(body, 'name', { required: true, max: 60 }), description: v.str(body, 'description', { max: 200 }),
      max_discount_pct: v.num(body, 'max_discount_pct', { min: 0, max: 100 }) ?? 0,
    };
    const perms = v.arr(body, 'permissions', { required: true, max: 200 });
    const valid = new Set(PERMISSIONS.map((p) => p[0]));
    perms.forEach((p) => { if (!valid.has(p)) throw E.validation(`Unknown permission ${p}`); });
    // cannot grant permissions you don't hold yourself
    const extra = perms.filter((p) => !ctx.perms.has(p));
    if (extra.length) throw E.forbidden(`You cannot grant permissions you do not have: ${extra.join(', ')}`);
    return db.tx(() => {
      let rid = id;
      if (id) {
        const r = db.get('SELECT * FROM roles WHERE id = ? AND business_id = ?', id, ctx.businessId);
        if (!r) throw E.notFound('Role');
        if (r.code === 'owner') throw E.conflict('The Owner role always has full access and cannot be edited');
        const old = [...app.auth.rolePerms(id)];
        db.run('UPDATE roles SET name=?, description=?, max_discount_pct=? WHERE id=?', d.name, d.description, d.max_discount_pct, id);
        db.run('DELETE FROM role_permissions WHERE role_id = ?', id);
        app.audit.log(ctx, 'role.update', { entityType: 'role', entityId: id, reference: r.code, oldValue: { permissions: old, max_discount_pct: r.max_discount_pct }, newValue: { permissions: perms, max_discount_pct: d.max_discount_pct } });
      } else {
        rid = newId('rol');
        const code = v.str(body, 'code', { required: true, max: 30, pattern: /^[a-z_]+$/ });
        if (db.get('SELECT 1 FROM roles WHERE business_id = ? AND code = ?', ctx.businessId, code)) throw E.conflict('Role code exists');
        db.run('INSERT INTO roles (id,business_id,code,name,description,max_discount_pct,is_system,created_at) VALUES (?,?,?,?,?,?,?,?)', rid, ctx.businessId, code, d.name, d.description, d.max_discount_pct, 0, nowIso());
        app.audit.log(ctx, 'role.create', { entityType: 'role', entityId: rid, reference: code, newValue: { permissions: perms } });
      }
      for (const p of perms) db.run('INSERT INTO role_permissions (role_id, permission_code) VALUES (?,?)', rid, p);
      app.auth.invalidateRoles();
      return rid;
    });
  }

  // ── business, locations, registers ──
  function getBusiness(ctx) {
    const b = db.get('SELECT * FROM businesses WHERE id = ?', ctx.businessId);
    return {
      ...b, settings: app.settings.all(ctx.businessId),
      locations: db.all('SELECT * FROM locations WHERE business_id = ? ORDER BY created_at', ctx.businessId),
      registers: db.all(`SELECT r.*, l.name AS location_name, l.code AS location_code FROM registers r JOIN locations l ON l.id = r.location_id WHERE l.business_id = ? ORDER BY l.code, r.code`, ctx.businessId),
    };
  }
  function updateBusiness(ctx, body) {
    app.auth.require(ctx, 'settings.manage');
    const before = db.get('SELECT * FROM businesses WHERE id = ?', ctx.businessId);
    const d = {
      name: v.str(body, 'name', { required: true, max: 120 }), legal_name: v.str(body, 'legal_name', { max: 160 }), tax_id: v.str(body, 'tax_id', { max: 40 }),
      address: v.str(body, 'address', { max: 300 }), phone: v.str(body, 'phone', { max: 40 }), email: v.email(body, 'email'), website: v.str(body, 'website', { max: 120 }),
      currency: v.str(body, 'currency', { required: true, pattern: /^[A-Z]{3}$/ }), currency_minor: v.int(body, 'currency_minor', { min: 0, max: 3 }) ?? before.currency_minor,
      locale: v.str(body, 'locale', { max: 20 }) || before.locale, timezone: v.str(body, 'timezone', { max: 60 }) || before.timezone,
      prices_include_tax: v.bool(body, 'prices_include_tax', !!before.prices_include_tax) ? 1 : 0,
    };
    try { new Intl.DateTimeFormat('en', { timeZone: d.timezone }); } catch (_) { throw E.validation('Unknown timezone'); }
    if (d.currency !== before.currency && db.value(`SELECT COUNT(*) FROM sales WHERE business_id = ? AND status = 'completed'`, ctx.businessId)) {
      throw E.conflict('Currency cannot be changed after sales have been recorded');
    }
    if ('logo_data' in body) {
      const logo = body.logo_data;
      if (logo && (!/^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(logo) || logo.length > 400000)) throw E.validation('Logo must be a PNG/JPEG/SVG/WebP image under 300 KB');
      d.logo_data = logo || null;
    }
    db.tx(() => {
      const keys = Object.keys(d);
      db.run(`UPDATE businesses SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => d[k]), nowIso(), ctx.businessId);
      const changed = keys.filter((k) => k !== 'logo_data' && d[k] !== before[k]);
      app.audit.log(ctx, 'business.update', { entityType: 'business', entityId: ctx.businessId, oldValue: Object.fromEntries(changed.map((k) => [k, before[k]])), newValue: { ...Object.fromEntries(changed.map((k) => [k, d[k]])), logo_changed: 'logo_data' in d } });
    });
    return getBusiness(ctx);
  }
  function updateSettings(ctx, body) {
    app.auth.require(ctx, 'settings.manage');
    const entries = Object.entries(body || {});
    db.tx(() => { for (const [k, val] of entries) { try { app.settings.set(ctx, k, val); } catch (e) { throw E.validation(e.message); } } });
    return app.settings.all(ctx.businessId);
  }
  function saveLocation(ctx, id, body) {
    app.auth.require(ctx, 'settings.manage');
    const d = { code: v.str(body, 'code', { required: true, max: 6, pattern: /^[A-Z0-9]+$/ }), name: v.str(body, 'name', { required: true, max: 80 }),
      type: v.oneOf(body, 'type', ['store', 'warehouse'], { def: 'store' }), address: v.str(body, 'address', { max: 300 }), phone: v.str(body, 'phone', { max: 40 }), is_active: v.bool(body, 'is_active', true) ? 1 : 0 };
    return db.tx(() => {
      if (id) {
        if (!db.get('SELECT 1 FROM locations WHERE id = ? AND business_id = ?', id, ctx.businessId)) throw E.notFound('Location');
        db.run('UPDATE locations SET code=?, name=?, type=?, address=?, phone=?, is_active=? WHERE id=?', d.code, d.name, d.type, d.address, d.phone, d.is_active, id);
      } else {
        id = newId('loc');
        db.run('INSERT INTO locations (id,business_id,code,name,type,address,phone,is_active,created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, ctx.businessId, d.code, d.name, d.type, d.address, d.phone, d.is_active, nowIso());
      }
      app.audit.log(ctx, 'location.save', { entityType: 'location', entityId: id, newValue: d });
      return id;
    });
  }
  function saveRegister(ctx, id, body) {
    app.auth.require(ctx, 'settings.manage');
    const d = { location_id: v.str(body, 'location_id', { required: true, max: 64 }), code: v.str(body, 'code', { required: true, max: 6, pattern: /^[A-Z0-9]+$/ }),
      name: v.str(body, 'name', { required: true, max: 60 }), is_active: v.bool(body, 'is_active', true) ? 1 : 0 };
    if (!db.get('SELECT 1 FROM locations WHERE id = ? AND business_id = ?', d.location_id, ctx.businessId)) throw E.validation('Unknown location');
    return db.tx(() => {
      if (id) {
        const r = db.get('SELECT r.* FROM registers r JOIN locations l ON l.id = r.location_id WHERE r.id = ? AND l.business_id = ?', id, ctx.businessId);
        if (!r) throw E.notFound('Register');
        if (!d.is_active && db.get(`SELECT 1 FROM register_sessions WHERE register_id = ? AND status = 'open'`, id)) throw E.conflict('Close the open session on this register first');
        db.run('UPDATE registers SET location_id=?, code=?, name=?, is_active=? WHERE id=?', d.location_id, d.code, d.name, d.is_active, id);
      } else {
        id = newId('reg');
        db.run('INSERT INTO registers (id,location_id,code,name,is_active,created_at) VALUES (?,?,?,?,?,?)', id, d.location_id, d.code, d.name, d.is_active, nowIso());
      }
      app.audit.log(ctx, 'register.save', { entityType: 'register', entityId: id, newValue: d });
      return id;
    });
  }

  // ── payment methods & providers ──
  function listProviders(ctx) {
    const cfgs = Object.fromEntries(db.all('SELECT * FROM provider_configs WHERE business_id = ?', ctx.businessId).map((c) => [c.provider_code, c]));
    return Object.entries(REGISTRY).map(([code, r]) => {
      const c = cfgs[code];
      return { code, name: r.name, kind: r.kind, integration: r.status, configured: !!c, is_active: c ? !!c.is_active : true, mode: c ? c.mode : (r.kind === 'simulated' ? 'test' : null),
        display_name: c ? c.display_name : r.name, config: c ? JSON.parse(c.config_json) : (r.defaults || {}), has_secret: !!(c && c.secret_ref && app.secrets.has(c.secret_ref)) };
    });
  }
  function saveProvider(ctx, code, body) {
    app.auth.require(ctx, 'settings.manage');
    const reg = REGISTRY[code];
    if (!reg) throw E.notFound('Provider adapter');
    const displayName = v.str(body, 'display_name', { max: 80 }) || reg.name;
    const config = body.config && typeof body.config === 'object' ? body.config : {};
    // refuse anything that looks like a secret in plain config
    for (const k of Object.keys(config)) if (/secret|key|token|password/i.test(k)) throw E.validation(`"${k}" looks like a secret — use the secret field, which is stored encrypted`);
    if (JSON.stringify(config).length > 4000) throw E.validation('Config too large');
    const active = v.bool(body, 'is_active', true) ? 1 : 0;
    return db.tx(() => {
      const existing = db.get('SELECT * FROM provider_configs WHERE business_id = ? AND provider_code = ?', ctx.businessId, code);
      let secretRef = existing ? existing.secret_ref : null;
      if (body.secret) { secretRef = secretRef || `provider:${ctx.businessId}:${code}:${randomToken(6)}`; app.secrets.set(secretRef, String(body.secret)); }
      if (existing) db.run('UPDATE provider_configs SET display_name=?, is_active=?, config_json=?, secret_ref=?, updated_at=? WHERE id=?', displayName, active, JSON.stringify(config), secretRef, nowIso(), existing.id);
      else db.run('INSERT INTO provider_configs (id,business_id,provider_code,display_name,mode,is_active,config_json,secret_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        newId('pvc'), ctx.businessId, code, displayName, reg.kind === 'simulated' ? 'test' : 'live', active, JSON.stringify(config), secretRef, nowIso(), nowIso());
      app.audit.log(ctx, 'provider.configure', { entityType: 'provider', entityId: code, oldValue: existing ? { config: JSON.parse(existing.config_json), is_active: existing.is_active } : null, newValue: { config, is_active: active, secret_changed: !!body.secret } });
      return listProviders(ctx).find((p) => p.code === code);
    });
  }
  function savePaymentMethod(ctx, id, body) {
    app.auth.require(ctx, 'settings.manage');
    const d = {
      code: v.str(body, 'code', { required: true, max: 30, pattern: /^[a-z0-9_]+$/ }), name: v.str(body, 'name', { required: true, max: 60 }),
      type: v.oneOf(body, 'type', ['cash', 'card', 'bank_transfer', 'mobile_money', 'wallet', 'other'], { required: true }),
      provider_code: v.str(body, 'provider_code', { required: true, max: 40 }), is_active: v.bool(body, 'is_active', true) ? 1 : 0,
      requires_reference: v.bool(body, 'requires_reference', false) ? 1 : 0, sort_order: v.int(body, 'sort_order', { min: 0, max: 999 }) || 0, shortcut: v.str(body, 'shortcut', { max: 5 }),
    };
    const reg = REGISTRY[d.provider_code];
    if (!reg) throw E.validation('Unknown provider adapter');
    // Safety rules that are not business preferences:
    d.allow_change = d.type === 'cash' && d.provider_code === 'cash' ? 1 : 0;                      // only cash gives change
    d.allow_offline = reg.kind === 'local' ? (v.bool(body, 'allow_offline', true) ? 1 : 0) : 0;     // electronic never offline
    if (d.provider_code === 'manual') d.requires_reference = 1;
    if (d.type === 'cash' && d.provider_code !== 'cash') throw E.validation('Cash methods must use the cash adapter');
    return db.tx(() => {
      if (id) {
        const before = db.get('SELECT * FROM payment_methods WHERE id = ? AND business_id = ?', id, ctx.businessId);
        if (!before) throw E.notFound('Payment method');
        db.run(`UPDATE payment_methods SET code=?, name=?, type=?, provider_code=?, is_active=?, allow_offline=?, allow_change=?, requires_reference=?, sort_order=?, shortcut=? WHERE id=?`,
          d.code, d.name, d.type, d.provider_code, d.is_active, d.allow_offline, d.allow_change, d.requires_reference, d.sort_order, d.shortcut, id);
        app.audit.log(ctx, 'payment_method.update', { entityType: 'payment_method', entityId: id, oldValue: before, newValue: d });
      } else {
        if (db.get('SELECT 1 FROM payment_methods WHERE business_id = ? AND code = ?', ctx.businessId, d.code)) throw E.conflict('Method code exists');
        id = newId('pmt');
        db.run(`INSERT INTO payment_methods (id,business_id,code,name,type,provider_code,is_active,allow_offline,allow_change,requires_reference,sort_order,shortcut,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, ctx.businessId, d.code, d.name, d.type, d.provider_code, d.is_active, d.allow_offline, d.allow_change, d.requires_reference, d.sort_order, d.shortcut, nowIso());
        app.audit.log(ctx, 'payment_method.create', { entityType: 'payment_method', entityId: id, newValue: d });
      }
      return id;
    });
  }

  function permissionsCatalog() { return PERMISSIONS.map(([code, category, description]) => ({ code, category, description })); }

  return { listUsers, saveUser, changeOwnPassword, changeOwnPin, listRoles, saveRole, getBusiness, updateBusiness, updateSettings, saveLocation, saveRegister, listProviders, saveProvider, savePaymentMethod, permissionsCatalog };
};
