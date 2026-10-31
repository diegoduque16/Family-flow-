// Thin helpers over the D1 binding.
import { HttpError, uid, now } from './util.js';

export async function one(db, sql, ...args) {
  return (await db.prepare(sql).bind(...args).first()) || null;
}

export async function all(db, sql, ...args) {
  const r = await db.prepare(sql).bind(...args).all();
  return r.results || [];
}

export async function run(db, sql, ...args) {
  return db.prepare(sql).bind(...args).run();
}

// Atomically advance the household change counter; every write stamps its row with the new seq
// so clients can sync with "give me everything since seq N".
export async function nextSeq(db, householdId) {
  const r = await db.prepare('UPDATE households SET seq = seq + 1 WHERE id = ? RETURNING seq').bind(householdId).first();
  if (!r) throw new HttpError(404, 'no_household', 'Household not found.');
  return r.seq;
}

export async function audit(db, { householdId = null, userId = null, action, refType = null, refId = null, detail = null }) {
  await run(db, 'INSERT INTO audit (id, household_id, user_id, action, ref_type, ref_id, detail, created_at) VALUES (?,?,?,?,?,?,?,?)',
    uid('au_'), householdId, userId, action, refType, refId, detail ? JSON.stringify(detail).slice(0, 2000) : null, now());
}

// Fixed-window rate limiter stored in D1 (cheap, good enough for abuse protection).
export async function rateLimit(db, key, limit, windowSec) {
  const t = now();
  const win = Math.floor(t / (windowSec * 1000)) * windowSec * 1000;
  const row = await db.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`).bind(key, win).first();
  if (row && row.count > limit) {
    const retry = Math.ceil((win + windowSec * 1000 - t) / 1000);
    throw new HttpError(429, 'rate_limited', `Too many requests. Please try again in ${retry} seconds.`, { retryAfter: retry });
  }
}

// Daily per-household usage caps for paid APIs (AI, transcription, geocoding).
export const DAILY_CAPS = { assistant: 150, transcribe: 100, geocode: 1500 };

export async function useQuota(db, householdId, kind, env) {
  const cap = Number(env && env[`CAP_${kind.toUpperCase()}`]) || DAILY_CAPS[kind];
  const day = new Date().toISOString().slice(0, 10);
  const row = await db.prepare(
    `INSERT INTO usage (household_id, day, kind, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(household_id, day, kind) DO UPDATE SET count = count + 1 RETURNING count`).bind(householdId, day, kind).first();
  if (row.count > cap) {
    throw new HttpError(429, 'quota', `Your household reached today's limit for ${kind}. It resets at midnight UTC.`);
  }
  return row.count;
}

export async function getSetting(db, key) {
  const r = await one(db, 'SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : null;
}

export async function setSetting(db, key, value) {
  await run(db, `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, key, value, now());
}
