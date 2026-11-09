// Additive schema changes applied by the Worker itself (idempotent), so a deploy works whether or not
// `wrangler d1 migrations apply` runs in the build. Only ever ADD tables/columns here; never drop or rename.
const TABLES = [
  `CREATE TABLE IF NOT EXISTS family_groups (
     id TEXT PRIMARY KEY,
     household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     member_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of member (profile) ids
     sort INTEGER NOT NULL DEFAULT 0,
     version INTEGER NOT NULL DEFAULT 1,
     seq INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER
   )`,
  'CREATE INDEX IF NOT EXISTS idx_family_groups_hh ON family_groups(household_id, seq)',
  `CREATE TABLE IF NOT EXISTS password_resets (
     id TEXT PRIMARY KEY,                     -- sha256 of the token in the link
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     household_id TEXT,
     created_by TEXT,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER
   )`,
];

// [table, column, definition]
const COLUMNS = [
  ['events', 'group_id', 'TEXT'],                                   // null = whole family
  ['events', 'icon', 'TEXT'],                                       // emoji chosen for the activity
  ['lists', 'group_id', 'TEXT'],
  ['members', 'avatar', 'TEXT'],                                    // data:image/... photo or an emoji
  ['members', 'label', 'TEXT'],                                     // how they show up in the app, e.g. Mom, Dad, Grandma
  ['memberships', 'notify_activity', 'INTEGER NOT NULL DEFAULT 1'], // family-activity alerts on/off
  ['memberships', 'setup_done_at', 'INTEGER'], // first-run setup wizard finished or skipped
  ['invites', 'group_id', 'TEXT'],                                 // group link: joiners are added to this family group
  ['invites', 'max_uses', 'INTEGER NOT NULL DEFAULT 1'],            // group links can be used by several people
  ['invites', 'uses', 'INTEGER NOT NULL DEFAULT 0'],
  ['households', 'holidays', 'TEXT'],                               // 'US' | 'none' | null (automatic from time zone)
];

const done = new WeakMap();

async function apply(db) {
  for (const sql of TABLES) await db.prepare(sql).run();
  const cache = new Map();
  for (const [table, col, def] of COLUMNS) {
    if (!cache.has(table)) {
      const info = await db.prepare(`PRAGMA table_info(${table})`).all();
      cache.set(table, new Set((info.results || []).map((r) => r.name)));
    }
    const cols = cache.get(table);
    if (cols.has(col)) continue;
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
    } catch (e) {
      // Another isolate may have added it at the same moment.
      if (!/duplicate column/i.test(String(e.message || e))) throw e;
    }
    cols.add(col);
  }
}

export function ensureSchema(db) {
  if (!db) return Promise.resolve();
  let p = done.get(db);
  if (!p) {
    p = apply(db).catch((e) => { done.delete(db); throw e; });
    done.set(db, p);
  }
  return p;
}
