// The Family Flow assistant: Claude with tool calling. The model never writes to the database
// directly; it creates *proposals* that the user confirms. Confirmed proposals go through the same
// validated code paths as the regular editors.
import { HttpError, json, readJson, validate, v, uid, now, parseJsonCol, b64url } from '../lib/util.js';
import { one, all, run, useQuota, rateLimit, audit } from '../lib/db.js';
import { requireRole } from '../lib/auth.js';
import { todayLocal, buildRrule, utcToLocal, localToUtc } from '../lib/time.js';
import { eventSchema, taskSchema, normalizeEvent, createEventCore, createTaskCore, listOccurrences } from './calendar.js';
import { searchPlaces } from './places.js';

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const FALLBACK_MODELS = ['claude-sonnet-4-5', 'claude-3-5-haiku-latest'];
const MAX_ROUNDS = 5;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TOOLS = [
  {
    name: 'propose_event',
    description: 'Propose ONE calendar event for the family. The user must confirm before it is saved. Only call this when you know the date AND (a start time OR that it is all-day). Never guess a time.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, e.g. "Soccer practice" or "Ava\'s birthday party"' },
        all_day: { type: 'boolean' },
        start: { type: 'string', description: 'Local start: YYYY-MM-DDTHH:MM, or YYYY-MM-DD if all_day' },
        end: { type: 'string', description: 'Optional local end in the same format. All-day end is the day AFTER the last day.' },
        location_query: { type: 'string', description: 'Place the user mentioned, as they said it (e.g. "the field in Old Lyme"). Omit if none.' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'Family member names this event is for' },
        reminders_minutes: { type: 'array', items: { type: 'integer' }, description: 'Minutes before start to remind, e.g. [60]' },
        recurrence: {
          type: 'object',
          description: 'Only if the user said it repeats',
          properties: {
            freq: { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] },
            interval: { type: 'integer' },
            weekdays: { type: 'array', items: { type: 'string', enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] } },
            until: { type: 'string', description: 'YYYY-MM-DD' },
            count: { type: 'integer' },
          },
          required: ['freq'],
        },
        private: { type: 'boolean', description: 'true only if the user asked to keep it private' },
        notes: { type: 'string' },
        assumptions: { type: 'array', items: { type: 'string' }, description: 'Anything you inferred rather than were told, e.g. "Assumed 2 hours long"' },
      },
      required: ['title', 'all_day', 'start'],
    },
  },
  {
    name: 'propose_task',
    description: 'Propose ONE to-do or shopping item. The user must confirm before it is saved.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        list: { type: 'string', description: 'Name of an existing list (e.g. "To-do", "Groceries")' },
        due: { type: 'string', description: 'YYYY-MM-DD or YYYY-MM-DDTHH:MM, optional' },
        assignee: { type: 'string', description: 'Family member name, optional' },
        remind: { type: 'boolean', description: 'Send a reminder when due' },
        repeat: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
        notes: { type: 'string' },
        assumptions: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'find_events',
    description: 'Look up what is already on the family calendar between two dates (inclusive). Use it to answer questions and to spot clashes.',
    input_schema: {
      type: 'object',
      properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['from', 'to'],
    },
  },
];

function systemPrompt(ctx, members, lists, upcoming) {
  const tz = ctx.household.timezone;
  const today = todayLocal(tz);
  const [y, m, d] = today.split('-').map(Number);
  const wd = DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const time = utcToLocal(Date.now(), tz).slice(11);
  const me = members.find((x) => x.id === ctx.memberId);
  return `You are Family Flow, a warm, efficient assistant that helps a family organise their life.

Today is ${wd} ${today}, the time is ${time}, household time zone ${tz}.
The person talking to you is ${ctx.user.name}${me ? ` (family profile "${me.name}")` : ''}.
Family members: ${members.map((x) => `${x.name}${x.kind === 'child' ? ' (child)' : ''}`).join(', ')}.
Lists: ${lists.map((l) => `${l.name} (${l.kind})`).join(', ')}.
Upcoming in the next 7 days: ${upcoming.length ? upcoming.map((o) => `${o.occurrence.start_local} ${o.title}`).join('; ') : 'nothing scheduled'}.

How to work:
- Turn what the user tells you into proposals using propose_event and propose_task. One message can produce several (e.g. a party event plus a "buy a present" task assigned to someone).
- Resolve relative dates ("next Saturday", "tomorrow") yourself using today's date. "Next <weekday>" means the coming one unless today is that weekday, then it means a week later.
- For a timed event you MUST know the start time. If the user did not give one (e.g. "tomorrow morning"), ask a short question instead of guessing. Ask ONE question at a time.
- If the user mentions a place, pass it in location_query exactly as they said it. Never invent an address.
- Do not invent end times silently: if you choose a duration, record it in assumptions.
- Only add reminders the user asked for, or a sensible single reminder for appointments/parties (60 minutes) noted in assumptions. Tasks with a due date for an errand should have remind=true.
- Use exact family member names from the list. If a name is unknown, ask who they mean.
- Do not create tasks the user did not ask for or clearly imply.
- Nothing is saved until the user taps Confirm. Never say something "is saved" or "has been added". Instead say what you've prepared for them to confirm, in one or two short sentences.
- Keep replies brief and friendly; you may be read aloud.`;
}

async function callClaude(env, body) {
  const f = env.__fetch || fetch;
  const models = [env.ANTHROPIC_MODEL || DEFAULT_MODEL, ...FALLBACK_MODELS];
  let lastErr = null;
  for (const model of models) {
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ ...body, model }),
      signal: AbortSignal.timeout(45000),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    lastErr = `HTTP ${res.status}: ${text.slice(0, 300)}`;
    if (res.status === 404 || (res.status === 400 && /model/i.test(text))) continue; // try next model
    break;
  }
  console.error('Claude call failed', lastErr);
  throw new HttpError(502, 'ai_unavailable', 'The assistant is unavailable right now. You can still add things with the + button.', { detail: lastErr });
}

// Map names ("dad", "kiddo 1") to member ids.
function resolveMembers(names, members) {
  const ids = [];
  const unknown = [];
  for (const n of names || []) {
    const k = String(n).trim().toLowerCase();
    const m = members.find((x) => x.name.toLowerCase() === k) || members.find((x) => x.name.toLowerCase().replace(/\s+/g, '') === k.replace(/\s+/g, ''));
    if (m) ids.push(m.id); else unknown.push(n);
  }
  return { ids, unknown };
}

async function handleTool(env, ctx, conversationId, call, members, lists, created) {
  const db = env.DB;
  const input = call.input || {};
  if (call.name === 'find_events') {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(input.from) ? input.from : todayLocal(ctx.household.timezone);
    let to = /^\d{4}-\d{2}-\d{2}$/.test(input.to) ? input.to : from;
    const toExcl = utcToLocal(localToUtc(to, 'UTC') + 86400000, 'UTC', false);
    const occ = await listOccurrences(db, ctx, from, toExcl);
    const names = Object.fromEntries(members.map((m) => [m.id, m.name]));
    return { content: JSON.stringify(occ.slice(0, 40).map((o) => ({
      title: o.title, start: o.occurrence.start_local, end: o.occurrence.end_local, allDay: o.allDay,
      who: o.assignees.map((a) => names[a]).filter(Boolean), location: o.location ? o.location.name || o.location.address : undefined,
    }))) };
  }
  if (call.name === 'propose_event') {
    const notes = [...(Array.isArray(input.assumptions) ? input.assumptions : [])].map(String).slice(0, 8);
    const { ids, unknown } = resolveMembers(input.assignees, members);
    if (unknown.length) return { error: `Unknown family member(s): ${unknown.join(', ')}. Members are: ${members.map((m) => m.name).join(', ')}. Ask the user who they mean.` };
    let location = null;
    if (input.location_query) {
      try {
        const r = await searchPlaces(env, ctx, String(input.location_query).slice(0, 120), null, env.__fetch || fetch);
        const best = r.results[0];
        if (best) {
          location = { name: best.name || '', address: best.address, lat: best.lat ?? undefined, lon: best.lon ?? undefined };
          notes.push(best.source === 'saved' ? `Used your saved place "${best.name || best.address}"` : `Looked up "${input.location_query}" → ${best.address}. Please check it's right.`);
        } else {
          location = { name: String(input.location_query).slice(0, 200), address: '' };
          notes.push(`Couldn't find an address for "${input.location_query}"; saved the name only.`);
        }
      } catch {
        location = { name: String(input.location_query).slice(0, 200), address: '' };
        notes.push('Address search is unavailable; saved the place name only.');
      }
    }
    let rrule = null;
    if (input.recurrence && input.recurrence.freq) {
      try {
        rrule = buildRrule({
          freq: input.recurrence.freq, interval: input.recurrence.interval || 1,
          byday: (input.recurrence.weekdays || []).map((d) => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(d)).filter((x) => x >= 0),
          until: input.recurrence.until || null, count: input.recurrence.count || null,
        });
      } catch (e) { return { error: `Bad recurrence: ${e.message}` }; }
    }
    const candidate = {
      title: input.title, notes: input.notes || '', location, allDay: !!input.all_day, start: input.start, end: input.end || undefined,
      rrule, assignees: ids, visibility: input.private ? 'private' : 'shared',
      reminders: (input.reminders_minutes || []).filter((x) => Number.isInteger(x) && x >= 0 && x <= 40320).slice(0, 5),
    };
    let payload;
    try {
      payload = validate(eventSchema, candidate);
      await normalizeEvent(db, ctx, payload); // dry run: dates, end > start, etc.
    } catch (e) {
      return { error: `Could not prepare that event: ${e.message}. Fix it or ask the user.` };
    }
    const id = uid('pr_');
    await run(db, 'INSERT INTO proposals (id, household_id, conversation_id, user_id, kind, payload, notes, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, ctx.household.id, conversationId, ctx.user.id, 'event', JSON.stringify(payload), JSON.stringify(notes), 'pending', now());
    created.push({ id, kind: 'event', payload, notes, status: 'pending' });
    return { content: `Prepared event proposal ${id} for the user to confirm.${notes.length ? ' Notes: ' + notes.join(' ') : ''}` };
  }
  if (call.name === 'propose_task') {
    const notes = [...(Array.isArray(input.assumptions) ? input.assumptions : [])].map(String).slice(0, 8);
    let assignee = null;
    if (input.assignee) {
      const { ids, unknown } = resolveMembers([input.assignee], members);
      if (unknown.length) return { error: `Unknown family member: ${input.assignee}. Members are: ${members.map((m) => m.name).join(', ')}.` };
      assignee = ids[0];
    }
    const wanted = (input.list || '').toLowerCase();
    let list = lists.find((l) => l.name.toLowerCase() === wanted);
    if (!list) {
      const looksShopping = /buy|pick up|get |grocer|milk|bread|eggs|present|gift/i.test(input.title);
      list = lists.find((l) => l.kind === (looksShopping && /grocer|milk|bread|eggs/i.test(input.title) ? 'shopping' : 'todo')) || lists[0];
      if (input.list) notes.push(`No list called "${input.list}", used "${list.name}"`);
    }
    const candidate = {
      listId: list.id, title: input.title, notes: input.notes || '', due: input.due || null, assignee,
      repeat: input.repeat || null, remind: !!input.remind && !!input.due, eventId: null,
    };
    let payload;
    try {
      payload = validate(taskSchema, candidate);
      if (payload.due && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(payload.due)) throw new Error('due must be YYYY-MM-DD or YYYY-MM-DDTHH:MM');
    } catch (e) {
      return { error: `Could not prepare that task: ${e.message}` };
    }
    const id = uid('pr_');
    await run(db, 'INSERT INTO proposals (id, household_id, conversation_id, user_id, kind, payload, notes, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, ctx.household.id, conversationId, ctx.user.id, 'task', JSON.stringify(payload), JSON.stringify(notes), 'pending', now());
    created.push({ id, kind: 'task', payload, notes, status: 'pending' });
    return { content: `Prepared task proposal ${id} for the user to confirm.` };
  }
  return { error: `Unknown tool ${call.name}` };
}

// Keep the stored history small but never split a tool_use from its tool_result.
function trimHistory(msgs, max = 24) {
  let start = Math.max(0, msgs.length - max);
  while (start < msgs.length) {
    const m = msgs[start];
    const isPlainUser = m.role === 'user' && (typeof m.content === 'string' || !m.content.some((b) => b.type === 'tool_result'));
    if (isPlainUser) break;
    start++;
  }
  return msgs.slice(start);
}

export async function chat(req, env, ctx) {
  requireRole(ctx, ['owner', 'adult', 'child']);
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'ai_not_configured', 'The assistant is not set up yet (missing ANTHROPIC_API_KEY). You can still add things with the + button.');
  const body = validate(v.object({
    text: v.string({ min: 1, max: 4000 }),
    conversationId: v.string({ max: 60 }).optional(),
  }), await readJson(req));
  const db = env.DB;
  await rateLimit(db, `ai:${ctx.user.id}`, 20, 60);
  await useQuota(db, ctx.household.id, 'assistant', env);

  let conv = body.conversationId ? await one(db, 'SELECT * FROM conversations WHERE id = ? AND household_id = ? AND user_id = ?', body.conversationId, ctx.household.id, ctx.user.id) : null;
  if (!conv) {
    const id = uid('c_');
    await run(db, 'INSERT INTO conversations (id, household_id, user_id, created_at, updated_at) VALUES (?,?,?,?,?)', id, ctx.household.id, ctx.user.id, now(), now());
    conv = { id };
  }
  const history = (await all(db, 'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', conv.id))
    .map((m) => ({ role: m.role, content: parseJsonCol(m.content, m.content) }));
  const members = await all(db, 'SELECT id, name, kind FROM members WHERE household_id = ? AND deleted_at IS NULL ORDER BY sort', ctx.household.id);
  const lists = await all(db, 'SELECT id, name, kind FROM lists WHERE household_id = ? AND deleted_at IS NULL ORDER BY sort', ctx.household.id);
  const today = todayLocal(ctx.household.timezone);
  const upcoming = (await listOccurrences(db, ctx, today, utcToLocal(localToUtc(today, 'UTC') + 7 * 86400000, 'UTC', false))).slice(0, 25);

  const newMsgs = [{ role: 'user', content: [{ type: 'text', text: body.text }] }];
  const created = [];
  let reply = '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await callClaude(env, {
      max_tokens: 1024,
      system: systemPrompt(ctx, members, lists, upcoming),
      tools: TOOLS,
      messages: trimHistory([...history, ...newMsgs]),
    });
    newMsgs.push({ role: 'assistant', content: res.content });
    const calls = res.content.filter((b) => b.type === 'tool_use');
    reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (res.stop_reason !== 'tool_use' || !calls.length) break;
    const results = [];
    for (const c of calls) {
      const r = await handleTool(env, ctx, conv.id, c, members, lists, created);
      results.push({ type: 'tool_result', tool_use_id: c.id, content: r.error || r.content, ...(r.error ? { is_error: true } : {}) });
    }
    newMsgs.push({ role: 'user', content: results });
  }
  if (!reply) reply = created.length ? 'Here’s what I’ve prepared. Tap Confirm to save it.' : 'Sorry, I didn’t catch that. Could you say it another way?';

  let t = now();
  for (const m of newMsgs) {
    await run(db, 'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)', uid('msg_'), conv.id, m.role, JSON.stringify(m.content), t++);
  }
  await run(db, 'UPDATE conversations SET updated_at = ? WHERE id = ?', now(), conv.id);
  return json({ conversationId: conv.id, reply, proposals: created });
}

export async function listProposals(req, env, ctx) {
  const rows = await all(env.DB, "SELECT * FROM proposals WHERE household_id = ? AND user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 30", ctx.household.id, ctx.user.id);
  return json({ proposals: rows.map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload), notes: JSON.parse(r.notes), status: r.status, createdAt: r.created_at })) });
}

export async function acceptProposal(req, env, ctx, { id }) {
  const db = env.DB;
  const p = await one(db, 'SELECT * FROM proposals WHERE id = ? AND household_id = ?', id, ctx.household.id);
  if (!p) throw new HttpError(404, 'not_found', 'That suggestion no longer exists.');
  if (p.status !== 'pending') throw new HttpError(409, 'already_decided', p.status === 'accepted' ? 'Already saved.' : 'This suggestion was dismissed.');
  const body = await readJson(req);
  const edited = body && body.payload ? body.payload : JSON.parse(p.payload);
  let result;
  if (p.kind === 'event') {
    const input = validate(eventSchema, edited);
    result = await createEventCore(db, ctx, input);
  } else {
    const input = validate(taskSchema, edited);
    if (input.eventId === undefined) input.eventId = null;
    result = await createTaskCore(db, ctx, input);
  }
  const resultId = (result.event || result.task).id;
  const upd = await run(db, "UPDATE proposals SET status = 'accepted', result_id = ?, decided_at = ? WHERE id = ? AND status = 'pending'", resultId, now(), id);
  if (p.conversation_id) {
    const what = p.kind === 'event' ? `event "${(result.event).title}" on ${(result.event).start}` : `task "${result.task.title}"`;
    await run(db, 'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)', uid('msg_'), p.conversation_id, 'user',
      JSON.stringify([{ type: 'text', text: `[System note: the user confirmed and saved the ${what}.]` }]), now());
    // A user message must be followed by an assistant message before the next user turn.
    await run(db, 'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)', uid('msg_'), p.conversation_id, 'assistant',
      JSON.stringify([{ type: 'text', text: 'Noted.' }]), now() + 1);
  }
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'proposal.accept', refType: p.kind, refId: resultId });
  return json({ ok: true, ...result });
}

export async function dismissProposal(req, env, ctx, { id }) {
  const r = await one(env.DB, 'SELECT * FROM proposals WHERE id = ? AND household_id = ?', id, ctx.household.id);
  if (!r) throw new HttpError(404, 'not_found', 'That suggestion no longer exists.');
  await run(env.DB, "UPDATE proposals SET status = 'dismissed', decided_at = ? WHERE id = ? AND status = 'pending'", now(), id);
  return json({ ok: true });
}

// ---------- voice ----------
export async function transcribe(req, env, ctx) {
  if (!env.AI) throw new HttpError(503, 'voice_not_configured', 'Voice transcription is not available. You can type instead.');
  const db = env.DB;
  await rateLimit(db, `stt:${ctx.user.id}`, 20, 60);
  await useQuota(db, ctx.household.id, 'transcribe', env);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) throw new HttpError(422, 'empty', 'No audio was received. Please try again.');
  if (buf.length > 8 * 1024 * 1024) throw new HttpError(413, 'too_large', 'Recording is too long. Keep it under a minute.');
  let text = '';
  try {
    let b64 = '';
    const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) b64 += String.fromCharCode(...buf.subarray(i, i + CH));
    const r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: btoa(b64), language: 'en' });
    text = (r && r.text) || '';
  } catch (e) {
    try {
      const r = await env.AI.run('@cf/openai/whisper', { audio: [...buf] });
      text = (r && r.text) || '';
    } catch (e2) {
      console.error('transcription failed', e, e2);
      throw new HttpError(502, 'stt_failed', 'Sorry, I could not understand the recording. Please try again or type it.');
    }
  }
  return json({ text: text.trim() });
}
