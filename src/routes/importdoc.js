// Import calendar entries from a PDF or a photo (school calendar, sports schedule, camp flyer…).
// Step 1 (/api/import/document): Claude reads the file and returns the dated entries — nothing is saved.
// Step 2 (/api/events/bulk): the person reviews the list and adds the ones they want in one go.
import { HttpError, json, readJson, validate, v, DATE_RE } from '../lib/util.js';
import { all, one, rateLimit, useQuota, audit } from '../lib/db.js';
import { requireRole } from '../lib/auth.js';
import { todayLocal, addDays, fmtLocal, parseLocal } from '../lib/time.js';
import { callClaude, resolveMembers } from './assistant.js';
import { createEventCore, eventSchema } from './calendar.js';
import { audienceUserIds } from '../lib/audience.js';
import { notifyActivity, actorName } from '../lib/activity.js';

const MAX_BYTES = 10 * 1024 * 1024;
const KINDS = { 'application/pdf': 'document', 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image' };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const nextDay = (d) => { const p = parseLocal(d); return fmtLocal(addDays(p.y, p.m, p.d, 1), false); };

const TOOL = {
  name: 'extract_events',
  description: 'Return every calendar entry found in the document.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One short sentence describing the document, e.g. "Lincoln Elementary 2026–27 school calendar".' },
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short, clear title, e.g. "No school – Teacher workday", "Soccer vs. Essex"' },
            date: { type: 'string', description: 'Start date YYYY-MM-DD' },
            end_date: { type: 'string', description: 'Last day (inclusive) YYYY-MM-DD, only for multi-day entries like a break' },
            start_time: { type: 'string', description: '24h HH:MM if a time is given' },
            end_time: { type: 'string', description: '24h HH:MM if given' },
            location: { type: 'string', description: 'Place name as written, if any' },
            notes: { type: 'string', description: 'Useful details from the document (what to bring, early dismissal time…), short' },
            who: { type: 'array', items: { type: 'string' }, description: 'Family member names/labels this is clearly for, only if the document names them' },
          },
          required: ['title', 'date'],
        },
      },
    },
    required: ['summary', 'events'],
  },
};

export async function extractFromDocument(req, env, ctx) {
  requireRole(ctx, ['owner', 'adult']);
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'ai_unavailable', 'Reading documents needs the assistant, which isn’t switched on for this app yet.');
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const kind = KINDS[type];
  if (!kind) throw new HttpError(415, 'unsupported', 'Upload a PDF, or a photo (JPEG or PNG) of the schedule.');
  if (Number(req.headers.get('content-length') || 0) > MAX_BYTES) throw new HttpError(413, 'too_large', 'That file is bigger than 10 MB. Try a smaller PDF or a photo of the page.');
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new HttpError(413, 'too_large', 'That file is bigger than 10 MB. Try a smaller PDF or a photo of the page.');
  if (bytes.length < 50) throw new HttpError(422, 'invalid', 'That file looks empty.');
  const db = env.DB;
  await rateLimit(db, `import:${ctx.user.id}`, 10, 3600);
  await useQuota(db, ctx.household.id, 'import', env);
  let fileName = '';
  try { fileName = decodeURIComponent(req.headers.get('x-file-name') || '').slice(0, 120); } catch { /* ignore */ }

  const tz = ctx.household.timezone;
  const today = todayLocal(tz);
  const members = await all(db, 'SELECT id, name, label, kind FROM members WHERE household_id = ? AND deleted_at IS NULL ORDER BY sort', ctx.household.id);
  const system = `You extract calendar entries from documents for a family calendar app.
Today is ${today}; the family's time zone is ${tz}. Family members: ${members.map((m) => (m.label ? `${m.label} (${m.name})` : m.name)).join(', ') || 'unknown'}.
Rules:
- Include every dated entry: events, games, practices, holidays, no-school days, early dismissals, breaks, deadlines, sign-up dates.
- Resolve the year from the document (e.g. a 2026–27 school year runs Aug 2026 to Jun 2027). If no year is given, use the next occurrence on or after today.
- Use 24-hour times. Leave times out for all-day entries. For multi-day entries (e.g. Winter break Dec 21–Jan 1) give date and end_date.
- Keep titles short and clear; put extra details in notes. Don't invent anything that isn't in the document.
- Only fill "who" when the document clearly names a family member.
Always answer by calling the extract_events tool exactly once (with an empty events list if there are no dates).`;
  const block = kind === 'document'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(bytes) } }
    : { type: 'image', source: { type: 'base64', media_type: type, data: toBase64(bytes) } };
  const out = await callClaude(env, {
    max_tokens: 8000, system, tools: [TOOL],
    messages: [{ role: 'user', content: [block, { type: 'text', text: `Extract all calendar entries from ${fileName ? `“${fileName}”` : 'this file'} and return them with the extract_events tool.` }] }],
  }, { timeoutMs: 110000 });
  const call = (out.content || []).find((b) => b.type === 'tool_use' && b.name === 'extract_events');
  const raw = (call && call.input && Array.isArray(call.input.events)) ? call.input.events : [];

  // Normalise, drop anything malformed, de-duplicate, and flag entries already on the calendar.
  const existing = new Set((await all(db, 'SELECT title, start_local FROM events WHERE household_id = ? AND deleted_at IS NULL', ctx.household.id))
    .map((e) => `${e.title.trim().toLowerCase()}|${e.start_local}`));
  const seen = new Set();
  const events = [];
  for (const e of raw.slice(0, 300)) {
    const title = String(e.title || '').trim().slice(0, 200);
    if (!title || !DATE_RE.test(e.date || '')) continue;
    const st = TIME_RE.test(e.start_time || '') ? e.start_time : null;
    let et = TIME_RE.test(e.end_time || '') ? e.end_time : null;
    const lastDay = DATE_RE.test(e.end_date || '') && e.end_date >= e.date ? e.end_date : e.date;
    let start; let end; let allDay;
    if (st) {
      allDay = false;
      start = `${e.date}T${st}`;
      end = et ? `${lastDay}T${et}` : null;
      if (end && end <= start) end = null;
    } else {
      allDay = true;
      start = e.date;
      end = nextDay(lastDay);
    }
    const key = `${title.toLowerCase()}|${start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { ids } = resolveMembers(Array.isArray(e.who) ? e.who : [], members);
    events.push({
      title, start, end, allDay,
      location: e.location ? { name: String(e.location).slice(0, 200), address: '' } : null,
      notes: String(e.notes || '').slice(0, 1000),
      assignees: ids,
      exists: existing.has(key),
    });
    if (events.length >= 200) break;
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'import.document', detail: { fileName, kind, found: events.length } });
  return json({ summary: String((call && call.input && call.input.summary) || '').slice(0, 300), fileName, events });
}

// Adds many reviewed events at once; one family alert instead of one per event.
export async function bulkCreateEvents(req, env, ctx) {
  requireRole(ctx, ['owner', 'adult']);
  const raw = await readJson(req, 2_000_000);
  if (!raw || !Array.isArray(raw.events)) throw new HttpError(422, 'invalid', 'events must be a list', { field: 'events' });
  if (raw.events.length > 200) throw new HttpError(422, 'invalid', 'You can add up to 200 events at once.', { field: 'events' });
  const body = { events: raw.events, source: validate(v.object({ source: v.string({ max: 120 }).optional() }), { source: raw.source }).source };
  const db = env.DB;
  const created = [];
  const failed = [];
  for (let i = 0; i < body.events.length; i++) {
    try {
      const input = validate(eventSchema, body.events[i]);
      created.push((await createEventCore(db, ctx, input, { notify: false })).event);
    } catch (e) { failed.push({ index: i, title: (body.events[i] || {}).title, error: e.message || String(e) }); }
  }
  const shared = created.filter((e) => e.visibility !== 'private');
  if (shared.length) {
    const groups = [...new Set(shared.map((e) => e.groupId || null))];
    const userIds = groups.length === 1 ? await audienceUserIds(db, ctx.household.id, { groupId: groups[0], ownerUserId: ctx.user.id }) : await audienceUserIds(db, ctx.household.id, {});
    const who = await actorName(db, ctx);
    await notifyActivity(ctx, {
      userIds, title: `${who} added ${shared.length} event${shared.length > 1 ? 's' : ''}${body.source ? ` from “${body.source}”` : ''}`,
      body: shared.slice(0, 3).map((e) => e.title).join(' · ') + (shared.length > 3 ? ' …' : ''), refType: 'event', refId: shared[0].id,
    });
  }
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'event.bulk_create', detail: { created: created.length, failed: failed.length, source: body.source } });
  return json({ created, failed }, 201);
}
