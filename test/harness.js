// Test harness: runs the real Worker code in Node against a SQLite database that mimics Cloudflare D1.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handle } from '../src/index.js';

const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, norm(args)); }
  async first(col) {
    const row = this.db.prepare(this.sql).get(...this.args);
    if (!row) return null;
    const plain = { ...row };
    return col ? plain[col] : plain;
  }
  async all() {
    const rows = this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r }));
    return { results: rows, success: true, meta: {} };
  }
  async run() {
    if (/\bRETURNING\b/i.test(this.sql)) {
      const rows = this.db.prepare(this.sql).all(...this.args);
      return { success: true, meta: { changes: rows.length }, results: rows };
    }
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class D1Shim {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON;');
  }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { return Promise.all(stmts.map((s) => s.run())); }
  async exec(sql) { this.db.exec(sql); }
  migrate() {
    const dir = new URL('../migrations/', import.meta.url);
    for (const f of readdirSync(dir).sort()) this.db.exec(readFileSync(new URL(f, dir), 'utf8'));
    return this;
  }
}

class MemR2 {
  constructor() { this.objects = new Map(); }
  async put(key, value) { const buf = value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer(); this.objects.set(key, buf); }
  async head(key) { const b = this.objects.get(key); return b ? { key, size: b.byteLength } : null; }
  async get(key) { const b = this.objects.get(key); return b ? { arrayBuffer: async () => b } : null; }
  async list({ prefix = '' } = {}) { return { objects: [...this.objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; }
  async delete(key) { this.objects.delete(key); }
}

export function makeEnv(overrides = {}) {
  const DB = overrides.DB || new D1Shim(overrides.file).migrate();
  return { DB, BACKUPS: new MemR2(), ...overrides, DB };
}

// A fake fetch router for third-party APIs. routes: [[matcher(url, init) => bool, handler(url, init) => Response]]
export function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [match, h] of routes) if (match(u, init)) return h(u, init);
    throw new Error(`Unexpected fetch ${u}`);
  };
  f.calls = calls;
  return f;
}

export function client(env, origin = 'https://ff.test') {
  let cookie = '';
  async function call(method, path, body, extraHeaders = {}) {
    const headers = { 'x-ff': '1', ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    let payload;
    if (body instanceof Uint8Array) { payload = body; headers['content-type'] = 'audio/webm'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const res = await handle(new Request(origin + path, { method, headers, body: payload }), env);
    const set = res.headers.get('set-cookie');
    if (set) {
      const v = set.split(';')[0];
      cookie = v.endsWith('=') ? '' : v;
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  return {
    call,
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b ?? {}, h),
    patch: (p, b) => call('PATCH', p, b),
    del: (p, b) => call('DELETE', p, b),
    get cookie() { return cookie; },
  };
}

export async function signedUp(env, { name = 'Ana', email = `ana${Math.random().toString(36).slice(2, 8)}@example.com`, household = 'Duque Family', timezone = 'America/New_York', inviteToken } = {}) {
  const c = client(env);
  const r = await c.post('/api/auth/signup', { name, email, password: 'correct horse battery', householdName: inviteToken ? undefined : household, timezone, inviteToken });
  if (r.status !== 201) throw new Error(`signup failed ${r.status} ${JSON.stringify(r.data)}`);
  const me = await c.get('/api/me');
  const s = await c.get('/api/sync');
  return { c, me: me.data, sync: s.data, email };
}
