// Importing Google / Outlook / Apple calendars through their private iCal (.ics) links.
// Imported events are stored as normal (read-only) events so every view, conflict check and the assistant see them.
import { HttpError, json, readJson, validate, v, uid, now, sha256 } from '../lib/util.js';
import { one, all, run, nextSeq, audit } from '../lib/db.js';
import { requireRole } from '../lib/auth.js';
import { utcToLocal, localToUtc } from '../lib/time.js';
import { expandIcs } from '../lib/ics.js';

const PAST_DAYS = 60;
const FUTURE_DAYS = 400;
export const REFRESH_MINUTES = 15;
const MAX_BYTES = 5 * 1024 * 1024;

export function detectProvider(url) {
  const h = new URL(url).hostname;
  if (/(^|\.)google\.com$/.test(h)) return 'google';
  if (/outlook\.(office365|live|office)\.com$|(^|\.)outlook\.com$|office365\.com$/.test(h)) return 'outlook';
  if (/(^|\.)icloud\.com$/.test(h)) return 'apple';
  return 'ics';
}

export function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, 'https://');
  let u;
  try { u = new URL(s); } catch { throw new HttpError(422, 'invalid_url', 'That doesn’t look like a web link. Paste the full link that starts with https:// (or webcal://).', { field: 'url' }); }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:') throw new HttpError(422, 'invalid_url', 'Only https:// or webcal:// calendar links are supported.', { field: 'url' });
  const h = u.hostname;
  if (h === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h.endsWith('.local') || h.endsWith('.internal') || h.includes(':')) {
    throw new HttpError(422, 'invalid_url', 'That link points to a private network address, which can’t be used.', { field: 'url' });
  }
  if (/calendar\.google\.com$/.test(h) && /\/calendar\/(r|u\/\d+\/r)\b/.test(u.pathname) || /\/calendar\/embed/.test(u.pathname)) {
    throw new HttpError(422, 'wrong_google_link', 'That’s a link to the Google Calendar website, not the calendar file. In Google Calendar settings, copy the “Secret address in iCal format” instead.', { field: 'url' });
  }
  return u.toString();
}

const hint = (provider) => ({
  google: 'In Google Calendar → Settings → your calendar → “Integrate calendar”, copy the “Secret address in iCal format”. If your Google account is a work or school account, the administrator may have turned this off.',
  outlook: 'In Outlook on the web → Settings → Calendar → Shared calendars → “Publish a calendar”, publish with “Can view all details”, then copy the ICS link. Work accounts may have publishing turned off by the administrator.',
  apple: 'In the Calendar app, share the calendar as a “Public Calendar” and copy its link.',
  ics: 'Make sure the link is to a calendar file (.ics) and is shared publicly or as a secret link.',
}[provider]);

// Downloads and parses a feed. Throws HttpError with a specific, human explanation on failure.
export async function fetchFeed(env, src) {
  const f = env.__fetch || fetch;
  const provider = detectProvider(src.url);
  const headers = { 'user-agent': 'FamilyFlow/1.0 (calendar import)', accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' };
  if (src.etag) headers['if-none-match'] = src.etag;
  if (src.last_modified) headers['if-modified-since'] = src.last_modified;
  let res;
  try {
    res = await f(src.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new HttpError(502, 'feed_unreachable', `Couldn’t reach the calendar server (${String(e.message || e).slice(0, 80)}). It may be down; we’ll try again automatically.`);
  }
  if (res.status === 304) return { notModified: true };
  if (res.status === 401 || res.status === 403) throw new HttpError(422, 'feed_forbidden', `The calendar server refused access (HTTP ${res.status}). The link may have been reset or made private. ${hint(provider)}`);
  if (res.status === 404 || res.status === 410) throw new HttpError(422, 'feed_not_found', `The calendar link no longer exists (HTTP ${res.status}). It may have been reset. ${hint(provider)}`);
  if (!res.ok) throw new HttpError(502, 'feed_error', `The calendar server returned an error (HTTP ${res.status}). We’ll try again automatically.`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new HttpError(422, 'feed_too_large', 'That calendar is too large to import (over 5 MB).');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new HttpError(422, 'feed_too_large', 'That calendar is too large to import (over 5 MB).');
  const text = new TextDecoder().decode(buf);
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) {
    const looksHtml = /<html|<!doctype/i.test(text.slice(0, 500));
    throw new HttpError(422, 'not_a_calendar', `That link opened a ${looksHtml ? 'web page' : 'file'}, not a calendar. ${hint(provider)}`);
  }
  return { text, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
}

// Applies a parsed feed to the events table. Only rows that actually changed get a new sync sequence.
export async function applyFeed(db, src, household, text) {
  const t = now();
  const fromMs = t - PAST_DAYS * 86400000;
  const toMs = t + FUTURE_DAYS * 86400000;
  const tz = household.timezone;
  const { instances, truncated, calName } = expandIcs(text, { fromMs, toMs, fallbackTz: tz });
  const existing = new Map((await all(db, 'SELECT id, ext_hash, deleted_at FROM events WHERE source_id = ?', src.id)).map((r) => [r.id, r]));
  const seen = new Set();
  let added = 0; let changed = 0; let removed = 0;
  for (const i of instances) {
    const id = `ex_${(await sha256(`${src.id}|${i.uid}|${i.recurrenceKey}`)).slice(0, 22)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let startLocal, endLocal, startUtc, endUtc;
    if (i.allDay) {
      startLocal = i.startDate; endLocal = i.endDate;
      startUtc = localToUtc(startLocal, tz); endUtc = localToUtc(endLocal, tz);
    } else {
      startUtc = i.startUtc; endUtc = i.endUtc;
      startLocal = utcToLocal(startUtc, tz, true); endLocal = utcToLocal(endUtc, tz, true);
    }
    const assignees = JSON.stringify(src.member_id ? [src.member_id] : []);
    const hash = (await sha256(JSON.stringify([i.title, i.notes, i.location, i.allDay, startLocal, endLocal, assignees, src.visibility, src.owner_user_id]))).slice(0, 16);
    const cur = existing.get(id);
    if (cur && !cur.deleted_at && cur.ext_hash === hash) continue;
    const seq = await nextSeq(db, src.household_id);
    if (cur) {
      await run(db,
        `UPDATE events SET title=?, notes=?, location_name='', location_address=?, lat=NULL, lon=NULL, all_day=?, start_local=?, end_local=?, tz=?, start_utc=?, end_utc=?,
           rrule=NULL, series_end_utc=?, exdates='[]', assignees=?, visibility=?, reminders='[]', owner_user_id=?, ext_hash=?, version=version+1, seq=?, updated_at=?, deleted_at=NULL WHERE id=?`,
        i.title, i.notes, i.location, i.allDay ? 1 : 0, startLocal, endLocal, tz, startUtc, endUtc, endUtc, assignees, src.visibility, src.owner_user_id, hash, seq, t, id);
      changed++;
    } else {
      await run(db,
        `INSERT INTO events (id, household_id, title, notes, location_name, location_address, all_day, start_local, end_local, tz, start_utc, end_utc, rrule, series_end_utc,
           exdates, assignees, visibility, reminders, owner_user_id, version, seq, created_at, updated_at, source_id, ext_hash)
         VALUES (?,?,?,?,'',?,?,?,?,?,?,?,NULL,?, '[]', ?, ?, '[]', ?, 1, ?, ?, ?, ?, ?)`,
        id, src.household_id, i.title, i.notes, i.location, i.allDay ? 1 : 0, startLocal, endLocal, tz, startUtc, endUtc, endUtc, assignees, src.visibility, src.owner_user_id, seq, t, t, src.id, hash);
      added++;
    }
  }
  for (const [id, r] of existing) {
    if (seen.has(id) || r.deleted_at) continue;
    const seq = await nextSeq(db, src.household_id);
    await run(db, 'UPDATE events SET deleted_at = ?, version = version + 1, seq = ?, updated_at = ? WHERE id = ?', t, seq, t, id);
    removed++;
  }
  // purge long-deleted imported rows so the table doesn't grow forever
  await run(db, 'DELETE FROM events WHERE source_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?', src.id, t - 30 * 86400000);
  return { added, changed, removed, total: seen.size, truncated, calName };
}

export async function syncSource(env, src) {
  const db = env.DB;
  const household = await one(db, 'SELECT * FROM households WHERE id = ?', src.household_id);
  const t = now();
  try {
    const feed = await fetchFeed(env, src);
    if (feed.notModified) {
      await run(db, "UPDATE calendar_sources SET last_sync_at = ?, last_ok_at = ?, last_status = 'ok', last_error = NULL WHERE id = ?", t, t, src.id);
      return { ok: true, notModified: true, total: src.event_count };
    }
    const r = await applyFeed(db, src, household, feed.text);
    await run(db, "UPDATE calendar_sources SET last_sync_at = ?, last_ok_at = ?, last_status = 'ok', last_error = ?, etag = ?, last_modified = ?, event_count = ? WHERE id = ?",
      t, t, r.truncated ? 'Very large calendar: only the first 4,000 events in range were imported.' : null, feed.etag, feed.lastModified, r.total, src.id);
    return { ok: true, ...r };
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : `Import failed: ${String(e.message || e).slice(0, 200)}`;
    await run(db, "UPDATE calendar_sources SET last_sync_at = ?, last_status = 'error', last_error = ? WHERE id = ?", t, msg, src.id);
    return { ok: false, error: msg, code: e.code };
  }
}

// cron: refresh sources not synced in the last REFRESH_MINUTES (a few per run to spread load)
export async function refreshDueSources(env, at = now(), limit = 8) {
  const due = await all(env.DB, 'SELECT * FROM calendar_sources WHERE deleted_at IS NULL AND (last_sync_at IS NULL OR last_sync_at < ?) ORDER BY last_sync_at LIMIT ?', at - REFRESH_MINUTES * 60000, limit);
  const results = [];
  for (const s of due) results.push(await syncSource(env, s));
  return { checked: due.length, failed: results.filter((r) => !r.ok).length };
}

function sourceOut(r, ctx) {
  const mine = r.owner_user_id === ctx.user.id;
  const host = new URL(r.url).hostname;
  return {
    id: r.id, name: r.name, provider: r.provider, memberId: r.member_id, visibility: r.visibility, mine,
    link: mine ? r.url : `${host} (private link)`,
    lastSyncAt: r.last_sync_at, lastOkAt: r.last_ok_at, status: r.last_status, error: r.last_error, eventCount: r.event_count,
  };
}
const visibleSource = (r, ctx) => r.visibility === 'shared' || r.owner_user_id === ctx.user.id;

export async function listSources(req, env, ctx) {
  const rows = await all(env.DB, 'SELECT * FROM calendar_sources WHERE household_id = ? AND deleted_at IS NULL ORDER BY created_at', ctx.household.id);
  return json({ sources: rows.filter((r) => visibleSource(r, ctx)).map((r) => sourceOut(r, ctx)), refreshMinutes: REFRESH_MINUTES });
}

const srcFields = {
  name: v.string({ max: 60 }).optional(),
  url: v.string({ min: 8, max: 2000 }),
  memberId: v.string({ max: 60 }).nullable(),
  visibility: v.string({ oneOf: ['shared', 'private'] }).default('shared'),
};

async function checkMember(db, ctx, memberId) {
  if (memberId && !(await one(db, 'SELECT 1 FROM members WHERE id = ? AND household_id = ? AND deleted_at IS NULL', memberId, ctx.household.id))) {
    throw new HttpError(422, 'invalid', 'That family profile doesn’t exist.', { field: 'memberId' });
  }
}

export async function addSource(req, env, ctx) {
  requireRole(ctx, ['owner', 'adult']);
  const body = validate(v.object(srcFields), await readJson(req));
  const db = env.DB;
  const url = normalizeUrl(body.url);
  await checkMember(db, ctx, body.memberId);
  const n = await one(db, 'SELECT COUNT(*) AS n FROM calendar_sources WHERE household_id = ? AND deleted_at IS NULL', ctx.household.id);
  if (n.n >= 20) throw new HttpError(422, 'limit', 'A household can import up to 20 calendars.');
  if (await one(db, 'SELECT 1 FROM calendar_sources WHERE household_id = ? AND url = ? AND deleted_at IS NULL', ctx.household.id, url)) {
    throw new HttpError(409, 'duplicate', 'This calendar is already connected.');
  }
  const provider = detectProvider(url);
  // Real test before saving: download and parse it now, so a bad link is reported immediately.
  const feed = await fetchFeed(env, { url });
  const id = uid('cs_');
  const parsedName = (/X-WR-CALNAME:(.*)/i.exec(feed.text) || [])[1];
  const name = (body.name || (parsedName && parsedName.trim()) || { google: 'Google Calendar', outlook: 'Outlook Calendar', apple: 'Apple Calendar', ics: 'Imported calendar' }[provider]).slice(0, 60);
  await run(db, `INSERT INTO calendar_sources (id, household_id, owner_user_id, name, provider, url, member_id, visibility, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, ctx.household.id, ctx.user.id, name, provider, url, body.memberId ?? null, body.visibility, now());
  const src = await one(db, 'SELECT * FROM calendar_sources WHERE id = ?', id);
  const r = await applyFeed(db, src, ctx.household, feed.text);
  const t = now();
  await run(db, "UPDATE calendar_sources SET last_sync_at = ?, last_ok_at = ?, last_status = 'ok', etag = ?, last_modified = ?, event_count = ?, last_error = ? WHERE id = ?",
    t, t, feed.etag, feed.lastModified, r.total, r.truncated ? 'Very large calendar: only the first 4,000 events in range were imported.' : null, id);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'source.add', refType: 'source', refId: id, detail: { provider } });
  return json({ source: sourceOut(await one(db, 'SELECT * FROM calendar_sources WHERE id = ?', id), ctx), imported: r.total }, 201);
}

async function loadOwnSource(db, ctx, id) {
  const s = await one(db, 'SELECT * FROM calendar_sources WHERE id = ? AND household_id = ? AND deleted_at IS NULL', id, ctx.household.id);
  if (!s || !visibleSource(s, ctx)) throw new HttpError(404, 'not_found', 'That connected calendar no longer exists.');
  if (s.owner_user_id !== ctx.user.id && ctx.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only the person who connected this calendar (or a household owner) can change it.');
  return s;
}

export async function updateSource(req, env, ctx, { id }) {
  const db = env.DB;
  const s = await loadOwnSource(db, ctx, id);
  const body = validate(v.object({ name: v.string({ min: 1, max: 60 }).optional(), memberId: v.string({ max: 60 }).nullable(), visibility: v.string({ oneOf: ['shared', 'private'] }).optional() }), await readJson(req));
  if (body.memberId !== undefined) await checkMember(db, ctx, body.memberId);
  if (body.visibility === 'private' && s.owner_user_id !== ctx.user.id) throw new HttpError(403, 'forbidden', 'Only the person who connected it can make it private.');
  await run(db, 'UPDATE calendar_sources SET name = COALESCE(?, name), member_id = CASE WHEN ? THEN ? ELSE member_id END, visibility = COALESCE(?, visibility) WHERE id = ?',
    body.name ?? null, body.memberId !== undefined ? 1 : 0, body.memberId ?? null, body.visibility ?? null, id);
  const src = await one(db, 'SELECT * FROM calendar_sources WHERE id = ?', id);
  // re-apply so member/visibility changes reach the events (without re-downloading if possible)
  const r = await syncSource(env, { ...src, etag: null, last_modified: null });
  return json({ source: sourceOut(await one(db, 'SELECT * FROM calendar_sources WHERE id = ?', id), ctx), sync: r });
}

export async function syncSourceNow(req, env, ctx, { id }) {
  const db = env.DB;
  const s = await one(db, 'SELECT * FROM calendar_sources WHERE id = ? AND household_id = ? AND deleted_at IS NULL', id, ctx.household.id);
  if (!s || !visibleSource(s, ctx)) throw new HttpError(404, 'not_found', 'That connected calendar no longer exists.');
  const r = await syncSource(env, s);
  return json({ source: sourceOut(await one(db, 'SELECT * FROM calendar_sources WHERE id = ?', id), ctx), sync: r });
}

export async function removeSource(req, env, ctx, { id }) {
  const db = env.DB;
  const s = await loadOwnSource(db, ctx, id);
  const t = now();
  await run(db, 'UPDATE calendar_sources SET deleted_at = ? WHERE id = ?', t, id);
  const rows = await all(db, 'SELECT id FROM events WHERE source_id = ? AND deleted_at IS NULL', id);
  for (const r of rows) {
    const seq = await nextSeq(db, s.household_id);
    await run(db, 'UPDATE events SET deleted_at = ?, version = version + 1, seq = ?, updated_at = ? WHERE id = ?', t, seq, t, r.id);
  }
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'source.remove', refType: 'source', refId: id });
  return json({ ok: true, removedEvents: rows.length });
}
