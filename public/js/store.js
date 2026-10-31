// Data layer: API client, local cache in IndexedDB (so the app opens offline), sync feed, and an outbox for offline edits.
// The server (D1) is the source of truth. The local copy is a cache that is reconciled through /api/sync.
import { expandEvent, localToUtc, utcToLocal, seriesEndUtc } from './time.js';

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

export async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const init = { method, credentials: 'same-origin', headers: { 'x-ff': '1', ...headers } };
  if (body instanceof Blob) { init.body = body; init.headers['content-type'] = body.type || 'application/octet-stream'; }
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  let res;
  try { res = await fetch(path, init); } catch {
    throw new ApiError(0, 'offline', 'You’re offline or the server can’t be reached.');
  }
  if (raw) return res;
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : {};
  if (!res.ok) {
    const e = data.error || {};
    if (res.status === 401 && path !== '/api/auth/login') emit('signed-out');
    throw new ApiError(res.status, e.code || 'http', e.message || `Request failed (${res.status}).`, e);
  }
  return data;
}

// ---------- tiny event bus ----------
const listeners = new Map();
export function on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); }
export function emit(evt, data) { for (const fn of listeners.get(evt) || []) { try { fn(data); } catch (e) { console.error(e); } } }

// ---------- IndexedDB key/value ----------
let dbp = null;
function idb() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('family-flow', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }).catch((e) => { console.warn('IndexedDB unavailable', e); return null; });
  }
  return dbp;
}
async function kvGet(key) {
  const db = await idb();
  if (!db) return null;
  return new Promise((res) => { const t = db.transaction('kv').objectStore('kv').get(key); t.onsuccess = () => res(t.result ?? null); t.onerror = () => res(null); });
}
async function kvSet(key, val) {
  const db = await idb();
  if (!db) return;
  return new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = () => res(); tx.onerror = () => res(); });
}
async function kvClear() {
  const db = await idb();
  if (!db) return;
  return new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').clear(); tx.oncomplete = () => res(); tx.onerror = () => res(); });
}

// ---------- state ----------
export const state = {
  me: null,
  household: null,
  seq: 0,
  members: new Map(),
  events: new Map(),
  lists: new Map(),
  tasks: new Map(),
  outbox: [],
  online: navigator.onLine,
  syncing: false,
  lastSyncAt: 0,
  syncError: null,
  proposalsCount: 0,
  unread: 0,
};

const snapKey = () => `snap:${state.me.user.id}:${state.me.household.id}`;
const outboxKey = () => `outbox:${state.me.user.id}:${state.me.household.id}`;

function applyRows(map, rows) {
  for (const r of rows) {
    if (r.deleted) map.delete(r.id);
    else map.set(r.id, r);
  }
}

async function persist() {
  if (!state.me || !state.me.household) return;
  await kvSet(snapKey(), {
    seq: state.seq, household: state.household, lastSyncAt: state.lastSyncAt,
    members: [...state.members.values()], events: [...state.events.values()].filter((e) => !e._pending),
    lists: [...state.lists.values()], tasks: [...state.tasks.values()].filter((t) => !t._pending),
  });
  await kvSet(outboxKey(), state.outbox);
}

export async function loadCached() {
  const snap = await kvGet(snapKey());
  state.outbox = (await kvGet(outboxKey())) || [];
  if (snap) {
    state.seq = snap.seq; state.household = snap.household; state.lastSyncAt = snap.lastSyncAt || 0;
    state.members = new Map(snap.members.map((x) => [x.id, x]));
    state.events = new Map(snap.events.map((x) => [x.id, x]));
    state.lists = new Map(snap.lists.map((x) => [x.id, x]));
    state.tasks = new Map(snap.tasks.map((x) => [x.id, x]));
  }
  for (const op of state.outbox) if (op.optimistic) applyOptimistic(op.optimistic);
  return !!snap;
}

export function resetState() {
  state.seq = 0; state.members = new Map(); state.events = new Map(); state.lists = new Map(); state.tasks = new Map(); state.outbox = [];
  state.household = null; state.lastSyncAt = 0;
}
export async function clearLocalData() { resetState(); await kvClear(); }

let syncPromise = null;
export function sync({ full = false } = {}) {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    state.syncing = true; emit('status');
    try {
      await flushOutbox();
      const data = await api('GET', `/api/sync?since=${full ? 0 : state.seq}`);
      if (data.full) { state.members = new Map(); state.events = new Map(); state.lists = new Map(); state.tasks = new Map(); }
      state.household = data.household;
      applyRows(state.members, data.members);
      applyRows(state.events, data.events);
      applyRows(state.lists, data.lists);
      applyRows(state.tasks, data.tasks);
      for (const op of state.outbox) if (op.optimistic) applyOptimistic(op.optimistic);
      state.seq = data.seq;
      state.lastSyncAt = Date.now();
      state.syncError = null;
      state.online = true;
      await persist();
      emit('change');
      refreshCounts();
    } catch (e) {
      if (e.code === 'offline') state.online = false;
      else state.syncError = e.message;
    } finally {
      state.syncing = false; syncPromise = null; emit('status');
    }
  })();
  return syncPromise;
}

export async function refreshCounts() {
  try {
    const [p, n] = await Promise.all([api('GET', '/api/proposals'), api('GET', '/api/notifications')]);
    state.proposalsCount = p.proposals.length;
    state.unread = n.notifications.filter((x) => !x.read).length;
    emit('counts');
  } catch { /* offline */ }
}

// ---------- mutations ----------
function applyOptimistic(o) {
  const map = state[o.kind];
  if (o.remove) map.delete(o.id); else map.set(o.id, { ...o.row, _pending: true });
}

// Runs a write. Online: sends it and merges the server's copy. Offline (network failure only): queues it and applies it locally.
// Errors from the server (validation, permission, conflict) are thrown so the UI can show them.
export async function mutate({ method, path, body, kind, optimistic, offlineOk = true }) {
  try {
    const res = await api(method, path, body);
    const row = res.event || res.task || res.member || res.list || res.series;
    for (const r of [row, res.event && res.series ? res.series : null]) {
      if (!r || !kind) continue;
      if (r.deleted) state[kind].delete(r.id); else state[kind].set(r.id, r);
    }
    if (optimistic && optimistic.remove && kind) state[kind].delete(optimistic.id);
    await persist();
    emit('change');
    sync();
    return res;
  } catch (e) {
    if (e.code !== 'offline' || !offlineOk) throw e;
    state.online = false;
    const op = { id: `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, method, path, body, optimistic, at: Date.now() };
    state.outbox.push(op);
    if (optimistic) applyOptimistic(optimistic);
    await persist();
    emit('change'); emit('status');
    return { queued: true };
  }
}

async function flushOutbox() {
  while (state.outbox.length) {
    const op = state.outbox[0];
    try {
      await api(op.method, op.path, op.body);
    } catch (e) {
      if (e.code === 'offline') throw e; // still offline: keep queue
      // The server rejected it (conflict, deleted meanwhile, validation). Drop it, tell the user, server copy wins.
      emit('outbox-rejected', { op, error: e });
    }
    if (op.optimistic && op.optimistic.id.startsWith('tmp_')) state[op.optimistic.kind].delete(op.optimistic.id);
    state.outbox.shift();
    await persist();
  }
}

// ---------- derived data ----------
export const tz = () => (state.household && state.household.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
export const todayStr = () => utcToLocal(Date.now(), tz(), false);
export const nowLocal = () => utcToLocal(Date.now(), tz(), true);
export const membersList = () => [...state.members.values()].sort((a, b) => a.sort - b.sort);
export const listsList = () => [...state.lists.values()].sort((a, b) => a.sort - b.sort);
export const member = (id) => state.members.get(id);

const toRow = (e) => ({
  start_local: e.start, end_local: e.end, start_utc: e.startUtc, end_utc: e.endUtc, tz: e.tz, rrule: e.rrule, exdates: e.exdates || [], all_day: e.allDay,
});

// Occurrences between two local dates [from, to) in the household zone, optionally filtered by member ids.
export function occurrences(fromDate, toDate, filter = null) {
  const z = tz();
  const fromMs = localToUtc(fromDate, z);
  const toMs = localToUtc(toDate, z);
  const out = [];
  for (const e of state.events.values()) {
    if (filter && filter.size && !(e.assignees || []).some((a) => filter.has(a)) && !(filter.has('__none') && !(e.assignees || []).length)) continue;
    const end = e.rrule ? (e.seriesEndUtc ?? null) : e.endUtc;
    if (e.startUtc >= toMs || (end !== null && end <= fromMs)) continue;
    for (const o of expandEvent(toRow(e), fromMs, toMs)) {
      out.push({ ev: e, start: o.start_local, end: o.end_local, startUtc: o.start_utc, endUtc: o.end_utc, key: `${e.id}|${o.start_local}` });
    }
  }
  out.sort((a, b) => (b.ev.allDay - a.ev.allDay) || (a.startUtc - b.startUtc) || a.ev.title.localeCompare(b.ev.title));
  return out;
}

// Builds a locally-computed event row for optimistic offline display.
export function localEventRow(id, input, base = {}) {
  const z = input.tz || tz();
  const startUtc = localToUtc(input.start, z);
  let end = input.end;
  if (!end) end = input.allDay ? addDayLocal(input.start) : utcToLocal(startUtc + 3600000, z, true);
  const row = {
    ...base, id, title: input.title, notes: input.notes || '', location: input.location || null, allDay: !!input.allDay,
    start: input.start, end, tz: z, startUtc, endUtc: localToUtc(end, z), rrule: input.rrule || null, exdates: base.exdates || [],
    assignees: input.assignees || [], visibility: input.visibility || 'shared', reminders: input.reminders || [], version: base.version || 1,
  };
  row.seriesEndUtc = row.rrule ? seriesEndUtc({ ...toRow(row) }) : row.endUtc;
  return row;
}
function addDayLocal(d) {
  const x = new Date(`${d.slice(0, 10)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10);
}

// ---------- background sync triggers ----------
let timer = null;
export function startAutoSync() {
  window.addEventListener('online', () => { state.online = true; emit('status'); sync(); });
  window.addEventListener('offline', () => { state.online = false; emit('status'); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  clearInterval(timer);
  timer = setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 30000);
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'push') { sync(); refreshCounts(); } });
}
