// Events, lists, tasks, sync feed, conflicts and the ICS subscription feed.
import { HttpError, json, readJson, validate, v, uid, now, parseJsonCol, DATE_RE, DATETIME_RE, isValidTimeZone } from '../lib/util.js';
import { one, all, run, nextSeq, audit } from '../lib/db.js';
import { canEdit, requireRole } from '../lib/auth.js';
import { localToUtc, parseRrule, buildRrule, seriesEndUtc, expandEvent, parseLocal, addDays, fmtLocal, utcToLocal } from '../lib/time.js';
import { scheduleEvent, scheduleTask } from '../lib/reminders.js';
import { memberOut } from './account.js';
import { rememberPlace } from './places.js';

// ---------- serialization ----------
export function eventOut(r) {
  return {
    id: r.id, title: r.title, notes: r.notes,
    location: r.location_name || r.location_address ? { name: r.location_name, address: r.location_address, lat: r.lat, lon: r.lon } : null,
    allDay: !!r.all_day, start: r.start_local, end: r.end_local, tz: r.tz,
    startUtc: r.start_utc, endUtc: r.end_utc,
    rrule: r.rrule, seriesEndUtc: r.series_end_utc, exdates: parseJsonCol(r.exdates, []),
    assignees: parseJsonCol(r.assignees, []), visibility: r.visibility, reminders: parseJsonCol(r.reminders, []),
    ownerUserId: r.owner_user_id, sourceId: r.source_id || null, readOnly: !!r.source_id, version: r.version, seq: r.seq, updatedAt: r.updated_at, deleted: !!r.deleted_at,
  };
}
export function listOut(r) {
  return { id: r.id, name: r.name, kind: r.kind, sort: r.sort, version: r.version, seq: r.seq, deleted: !!r.deleted_at };
}
export function taskOut(r) {
  return {
    id: r.id, listId: r.list_id, title: r.title, notes: r.notes, due: r.due_local, dueUtc: r.due_utc,
    assignee: r.assignee, repeat: r.repeat, remind: !!r.remind, eventId: r.event_id,
    done: !!r.done, doneAt: r.done_at, sort: r.sort, version: r.version, seq: r.seq, updatedAt: r.updated_at, deleted: !!r.deleted_at,
  };
}

const visible = (r, ctx) => r.visibility !== 'private' || r.owner_user_id === ctx.user.id;

// ---------- event validation ----------
const locationSchema = v.object({
  name: v.string({ max: 200 }).default(''),
  address: v.string({ max: 300 }).default(''),
  lat: v.number({ min: -90, max: 90 }).optional(),
  lon: v.number({ min: -180, max: 180 }).optional(),
});

const eventFields = {
  title: v.string({ min: 1, max: 200 }),
  notes: v.string({ max: 5000 }).default(''),
  location: locationSchema.nullable(),
  allDay: v.boolean().default(false),
  start: v.string({ max: 16 }),
  end: v.string({ max: 16 }).optional(),
  tz: v.string({ max: 60 }).optional(),
  rrule: v.string({ max: 200 }).nullable(),
  assignees: v.array(v.string({ max: 60 }), { max: 20 }).default([]),
  visibility: v.string({ oneOf: ['shared', 'private'] }).default('shared'),
  reminders: v.array(v.number({ int: true, min: 0, max: 60 * 24 * 28 }), { max: 5 }).default([]),
};
export const eventSchema = v.object(eventFields);

// Normalises + checks an event; returns DB column values.
export async function normalizeEvent(db, ctx, e) {
  const tz = e.tz || ctx.household.timezone;
  if (!isValidTimeZone(tz)) throw new HttpError(422, 'invalid', 'tz is not a valid time zone', { field: 'tz' });
  const re = e.allDay ? DATE_RE : DATETIME_RE;
  if (!re.test(e.start)) throw new HttpError(422, 'invalid', e.allDay ? 'start must be a date (YYYY-MM-DD)' : 'start must be a date and time (YYYY-MM-DDTHH:MM)', { field: 'start' });
  let end = e.end;
  if (!end) {
    if (e.allDay) end = fmtLocal(addDays(...e.start.split('-').map(Number), 1), false);
    else end = utcToLocal(localToUtc(e.start, tz) + 3600000, tz);
  }
  if (!re.test(end)) throw new HttpError(422, 'invalid', 'end has the wrong format', { field: 'end' });
  const startUtc = localToUtc(e.start, tz);
  // Default length is one real hour (not one wall-clock hour), so it works across the autumn clock change.
  const endUtc = !e.end && !e.allDay ? startUtc + 3600000 : localToUtc(end, tz);
  if (!(endUtc > startUtc)) throw new HttpError(422, 'invalid', 'end must be after start', { field: 'end' });
  if (endUtc - startUtc > 366 * 86400000) throw new HttpError(422, 'invalid', 'events can last at most a year', { field: 'end' });
  let rrule = null;
  if (e.rrule) {
    try { rrule = buildRrule(parseRrule(e.rrule)); } catch (err) { throw new HttpError(422, 'invalid', `rrule: ${err.message}`, { field: 'rrule' }); }
  }
  const assignees = [...new Set(e.assignees)];
  if (assignees.length) {
    const rows = await all(db, `SELECT id FROM members WHERE household_id = ? AND deleted_at IS NULL AND id IN (${assignees.map(() => '?').join(',')})`, ctx.household.id, ...assignees);
    if (rows.length !== assignees.length) throw new HttpError(422, 'invalid', 'assignees contains an unknown family member', { field: 'assignees' });
  }
  const loc = e.location || { name: '', address: '' };
  const row = {
    title: e.title, notes: e.notes || '', location_name: loc.name || '', location_address: loc.address || '',
    lat: loc.lat ?? null, lon: loc.lon ?? null, all_day: e.allDay ? 1 : 0, start_local: e.start, end_local: end, tz,
    start_utc: startUtc, end_utc: endUtc, rrule, assignees: JSON.stringify(assignees), visibility: e.visibility,
    reminders: JSON.stringify([...new Set(e.reminders)].sort((a, b) => a - b)),
  };
  row.series_end_utc = rrule ? seriesEndUtc({ ...row, exdates: '[]' }) : endUtc;
  return row;
}

async function findConflicts(db, ctx, row, excludeId) {
  const assignees = parseJsonCol(row.assignees, []);
  if (!assignees.length || row.all_day) return [];
  const windowEnd = Math.min(row.series_end_utc ?? Infinity, row.start_utc + 60 * 86400000);
  const mine = expandEvent({ ...row, exdates: row.exdates || '[]' }, row.start_utc, windowEnd + 1).slice(0, 60);
  if (!mine.length) return [];
  const others = await all(db,
    `SELECT * FROM events WHERE household_id = ? AND deleted_at IS NULL AND all_day = 0 AND id != ?
       AND start_utc < ? AND (series_end_utc IS NULL OR series_end_utc > ?)`,
    ctx.household.id, excludeId || '', windowEnd, row.start_utc);
  const out = [];
  for (const o of others) {
    if (!visible(o, ctx)) continue;
    const shared = parseJsonCol(o.assignees, []).filter((a) => assignees.includes(a));
    if (!shared.length) continue;
    const occ = expandEvent(o, row.start_utc, windowEnd + 1);
    const hit = occ.find((x) => mine.some((m) => m.start_utc < x.end_utc && x.start_utc < m.end_utc));
    if (hit) out.push({ eventId: o.id, title: o.title, start: hit.start_local, members: shared });
    if (out.length >= 5) break;
  }
  return out;
}

export async function createEventCore(db, ctx, input) {
  if (!canEdit(ctx) && input.visibility !== 'private') requireRole(ctx, ['owner', 'adult']);
  const row = await normalizeEvent(db, ctx, input);
  const id = uid('ev_');
  const t = now();
  const seq = await nextSeq(db, ctx.household.id);
  await run(db,
    `INSERT INTO events (id, household_id, title, notes, location_name, location_address, lat, lon, all_day, start_local, end_local, tz,
       start_utc, end_utc, rrule, series_end_utc, exdates, assignees, visibility, reminders, owner_user_id, version, seq, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]',?,?,?,?,1,?,?,?)`,
    id, ctx.household.id, row.title, row.notes, row.location_name, row.location_address, row.lat, row.lon, row.all_day, row.start_local,
    row.end_local, row.tz, row.start_utc, row.end_utc, row.rrule, row.series_end_utc, row.assignees, row.visibility, row.reminders,
    ctx.user.id, seq, t, t);
  const saved = await one(db, 'SELECT * FROM events WHERE id = ?', id);
  await scheduleEvent(db, saved);
  if (row.location_address) await rememberPlace(db, ctx.household.id, { name: row.location_name, address: row.location_address, lat: row.lat, lon: row.lon });
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'event.create', refType: 'event', refId: id });
  const conflicts = await findConflicts(db, ctx, saved, id);
  return { event: eventOut(saved), conflicts };
}

// ---------- routes: events ----------
export async function createEvent(req, env, ctx) {
  const input = validate(eventSchema, await readJson(req));
  const result = await createEventCore(env.DB, ctx, input);
  return json(result, 201);
}

async function loadEditable(db, ctx, id) {
  const cur = await one(db, 'SELECT * FROM events WHERE id = ? AND household_id = ?', id, ctx.household.id);
  if (!cur || cur.deleted_at || !visible(cur, ctx)) throw new HttpError(404, 'not_found', 'Event not found. It may have been deleted.');
  if (cur.source_id) {
    const src = await one(db, 'SELECT name, provider FROM calendar_sources WHERE id = ?', cur.source_id);
    const where = src ? { google: 'Google Calendar', outlook: 'Outlook', apple: 'Apple Calendar' }[src.provider] || `“${src.name}”` : 'another calendar';
    throw new HttpError(403, 'read_only', `This event comes from ${where}. Change it there and it will update here automatically.`);
  }
  if (!canEdit(ctx) && cur.owner_user_id !== ctx.user.id) throw new HttpError(403, 'forbidden', 'You can only change your own events.');
  return cur;
}

function dayBefore(localDate) {
  const p = parseLocal(localDate);
  return fmtLocal(addDays(p.y, p.m, p.d, -1), false);
}

const patchSchema = v.object({
  ...Object.fromEntries(Object.entries(eventFields).map(([k, f]) => [k, f.optional()])),
  rrule: v.string({ max: 200 }).nullable(),
  location: locationSchema.nullable(),
  version: v.number({ int: true, min: 1 }),
  scope: v.string({ oneOf: ['all', 'this', 'following'] }).default('all'),
  occurrence: v.string({ max: 16 }).optional(), // start_local of the occurrence being edited
});

export async function updateEvent(req, env, ctx, { id }) {
  const db = env.DB;
  const body = await readJson(req);
  const patch = validate(patchSchema, body);
  const cur = await loadEditable(db, ctx, id);
  if (cur.version !== patch.version) {
    throw new HttpError(409, 'conflict', 'This event was changed by someone else. Review the latest version and try again.', { current: eventOut(cur) });
  }
  const base = eventOut(cur);
  const merged = {
    title: patch.title ?? base.title, notes: patch.notes ?? base.notes,
    location: 'location' in body ? patch.location ?? null : base.location,
    allDay: patch.allDay ?? base.allDay, start: patch.start ?? base.start, end: patch.end ?? (patch.start || patch.allDay !== undefined ? undefined : base.end),
    tz: patch.tz ?? base.tz, rrule: 'rrule' in body ? patch.rrule ?? null : base.rrule,
    assignees: patch.assignees ?? base.assignees, visibility: patch.visibility ?? base.visibility, reminders: patch.reminders ?? base.reminders,
  };
  if (patch.start && !patch.end && !('allDay' in body && patch.allDay !== base.allDay)) {
    // keep the original duration when only the start moves
    const dur = cur.end_utc - cur.start_utc;
    const tz = merged.tz;
    merged.end = merged.allDay ? undefined : utcToLocal(localToUtc(patch.start, tz) + dur, tz);
  }

  const scope = cur.rrule ? patch.scope : 'all';
  const t = now();
  if (scope === 'all') {
    const row = await normalizeEvent(db, ctx, merged);
    const seq = await nextSeq(db, ctx.household.id);
    const exdates = row.rrule && row.start_local === cur.start_local ? cur.exdates : '[]';
    await run(db,
      `UPDATE events SET title=?, notes=?, location_name=?, location_address=?, lat=?, lon=?, all_day=?, start_local=?, end_local=?, tz=?,
         start_utc=?, end_utc=?, rrule=?, series_end_utc=?, exdates=?, assignees=?, visibility=?, reminders=?, version=version+1, seq=?, updated_at=?
       WHERE id = ? AND version = ?`,
      row.title, row.notes, row.location_name, row.location_address, row.lat, row.lon, row.all_day, row.start_local, row.end_local, row.tz,
      row.start_utc, row.end_utc, row.rrule, row.series_end_utc, exdates, row.assignees, row.visibility, row.reminders, seq, t, id, cur.version);
    const saved = await one(db, 'SELECT * FROM events WHERE id = ?', id);
    if (saved.version !== cur.version + 1) throw new HttpError(409, 'conflict', 'This event was changed by someone else at the same moment.', { current: eventOut(saved) });
    await scheduleEvent(db, saved);
    if (row.location_address) await rememberPlace(db, ctx.household.id, { name: row.location_name, address: row.location_address, lat: row.lat, lon: row.lon });
    await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'event.update', refType: 'event', refId: id });
    return json({ event: eventOut(saved), conflicts: await findConflicts(db, ctx, saved, id) });
  }

  // Recurring series, editing one occurrence or this-and-following.
  if (!patch.occurrence) throw new HttpError(422, 'invalid', 'occurrence is required when editing part of a repeating event', { field: 'occurrence' });
  const occList = expandEvent(cur, localToUtc(patch.occurrence, cur.tz) - 1, localToUtc(patch.occurrence, cur.tz) + 1);
  const occ = occList.find((o) => o.start_local === patch.occurrence);
  if (!occ) throw new HttpError(422, 'invalid', 'That occurrence is not part of this repeating event', { field: 'occurrence' });
  const seq = await nextSeq(db, ctx.household.id);
  if (scope === 'this') {
    const ex = parseJsonCol(cur.exdates, []);
    ex.push(patch.occurrence);
    await run(db, 'UPDATE events SET exdates = ?, version = version + 1, seq = ?, updated_at = ? WHERE id = ?', JSON.stringify(ex), seq, t, id);
    const single = { ...merged, rrule: null };
    if (!patch.start) { single.start = occ.start_local; single.end = patch.end ?? occ.end_local; }
    const created = await createEventCore(db, ctx, single);
    await scheduleEvent(db, await one(db, 'SELECT * FROM events WHERE id = ?', id));
    return json({ event: created.event, series: eventOut(await one(db, 'SELECT * FROM events WHERE id = ?', id)), conflicts: created.conflicts });
  }
  // following: end the old series the day before, start a new series at this occurrence
  const occDate = patch.occurrence.slice(0, 10);
  const oldRule = parseRrule(cur.rrule);
  const firstDate = cur.start_local.slice(0, 10);
  if (occDate === firstDate) {
    // editing from the first occurrence is the same as editing all
    return updateEvent(new Request(req.url, { method: 'PATCH', headers: req.headers, body: JSON.stringify({ ...body, scope: 'all' }) }), env, ctx, { id });
  }
  oldRule.until = dayBefore(occDate); oldRule.count = null;
  const newRuleStr = merged.rrule ? (() => { const r = parseRrule(merged.rrule); r.count = null; return buildRrule(r); })() : null;
  const oldRow = { ...cur, rrule: buildRrule(oldRule) };
  await run(db, 'UPDATE events SET rrule = ?, series_end_utc = ?, version = version + 1, seq = ?, updated_at = ? WHERE id = ?',
    oldRow.rrule, seriesEndUtc(oldRow), seq, t, id);
  const next = { ...merged, rrule: newRuleStr };
  if (!patch.start) { next.start = occ.start_local; next.end = patch.end ?? occ.end_local; }
  const created = await createEventCore(db, ctx, next);
  await scheduleEvent(db, await one(db, 'SELECT * FROM events WHERE id = ?', id));
  return json({ event: created.event, series: eventOut(await one(db, 'SELECT * FROM events WHERE id = ?', id)), conflicts: created.conflicts });
}

export async function deleteEvent(req, env, ctx, { id }) {
  const db = env.DB;
  const url = new URL(req.url);
  const version = Number(url.searchParams.get('version'));
  const scope = url.searchParams.get('scope') || 'all';
  const occurrence = url.searchParams.get('occurrence');
  const cur = await loadEditable(db, ctx, id);
  if (version && cur.version !== version) throw new HttpError(409, 'conflict', 'This event was changed by someone else. Review it before deleting.', { current: eventOut(cur) });
  const seq = await nextSeq(db, ctx.household.id);
  const t = now();
  if (cur.rrule && scope === 'this' && occurrence) {
    const ex = parseJsonCol(cur.exdates, []);
    if (!ex.includes(occurrence)) ex.push(occurrence);
    await run(db, 'UPDATE events SET exdates = ?, version = version + 1, seq = ?, updated_at = ? WHERE id = ?', JSON.stringify(ex), seq, t, id);
  } else if (cur.rrule && scope === 'following' && occurrence && occurrence.slice(0, 10) !== cur.start_local.slice(0, 10)) {
    const r = parseRrule(cur.rrule);
    r.until = dayBefore(occurrence.slice(0, 10)); r.count = null;
    const rule = buildRrule(r);
    await run(db, 'UPDATE events SET rrule = ?, series_end_utc = ?, version = version + 1, seq = ?, updated_at = ? WHERE id = ?',
      rule, seriesEndUtc({ ...cur, rrule: rule }), seq, t, id);
  } else {
    await run(db, 'UPDATE events SET deleted_at = ?, version = version + 1, seq = ?, updated_at = ? WHERE id = ?', t, seq, t, id);
  }
  const saved = await one(db, 'SELECT * FROM events WHERE id = ?', id);
  await scheduleEvent(db, saved);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'event.delete', refType: 'event', refId: id, detail: { scope } });
  return json({ ok: true, event: eventOut(saved) });
}

export async function getEvent(req, env, ctx, { id }) {
  const r = await one(env.DB, 'SELECT * FROM events WHERE id = ? AND household_id = ?', id, ctx.household.id);
  if (!r || r.deleted_at || !visible(r, ctx)) throw new HttpError(404, 'not_found', 'Event not found.');
  return json({ event: eventOut(r) });
}

// Occurrences between two local dates (inclusive from, exclusive to), in household time.
export async function listOccurrences(db, ctx, fromDate, toDate) {
  const tz = ctx.household.timezone;
  const fromMs = localToUtc(fromDate, tz);
  const toMs = localToUtc(toDate, tz);
  const rows = await all(db,
    `SELECT * FROM events WHERE household_id = ? AND deleted_at IS NULL AND start_utc < ? AND (series_end_utc IS NULL OR series_end_utc > ?)`,
    ctx.household.id, toMs, fromMs);
  const out = [];
  for (const r of rows) {
    if (!visible(r, ctx)) continue;
    for (const o of expandEvent(r, fromMs, toMs)) out.push({ ...eventOut(r), occurrence: o });
  }
  out.sort((a, b) => a.occurrence.start_utc - b.occurrence.start_utc || a.title.localeCompare(b.title));
  return out;
}

export async function listEvents(req, env, ctx) {
  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) throw new HttpError(422, 'invalid', 'from and to must be dates (YYYY-MM-DD)');
  if (localToUtc(to, 'UTC') - localToUtc(from, 'UTC') > 400 * 86400000) throw new HttpError(422, 'invalid', 'range too large (max ~13 months)');
  return json({ occurrences: await listOccurrences(env.DB, ctx, from, to) });
}

export async function checkConflicts(req, env, ctx) {
  const input = validate(v.object({ ...eventFields, id: v.string({ max: 60 }).optional() }), await readJson(req));
  const row = await normalizeEvent(env.DB, ctx, input);
  return json({ conflicts: await findConflicts(env.DB, ctx, row, input.id) });
}

// ---------- lists & tasks ----------
const listSchema = v.object({ name: v.string({ min: 1, max: 60 }), kind: v.string({ oneOf: ['todo', 'shopping'] }).default('todo') });

export async function createList(req, env, ctx) {
  requireRole(ctx, ['owner', 'adult']);
  const body = validate(listSchema, await readJson(req));
  const db = env.DB;
  const seq = await nextSeq(db, ctx.household.id);
  const id = uid('l_');
  const n = await one(db, 'SELECT COUNT(*) AS n FROM lists WHERE household_id = ? AND deleted_at IS NULL', ctx.household.id);
  if (n.n >= 50) throw new HttpError(422, 'limit', 'You can have up to 50 lists.');
  await run(db, 'INSERT INTO lists (id, household_id, name, kind, sort, version, seq, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)',
    id, ctx.household.id, body.name, body.kind, n.n, seq, now(), now());
  return json({ list: listOut(await one(db, 'SELECT * FROM lists WHERE id = ?', id)) }, 201);
}

export async function updateList(req, env, ctx, { id }) {
  requireRole(ctx, ['owner', 'adult']);
  const body = validate(v.object({ name: v.string({ min: 1, max: 60 }).optional(), sort: v.number({ int: true, min: 0, max: 999 }).optional(), version: v.number({ int: true, min: 1 }) }), await readJson(req));
  const db = env.DB;
  const cur = await one(db, 'SELECT * FROM lists WHERE id = ? AND household_id = ? AND deleted_at IS NULL', id, ctx.household.id);
  if (!cur) throw new HttpError(404, 'not_found', 'List not found.');
  if (cur.version !== body.version) throw new HttpError(409, 'conflict', 'This list was changed by someone else.', { current: listOut(cur) });
  const seq = await nextSeq(db, ctx.household.id);
  await run(db, 'UPDATE lists SET name = ?, sort = ?, version = version + 1, seq = ?, updated_at = ? WHERE id = ?', body.name ?? cur.name, body.sort ?? cur.sort, seq, now(), id);
  return json({ list: listOut(await one(db, 'SELECT * FROM lists WHERE id = ?', id)) });
}

export async function deleteList(req, env, ctx, { id }) {
  requireRole(ctx, ['owner', 'adult']);
  const db = env.DB;
  const cur = await one(db, 'SELECT * FROM lists WHERE id = ? AND household_id = ? AND deleted_at IS NULL', id, ctx.household.id);
  if (!cur) throw new HttpError(404, 'not_found', 'List not found.');
  const n = await one(db, 'SELECT COUNT(*) AS n FROM lists WHERE household_id = ? AND deleted_at IS NULL', ctx.household.id);
  if (n.n <= 1) throw new HttpError(422, 'last_list', 'Keep at least one list.');
  const seq = await nextSeq(db, ctx.household.id);
  const t = now();
  await run(db, 'UPDATE lists SET deleted_at = ?, seq = ?, version = version + 1 WHERE id = ?', t, seq, id);
  const tasks = await all(db, 'SELECT id FROM tasks WHERE list_id = ? AND deleted_at IS NULL', id);
  for (const tk of tasks) {
    const s = await nextSeq(db, ctx.household.id);
    await run(db, 'UPDATE tasks SET deleted_at = ?, seq = ?, version = version + 1 WHERE id = ?', t, s, tk.id);
    await run(db, "DELETE FROM scheduled_notifications WHERE ref_type = 'task' AND ref_id = ? AND status = 'pending'", tk.id);
  }
  return json({ ok: true });
}

const taskFields = {
  listId: v.string({ min: 1, max: 60 }),
  title: v.string({ min: 1, max: 200 }),
  notes: v.string({ max: 2000 }).default(''),
  due: v.string({ max: 16 }).nullable(),
  assignee: v.string({ max: 60 }).nullable(),
  repeat: v.string({ oneOf: ['daily', 'weekly', 'monthly'] }).nullable(),
  remind: v.boolean().default(false),
  eventId: v.string({ max: 60 }).nullable(),
};
export const taskSchema = v.object(taskFields);

async function normalizeTask(db, ctx, t) {
  if (!(await one(db, 'SELECT 1 FROM lists WHERE id = ? AND household_id = ? AND deleted_at IS NULL', t.listId, ctx.household.id))) {
    throw new HttpError(422, 'invalid', 'listId is not a list in this household', { field: 'listId' });
  }
  if (t.assignee && !(await one(db, 'SELECT 1 FROM members WHERE id = ? AND household_id = ? AND deleted_at IS NULL', t.assignee, ctx.household.id))) {
    throw new HttpError(422, 'invalid', 'assignee is not a family member', { field: 'assignee' });
  }
  if (t.due && !DATE_RE.test(t.due) && !DATETIME_RE.test(t.due)) throw new HttpError(422, 'invalid', 'due must be YYYY-MM-DD or YYYY-MM-DDTHH:MM', { field: 'due' });
  if (t.eventId && !(await one(db, 'SELECT 1 FROM events WHERE id = ? AND household_id = ?', t.eventId, ctx.household.id))) {
    throw new HttpError(422, 'invalid', 'eventId not found', { field: 'eventId' });
  }
  const dueUtc = t.due ? localToUtc(DATE_RE.test(t.due) ? `${t.due}T23:59` : t.due, ctx.household.timezone) : null;
  return { dueUtc };
}

export async function createTaskCore(db, ctx, t) {
  const { dueUtc } = await normalizeTask(db, ctx, t);
  const id = uid('t_');
  const seq = await nextSeq(db, ctx.household.id);
  const ts = now();
  const sort = (await one(db, 'SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM tasks WHERE list_id = ?', t.listId)).s;
  await run(db,
    `INSERT INTO tasks (id, household_id, list_id, title, notes, due_local, due_utc, assignee, repeat, remind, event_id, done, sort, created_by, version, seq, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,1,?,?,?)`,
    id, ctx.household.id, t.listId, t.title, t.notes || '', t.due ?? null, dueUtc, t.assignee ?? null, t.repeat ?? null, t.remind ? 1 : 0,
    t.eventId ?? null, sort, ctx.user.id, seq, ts, ts);
  const saved = await one(db, 'SELECT * FROM tasks WHERE id = ?', id);
  await scheduleTask(db, saved, ctx.household.timezone);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'task.create', refType: 'task', refId: id });
  return { task: taskOut(saved) };
}

export async function createTask(req, env, ctx) {
  const t = validate(taskSchema, await readJson(req));
  return json(await createTaskCore(env.DB, ctx, t), 201);
}

function nextDue(due, repeat) {
  const p = parseLocal(due);
  let n;
  if (repeat === 'daily') n = addDays(p.y, p.m, p.d, 1);
  else if (repeat === 'weekly') n = addDays(p.y, p.m, p.d, 7);
  else {
    const m0 = p.m; // monthly: same day next month, clamped
    const y = p.y + (m0 === 12 ? 1 : 0);
    const m = m0 === 12 ? 1 : m0 + 1;
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    n = { y, m, d: Math.min(p.d, dim) };
  }
  return fmtLocal({ ...n, h: p.h, mi: p.mi }, p.timed);
}

export async function updateTask(req, env, ctx, { id }) {
  const db = env.DB;
  const body = await readJson(req);
  const patch = validate(v.object({
    ...Object.fromEntries(Object.entries(taskFields).map(([k, f]) => [k, f.optional()])),
    due: v.string({ max: 16 }).nullable(), assignee: v.string({ max: 60 }).nullable(),
    repeat: v.string({ oneOf: ['daily', 'weekly', 'monthly'] }).nullable(), eventId: v.string({ max: 60 }).nullable(),
    done: v.boolean().optional(),
    version: v.number({ int: true, min: 1 }),
  }), body);
  const cur = await one(db, 'SELECT * FROM tasks WHERE id = ? AND household_id = ? AND deleted_at IS NULL', id, ctx.household.id);
  if (!cur) throw new HttpError(404, 'not_found', 'Task not found. It may have been deleted.');
  if (ctx.role === 'child') {
    const onlyDone = Object.keys(body).every((k) => ['done', 'version'].includes(k));
    if (!onlyDone) throw new HttpError(403, 'forbidden', 'You can tick tasks off, but only adults can edit them.');
  }
  if (cur.version !== patch.version) throw new HttpError(409, 'conflict', 'This task was changed by someone else.', { current: taskOut(cur) });
  const m = {
    listId: patch.listId ?? cur.list_id, title: patch.title ?? cur.title, notes: patch.notes ?? cur.notes,
    due: 'due' in body ? patch.due ?? null : cur.due_local, assignee: 'assignee' in body ? patch.assignee ?? null : cur.assignee,
    repeat: 'repeat' in body ? patch.repeat ?? null : cur.repeat, remind: patch.remind ?? !!cur.remind,
    eventId: 'eventId' in body ? patch.eventId ?? null : cur.event_id,
  };
  let done = patch.done ?? !!cur.done;
  let doneAt = cur.done_at;
  if (patch.done === true && !cur.done) {
    doneAt = now();
    if (m.repeat && m.due) { m.due = nextDue(m.due, m.repeat); done = false; } // repeating task rolls forward
  }
  if (patch.done === false) doneAt = null;
  const { dueUtc } = await normalizeTask(db, ctx, m);
  const seq = await nextSeq(db, ctx.household.id);
  await run(db,
    `UPDATE tasks SET list_id=?, title=?, notes=?, due_local=?, due_utc=?, assignee=?, repeat=?, remind=?, event_id=?, done=?, done_at=?,
       version = version + 1, seq = ?, updated_at = ? WHERE id = ? AND version = ?`,
    m.listId, m.title, m.notes, m.due, dueUtc, m.assignee, m.repeat, m.remind ? 1 : 0, m.eventId, done ? 1 : 0, doneAt, seq, now(), id, cur.version);
  const saved = await one(db, 'SELECT * FROM tasks WHERE id = ?', id);
  if (saved.version !== cur.version + 1) throw new HttpError(409, 'conflict', 'This task was changed by someone else at the same moment.', { current: taskOut(saved) });
  await scheduleTask(db, saved, ctx.household.timezone);
  return json({ task: taskOut(saved) });
}

export async function deleteTask(req, env, ctx, { id }) {
  requireRole(ctx, ['owner', 'adult']);
  const db = env.DB;
  const cur = await one(db, 'SELECT * FROM tasks WHERE id = ? AND household_id = ? AND deleted_at IS NULL', id, ctx.household.id);
  if (!cur) throw new HttpError(404, 'not_found', 'Task not found.');
  const seq = await nextSeq(db, ctx.household.id);
  await run(db, 'UPDATE tasks SET deleted_at = ?, version = version + 1, seq = ? WHERE id = ?', now(), seq, id);
  await run(db, "DELETE FROM scheduled_notifications WHERE ref_type = 'task' AND ref_id = ? AND status = 'pending'", id);
  return json({ ok: true });
}

// ---------- sync ----------
export async function sync(req, env, ctx) {
  if (!ctx.household) throw new HttpError(409, 'no_household', 'Create or join a household first.');
  const since = Math.max(0, Number(new URL(req.url).searchParams.get('since')) || 0);
  const db = env.DB;
  const hh = ctx.household.id;
  const seq = (await one(db, 'SELECT seq FROM households WHERE id = ?', hh)).seq;
  const [members, events, lists, tasks] = await Promise.all([
    all(db, 'SELECT * FROM members WHERE household_id = ? AND seq > ?', hh, since),
    all(db, 'SELECT * FROM events WHERE household_id = ? AND seq > ?', hh, since),
    all(db, 'SELECT * FROM lists WHERE household_id = ? AND seq > ?', hh, since),
    all(db, 'SELECT * FROM tasks WHERE household_id = ? AND seq > ?', hh, since),
  ]);
  return json({
    seq,
    full: since === 0,
    household: { id: hh, name: ctx.household.name, timezone: ctx.household.timezone },
    members: members.map(memberOut),
    events: events.map((r) => (visible(r, ctx) ? eventOut(r) : { id: r.id, deleted: true, seq: r.seq })),
    lists: lists.map(listOut),
    tasks: tasks.map(taskOut),
  });
}

// ---------- ICS subscription feed (read-only, shared events) ----------
function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsFold(line) {
  const out = [];
  let s = line;
  while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); }
  out.push(s);
  return out.join('\r\n');
}
const icsUtc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsLocal = (s) => s.replace(/[-:]/g, '') + (s.length > 10 ? '00' : '');

export async function icsFeed(req, env, ctx, { token }) {
  const db = env.DB;
  const hh = await one(db, 'SELECT * FROM households WHERE ics_token = ?', token.replace(/\.ics$/, ''));
  if (!hh) return new Response('Not found', { status: 404 });
  const members = Object.fromEntries((await all(db, 'SELECT id, name FROM members WHERE household_id = ?', hh.id)).map((m) => [m.id, m.name]));
  const rows = await all(db, "SELECT * FROM events WHERE household_id = ? AND deleted_at IS NULL AND visibility = 'shared' AND source_id IS NULL AND (series_end_utc IS NULL OR series_end_utc > ?)", hh.id, now() - 180 * 86400000);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Family Flow//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEscape(hh.name)} (Family Flow)`, `X-WR-TIMEZONE:${hh.timezone}`];
  for (const r of rows) {
    const who = parseJsonCol(r.assignees, []).map((a) => members[a]).filter(Boolean);
    lines.push('BEGIN:VEVENT', `UID:${r.id}@familyflow`, `DTSTAMP:${icsUtc(r.updated_at)}`);
    if (r.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${icsLocal(r.start_local)}`, `DTEND;VALUE=DATE:${icsLocal(r.end_local)}`);
    } else {
      lines.push(`DTSTART;TZID=${r.tz}:${icsLocal(r.start_local)}`, `DTEND;TZID=${r.tz}:${icsLocal(r.end_local)}`);
    }
    if (r.rrule) {
      const rule = r.rrule.replace(/UNTIL=(\d{4})-(\d{2})-(\d{2})/, 'UNTIL=$1$2$3T235959Z');
      lines.push(`RRULE:${rule}`);
      for (const x of parseJsonCol(r.exdates, [])) {
        lines.push(r.all_day ? `EXDATE;VALUE=DATE:${icsLocal(x)}` : `EXDATE;TZID=${r.tz}:${icsLocal(x)}`);
      }
    }
    lines.push(`SUMMARY:${icsEscape(who.length ? `${r.title} (${who.join(', ')})` : r.title)}`);
    if (r.location_name || r.location_address) lines.push(`LOCATION:${icsEscape([r.location_name, r.location_address].filter(Boolean).join(', '))}`);
    if (r.notes) lines.push(`DESCRIPTION:${icsEscape(r.notes)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.map(icsFold).join('\r\n') + '\r\n', {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=300' },
  });
}

export async function icsInfo(req, env, ctx) {
  requireRole(ctx, ['owner', 'adult']);
  const hh = await one(env.DB, 'SELECT ics_token FROM households WHERE id = ?', ctx.household.id);
  const origin = new URL(req.url).origin;
  return json({ url: `${origin}/cal/${hh.ics_token}.ics`, webcal: `${origin.replace(/^https?/, 'webcal')}/cal/${hh.ics_token}.ics` });
}

export async function rotateIcs(req, env, ctx) {
  requireRole(ctx, ['owner']);
  const { randomToken } = await import('../lib/util.js');
  await run(env.DB, 'UPDATE households SET ics_token = ? WHERE id = ?', randomToken(24), ctx.household.id);
  return icsInfo(req, env, ctx);
}
