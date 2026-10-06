'use strict';
const fs = require('fs');
const path = require('path');

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(db.all('SELECT name FROM schema_migrations').map((r) => r.name));
  const ran = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.tx(() => {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)', f, new Date().toISOString());
    });
    ran.push(f);
  }
  return ran;
}

module.exports = { migrate };
