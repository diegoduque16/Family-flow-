// Main screens: Today, Calendar, Inbox, Assistant.
import { h, icon, toast, fmtDay, fmtDayShort, fmtMonth, fmtTime, fmtRange, fmtWeekday, relDay, addDaysStr, sheet } from './ui.js';
import { api, state, occurrences, todayStr, nowLocal, membersList, member, listsList, refreshCounts, emit, sync } from './store.js';
import { openEventDetail, openEventEditor, openTaskEditor, toggleTask, taskDueLabel, errorText, describeRrule } from './editors.js';
import { utcToLocal } from './time.js';

const pref = {
  get(k, d) { try { const v = localStorage.getItem(`ff:${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ff:${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

function whoDots(ids) {
  const ms = (ids || []).map(member).filter(Boolean);
  if (!ms.length) return null;
  return h('span', { class: 'who' }, ms.map((m) => h('span', { class: 'dot', '--c': m.color, title: m.name })), h('span', null, ms.map((m) => m.name).join(', ')));
}
function barColors(ids) {
  const ms = (ids || []).map(member).filter(Boolean);
  return { '--c1': ms[0] ? ms[0].color : 'var(--ink-3)', '--c2': ms[1] ? ms[1].color : undefined };
}

export function evItem(o, { past = false } = {}) {
  const ev = o.ev;
  return h('button', { type: 'button', class: `ev${past ? ' past' : ''}${ev._pending ? ' pending' : ''}`, onclick: () => openEventDetail(ev, o) },
    h('span', { class: 'bar', ...barColors(ev.assignees) }),
    h('span', { class: 'when' }, ev.allDay ? 'All day' : [fmtTime(o.start), h('div', { class: 'end' }, fmtTime(o.end))]),
    h('span', { class: 'what' },
      h('div', { class: 'title' }, ev.title),
      h('div', { class: 'meta' },
        whoDots(ev.assignees),
        ev.location ? h('span', { class: 'row', style: { gap: '3px' } }, ev.location.name || ev.location.address.split(',')[0]) : null,
        ev.rrule ? h('span', { title: describeRrule(ev.rrule), 'aria-label': 'Repeats' }, '↻') : null,
        ev.visibility === 'private' ? h('span', { 'aria-label': 'Private' }, '🔒') : null,
        ev.readOnly ? h('span', { class: 'faint' }, (state.sources.get(ev.sourceId) || {}).name || 'Imported') : null)));
}

export function taskRow(t, { showList = false } = {}) {
  const asg = t.assignee && member(t.assignee);
  const list = showList && state.lists.get(t.listId);
  return h('li', { class: `task${t.done ? ' done' : ''}` },
    h('button', { type: 'button', class: 'check', role: 'checkbox', 'aria-checked': String(!!t.done), 'aria-label': `Mark “${t.title}” ${t.done ? 'not done' : 'done'}`, onclick: () => toggleTask(t) }, t.done ? icon('check') : null),
    h('button', { type: 'button', class: 'body', onclick: () => openTaskEditor({ task: t }) },
      h('div', { class: 'title' }, t.title),
      h('div', { class: 'meta row', style: { gap: '8px', flexWrap: 'wrap' } },
        taskDueLabel(t), asg ? h('span', { class: 'who' }, h('span', { class: 'dot', '--c': asg.color }), asg.name) : null,
        t.repeat ? h('span', null, `↻ ${t.repeat}`) : null, list ? h('span', { class: 'faint' }, list.name) : null,
        t._pending ? h('span', { style: { color: 'var(--warn)' } }, 'Waiting to sync') : null)));
}

function statusBanner() {
  const parts = [];
  if (!state.online) parts.push(h('div', { class: 'banner warn' }, icon('wifi'), h('span', null, `Offline — showing what’s saved on this device${state.lastSyncAt ? ` (updated ${timeAgo(state.lastSyncAt)})` : ''}.${state.outbox.length ? ` ${state.outbox.length} change(s) will sync when you reconnect.` : ''}`)));
  else if (state.outbox.length) parts.push(h('div', { class: 'banner info' }, icon('sync'), `Syncing ${state.outbox.length} change(s)…`));
  if (state.syncError && state.online) parts.push(h('div', { class: 'banner bad' }, `Couldn’t sync: ${state.syncError}`, h('button', { class: 'btn sm', type: 'button', onclick: () => sync() }, 'Retry')));
  return parts;
}
function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// ---------- Today ----------
export function TodayView() {
  const today = todayStr();
  const nowL = nowLocal();
  const nowMs = Date.now();
  const occToday = occurrences(today, addDaysStr(today, 1));
  const occTomorrow = occurrences(addDaysStr(today, 1), addDaysStr(today, 2));
  const next = occurrences(today, addDaysStr(today, 14)).find((o) => !o.ev.allDay && o.endUtc > nowMs);
  const tasks = [...state.tasks.values()].filter((t) => !t.done && t.due && t.due.slice(0, 10) <= today).sort((a, b) => a.due.localeCompare(b.due));
  const undated = [...state.tasks.values()].filter((t) => !t.done && !t.due && (state.lists.get(t.listId) || {}).kind === 'todo').slice(0, 5);
  const hour = Number(nowL.slice(11, 13));
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const nm = state.me.user.name.split(' ')[0];

  return h('div', { class: 'page' },
    statusBanner(),
    h('p', { class: 'muted', style: { margin: '6px 0 0', fontWeight: 600 } }, fmtDay(today)),
    h('h2', { class: 'hello' }, `${greet}, ${nm}`),
    state.proposalsCount ? h('a', { class: 'banner info', href: '#/inbox', style: { textDecoration: 'none' } }, icon('assistant'), `${state.proposalsCount} suggestion${state.proposalsCount > 1 ? 's' : ''} from the assistant waiting for you to confirm`) : null,
    next ? h('button', { type: 'button', class: 'next-up', onclick: () => openEventDetail(next.ev, next) },
      h('div', { class: 'k' }, next.startUtc <= nowMs ? 'Happening now' : next.start.slice(0, 10) === today ? `Next · in ${untilText(next.startUtc - nowMs)}` : `Next · ${relDay(next.start, today) || fmtDayShort(next.start)}`),
      h('div', { class: 't' }, next.ev.title),
      h('div', { class: 'm' }, fmtRange(next, false), next.ev.location ? ` · ${next.ev.location.name || next.ev.location.address}` : '', (next.ev.assignees || []).length ? ` · ${next.ev.assignees.map((a) => (member(a) || {}).name).filter(Boolean).join(', ')}` : '')) : null,
    h('section', { class: 'card' },
      h('h2', null, 'Today', h('span', { class: 'spacer' }), h('a', { class: 'btn ghost sm', href: '#/calendar' }, 'Calendar')),
      occToday.length ? occToday.map((o) => evItem(o, { past: !o.ev.allDay && o.endUtc < nowMs })) :
        h('div', { class: 'empty' }, h('div', { class: 'big' }, 'Nothing scheduled today'), h('button', { class: 'btn sm', type: 'button', onclick: () => openEventEditor({ date: today }) }, 'Add an event'))),
    h('section', { class: 'card' },
      h('h2', null, 'To do', h('span', { class: 'spacer' }), h('a', { class: 'btn ghost sm', href: '#/more/tasks' }, 'All lists')),
      tasks.length || undated.length ? h('ul', { class: 'list' }, tasks.map((t) => taskRow(t, { showList: true })), undated.map((t) => taskRow(t, { showList: true }))) :
        h('div', { class: 'empty' }, h('div', { class: 'big' }, 'All clear'), h('button', { class: 'btn sm', type: 'button', onclick: () => openTaskEditor({}) }, 'Add a task'))),
    occTomorrow.length ? h('section', { class: 'card' }, h('h2', null, `Tomorrow · ${fmtDayShort(addDaysStr(today, 1))}`), occTomorrow.map((o) => evItem(o))) : null);
}
function untilText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60); const mm = m % 60;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}

// ---------- Calendar ----------
const cal = { mode: pref.get('calMode', 'month'), cursor: null, selected: null, filter: new Set(pref.get('calFilter', [])) };

export function CalendarView(rerender) {
  const today = todayStr();
  if (!cal.cursor) cal.cursor = today;
  if (!cal.selected) cal.selected = today;
  for (const id of [...cal.filter]) if (id !== '__none' && !state.members.has(id)) cal.filter.delete(id);
  const setMode = (m) => { lastScrolledDay = null; cal.mode = m; pref.set('calMode', m); if (m !== 'month') cal.cursor = cal.selected; rerender(); };
  const step = (dir) => {
    if (cal.mode === 'month') { const d = new Date(`${cal.cursor.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + dir); cal.cursor = d.toISOString().slice(0, 10); }
    else if (cal.mode === 'week') { cal.cursor = addDaysStr(cal.cursor, 7 * dir); cal.selected = cal.cursor; }
    else if (cal.mode === 'day') { cal.cursor = addDaysStr(cal.cursor, dir); cal.selected = cal.cursor; }
    else cal.cursor = addDaysStr(cal.cursor, 30 * dir);
    rerender();
  };
  const goToday = () => { cal.cursor = today; cal.selected = today; rerender(); };
  const f = cal.filter.size ? cal.filter : null;

  let title, body;
  if (cal.mode === 'month') { title = fmtMonth(cal.cursor); body = monthView(today, f, rerender); }
  else if (cal.mode === 'week') { const ws = weekStart(cal.cursor); title = `${fmtDayShort(ws)} – ${fmtDayShort(addDaysStr(ws, 6))}`; body = weekView(ws, today, f); }
  else if (cal.mode === 'day') { title = `${relDay(cal.cursor, today) ? relDay(cal.cursor, today) + ', ' : ''}${fmtDayShort(cal.cursor)}`; body = dayView(cal.cursor, today, f); }
  else { title = 'Agenda'; body = agendaView(cal.cursor < today ? cal.cursor : today, today, f); }

  const filterChips = h('div', { class: 'filter', role: 'group', 'aria-label': 'Show events for' },
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!cal.filter.size), onclick: () => { cal.filter.clear(); pref.set('calFilter', []); rerender(); } }, 'Everyone'),
    membersList().map((m) => h('button', { type: 'button', class: 'chip', '--c': m.color, 'aria-pressed': String(cal.filter.has(m.id)),
      onclick: () => { if (cal.filter.has(m.id)) cal.filter.delete(m.id); else cal.filter.add(m.id); pref.set('calFilter', [...cal.filter]); rerender(); } },
    h('span', { class: 'dot', '--c': m.color }), m.name)));

  return h('div', { class: 'page' },
    statusBanner(),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Calendar view' }, ['day', 'week', 'month', 'agenda'].map((m) =>
      h('button', { type: 'button', 'aria-pressed': String(cal.mode === m), onclick: () => setMode(m) }, m[0].toUpperCase() + m.slice(1)))),
    h('div', { class: 'cal-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous', onclick: () => step(-1) }, icon('left')),
      h('div', { class: 'title', 'aria-live': 'polite' }, title),
      h('button', { type: 'button', class: 'btn sm', onclick: goToday }, 'Today'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next', onclick: () => step(1) }, icon('right'))),
    filterChips,
    body);
}
function weekStart(date) { const d = new Date(`${date}T12:00:00Z`).getUTCDay(); return addDaysStr(date, -d); }

function monthView(today, f, rerender) {
  const first = `${cal.cursor.slice(0, 7)}-01`;
  const gridStart = weekStart(first);
  const occ = occurrences(gridStart, addDaysStr(gridStart, 42), f);
  const byDay = new Map();
  for (const o of occ) {
    let d = o.start.slice(0, 10);
    const last = o.ev.allDay ? addDaysStr(o.end, -1) : o.end.slice(0, 10);
    for (let i = 0; i < 31 && d <= last; i++) { if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(o); d = addDaysStr(d, 1); if (!o.ev.allDay && o.end.slice(11) === '00:00' && d === last) break; }
  }
  const grid = h('div', { class: 'month', role: 'grid', 'aria-label': fmtMonth(first) });
  for (let i = 0; i < 7; i++) grid.append(h('div', { class: 'dow', 'aria-hidden': 'true' }, fmtWeekday(addDaysStr(gridStart, i)).slice(0, 2)));
  for (let i = 0; i < 42; i++) {
    const d = addDaysStr(gridStart, i);
    const list = byDay.get(d) || [];
    const colors = [];
    for (const o of list) { const ids = o.ev.assignees.length ? o.ev.assignees : [null]; for (const id of ids) { const c = id && member(id) ? member(id).color : 'var(--ink-3)'; colors.push(c); } }
    grid.append(h('button', {
      type: 'button', class: `day${d.slice(0, 7) !== first.slice(0, 7) ? ' other' : ''}${d === today ? ' today' : ''}`, role: 'gridcell',
      'aria-selected': String(d === cal.selected), 'aria-label': `${fmtDay(d)}, ${list.length} event${list.length === 1 ? '' : 's'}`,
      onclick: () => { cal.selected = d; rerender(); },
      ondblclick: () => { cal.selected = d; cal.cursor = d; cal.mode = 'day'; pref.set('calMode', 'day'); rerender(); },
    }, h('span', { class: 'n' }, String(Number(d.slice(8)))),
    h('span', { class: 'marks' }, colors.slice(0, 4).map((c) => h('i', { '--c': c }))),
    colors.length > 4 ? h('span', { class: 'more' }, `+${colors.length - 4}`) : null));
  }
  const sel = occurrences(cal.selected, addDaysStr(cal.selected, 1), f);
  return [grid, dayGroup(cal.selected, today, sel, true)];
}

function dayGroup(d, today, list, addBtn = false) {
  const rel = relDay(d, today);
  return h('div', { class: 'daygroup' },
    h('h3', null, rel ? h('span', { class: 'rel' }, rel) : null, fmtDay(d), addBtn ? h('span', { class: 'spacer', style: { flex: 1 } }) : null,
      addBtn ? h('button', { type: 'button', class: 'btn ghost sm', onclick: () => openEventEditor({ date: d }) }, '+ Add') : null),
    list.length ? list.map((o) => evItem(o, { past: o.endUtc < Date.now() && !o.ev.allDay })) : h('div', { class: 'none' }, 'No events'));
}

function weekView(ws, today, f) {
  const out = [];
  for (let i = 0; i < 7; i++) { const d = addDaysStr(ws, i); out.push(dayGroup(d, today, occurrences(d, addDaysStr(d, 1), f), true)); }
  return out;
}

function agendaView(from, today, f) {
  const days = 60;
  const occ = occurrences(from, addDaysStr(from, days), f);
  const groups = new Map();
  for (const o of occ) { const d = o.start.slice(0, 10) < from ? from : o.start.slice(0, 10); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(o); }
  if (!groups.size) return h('div', { class: 'empty' }, h('div', { class: 'big' }, 'Nothing in the next 60 days'), h('button', { class: 'btn sm', type: 'button', onclick: () => openEventEditor({}) }, 'Add an event'));
  return [...groups.entries()].map(([d, list]) => dayGroup(d, today, list));
}

const HOUR_PX = 56;
function dayView(d, today, f) {
  const occ = occurrences(d, addDaysStr(d, 1), f);
  const allDay = occ.filter((o) => o.ev.allDay);
  const timed = occ.filter((o) => !o.ev.allDay);
  const toMin = (local) => (local.slice(0, 10) < d ? 0 : local.slice(0, 10) > d ? 1440 : Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16)));
  // lay out overlapping events in columns
  const items = timed.map((o) => ({ o, s: toMin(o.start), e: Math.max(toMin(o.end), toMin(o.start) + 20) })).sort((a, b) => a.s - b.s || b.e - a.e);
  const clusters = [];
  let cur = null;
  for (const it of items) {
    if (!cur || it.s >= cur.end) { cur = { items: [], end: 0, cols: [] }; clusters.push(cur); }
    let col = cur.cols.findIndex((end) => end <= it.s);
    if (col < 0) { col = cur.cols.length; cur.cols.push(0); }
    cur.cols[col] = it.e; it.col = col; cur.items.push(it); cur.end = Math.max(cur.end, it.e);
  }
  const lane = h('div', { class: 'lane' });
  for (const c of clusters) {
    const n = c.cols.length;
    for (const it of c.items) {
      const ev = it.o.ev;
      const m = ev.assignees.map(member).filter(Boolean)[0];
      lane.append(h('button', {
        type: 'button', class: 'blk', '--c': m ? m.color : 'var(--ink-3)',
        style: { top: `${(it.s / 60) * HOUR_PX}px`, height: `${Math.max(22, ((it.e - it.s) / 60) * HOUR_PX - 2)}px`, left: `${(it.col / n) * 100}%`, width: `calc(${100 / n}% - 3px)` },
        onclick: () => openEventDetail(ev, it.o), 'aria-label': `${ev.title}, ${fmtRange(it.o, false)}`,
      }, h('b', null, ev.title), `${fmtTime(it.o.start)}${ev.location ? ' · ' + (ev.location.name || ev.location.address.split(',')[0]) : ''}`));
    }
  }
  const hours = h('div', { class: 'hours' });
  for (let i = 0; i < 24; i++) hours.append(h('div', { class: 'hr' }, i ? h('span', null, fmtTime(`2000-01-01T${String(i).padStart(2, '0')}:00`)) : null));
  const tl = h('div', { class: 'timeline' }, hours, lane);
  if (d === today) { const nm = toMin(nowLocal()); tl.append(h('div', { class: 'now', style: { top: `${(nm / 60) * HOUR_PX}px` }, 'aria-hidden': 'true' })); }
  // tap empty space to add at that hour
  hours.addEventListener('click', (e) => {
    const y = e.clientY - hours.getBoundingClientRect().top;
    const hr = Math.max(0, Math.min(23, Math.floor(y / HOUR_PX)));
    openEventEditor({ date: d, start: `${d}T${String(hr).padStart(2, '0')}:00` });
  });
  if (lastScrolledDay === d) return dayParts(allDay, timed, tl);
  lastScrolledDay = d;
  setTimeout(() => {
    const target = d === today ? Math.max(0, toMin(nowLocal()) / 60 - 1.5) : (items[0] ? items[0].s / 60 - 0.5 : 7.5);
    const top = tl.getBoundingClientRect().top + window.scrollY + target * HOUR_PX - 120;
    window.scrollTo({ top: Math.max(0, top), behavior: 'instant' in window ? 'instant' : 'auto' });
  }, 0);
  return dayParts(allDay, timed, tl);
}
let lastScrolledDay = null;
function dayParts(allDay, timed, tl) {
  return [
    allDay.length ? h('div', { class: 'allday' }, allDay.map((o) => evItem(o))) : null,
    timed.length ? null : h('p', { class: 'muted small', style: { margin: '10px 4px 0' } }, 'No timed events. Tap an hour to add one.'),
    tl];
}

// ---------- Inbox ----------
export function InboxView(rerender) {
  const root = h('div', { class: 'page' }, statusBanner(), h('div', { class: 'empty' }, 'Loading…'));
  (async () => {
    try {
      const [p, n] = await Promise.all([api('GET', '/api/proposals'), api('GET', '/api/notifications')]);
      const unread = n.notifications.filter((x) => !x.read);
      root.replaceChildren(
        ...statusBanner(),
        p.proposals.length ? h('div', null, h('div', { class: 'section-title' }, 'To confirm'), h('div', { class: 'stack' }, p.proposals.map((pr) => proposalCard(pr, () => { refreshCounts(); rerender(); })))) : null,
        h('div', { class: 'section-title row' }, h('span', { class: 'grow' }, 'Reminders & updates'),
          unread.length ? h('button', { type: 'button', class: 'btn ghost sm', onclick: async () => { await api('POST', '/api/notifications/read', { all: true }); refreshCounts(); rerender(); } }, 'Mark all read') : null),
        n.notifications.length ? h('div', { class: 'card' }, h('ul', { class: 'list' }, n.notifications.map((x) => h('li', null,
          h('button', { type: 'button', class: 'item', onclick: async () => {
            api('POST', '/api/notifications/read', { ids: [x.id] }).then(refreshCounts).catch(() => {});
            if (x.refType === 'event') { const ev = state.events.get(x.refId); if (ev) openEventDetail(ev); else toast('That event no longer exists.'); }
            else if (x.refType === 'task') { const t = state.tasks.get(x.refId); if (t) openTaskEditor({ task: t }); else toast('That task no longer exists.'); }
          } },
          h('span', { class: 'dot', '--c': x.read ? 'transparent' : 'var(--accent)' }),
          h('span', { class: 'grow' }, h('div', { class: 'title', style: { fontWeight: x.read ? 500 : 700 } }, x.title), h('div', { class: 'meta' }, x.body || ''), h('div', { class: 'meta faint' }, new Date(x.createdAt).toLocaleString())),
          icon('chev', 'chev')))))) :
          h('div', { class: 'card empty' }, h('div', { class: 'big' }, 'No reminders yet'), 'Reminders you set on events and tasks show up here, and on your phone if notifications are on.'));
    } catch (e) {
      root.replaceChildren(...statusBanner(), h('div', { class: 'empty' }, h('div', { class: 'big' }, 'Inbox needs a connection'), errorText(e)));
    }
  })();
  return root;
}

export function proposalCard(pr, onDone) {
  const p = pr.payload;
  const el = h('div', { class: 'proposal' });
  const render = (status) => {
    el.className = `proposal${status === 'accepted' ? ' done' : status === 'dismissed' ? ' dismissed' : ''}`;
    const rows = [];
    if (pr.kind === 'event') {
      rows.push(['When', p.allDay ? `${fmtDay(p.start)} · all day` : `${fmtDay(p.start)} · ${fmtRange({ start: p.start, end: p.end || p.start }, false)}`]);
      if (p.rrule) rows.push(['Repeats', describeRrule(p.rrule)]);
      if (p.assignees && p.assignees.length) rows.push(['Who', p.assignees.map((a) => (member(a) || {}).name).filter(Boolean).join(', ')]);
      if (p.location) rows.push(['Where', [p.location.name, p.location.address].filter(Boolean).join(' · ')]);
      if (p.reminders && p.reminders.length) rows.push(['Reminders', p.reminders.map((m) => (m === 0 ? 'at start' : m < 60 ? `${m} min` : m < 1440 ? `${m / 60} h` : `${m / 1440} d`)).join(', ') + ' before']);
      if (p.visibility === 'private') rows.push(['Visibility', 'Private']);
    } else {
      rows.push(['List', (state.lists.get(p.listId) || {}).name || '—']);
      if (p.due) rows.push(['Due', p.due.length > 10 ? `${fmtDay(p.due)} ${fmtTime(p.due)}` : fmtDay(p.due)]);
      if (p.assignee) rows.push(['For', (member(p.assignee) || {}).name || '—']);
      if (p.repeat) rows.push(['Repeats', p.repeat]);
    }
    el.replaceChildren(
      h('div', { class: 'k' }, status === 'accepted' ? '✓ Saved' : status === 'dismissed' ? 'Dismissed' : pr.kind === 'event' ? 'New event' : 'New task'),
      h('div', { class: 't' }, p.title),
      h('dl', null, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      pr.notes && pr.notes.length ? h('ul', { class: 'notes' }, pr.notes.map((n) => h('li', null, n))) : null,
      status === 'pending' ? h('div', { class: 'acts' },
        h('button', { type: 'button', class: 'btn sm', onclick: dismiss }, 'Dismiss'),
        h('button', { type: 'button', class: 'btn sm', onclick: edit }, 'Edit'),
        h('button', { type: 'button', class: 'btn sm primary', onclick: () => accept() }, 'Confirm')) : null);
  };
  async function accept(payload) {
    try {
      await api('POST', `/api/proposals/${pr.id}/accept`, payload ? { payload } : {});
      render('accepted'); toast('Saved'); await sync(); onDone && onDone();
    } catch (e) { toast(errorText(e), { bad: true }); throw e; }
  }
  async function dismiss() {
    try { await api('POST', `/api/proposals/${pr.id}/dismiss`, {}); render('dismissed'); onDone && onDone(); } catch (e) { toast(errorText(e), { bad: true }); }
  }
  function edit() {
    if (pr.kind === 'event') openEventEditor({ prefill: p, onSave: (data) => accept(data) });
    else openTaskEditor({ prefill: p, onSave: (data) => accept(data) });
  }
  render(pr.status || 'pending');
  return el;
}

// ---------- Assistant ----------
const chat = { conversationId: null, items: [] };
try { const s = JSON.parse(sessionStorage.getItem('ff:chat') || 'null'); if (s) Object.assign(chat, s); } catch { /* ignore */ }
const saveChat = () => { try { sessionStorage.setItem('ff:chat', JSON.stringify({ conversationId: chat.conversationId, items: chat.items.slice(-40) })); } catch { /* ignore */ } };
export const assistantDraft = { text: '' };

export function AssistantView(rerender, { startRecording } = {}) {
  const f = state.me.features;
  const list = h('div', { class: 'chat', 'aria-live': 'polite' });
  const renderList = () => {
    list.replaceChildren();
    if (!chat.items.length) {
      list.append(h('div', { class: 'card' }, h('h2', null, 'Ask or tell me anything about your family’s plans'),
        h('p', { class: 'muted', style: { margin: 0 } }, 'I’ll prepare events and tasks for you to check. Nothing is saved until you tap Confirm.'),
        !f.assistant ? h('div', { class: 'banner warn', style: { marginTop: '10px' } }, 'The assistant isn’t switched on for this app yet (the Anthropic API key hasn’t been added). You can still add everything with the + button.') : null));
    }
    for (const it of chat.items) {
      if (it.role === 'user') list.append(h('div', { class: 'msg user' }, it.text));
      else if (it.role === 'bot') list.append(h('div', { class: 'msg bot' }, it.text));
      else if (it.role === 'err') list.append(h('div', { class: 'msg err' }, it.text));
      else if (it.role === 'proposal') list.append(proposalCard(it.proposal, () => { it.proposal.status = 'decided'; saveChat(); refreshCounts(); }));
    }
  };
  renderList();
  const ta = h('textarea', { class: 'input', rows: 1, placeholder: f.assistant ? 'e.g. Dentist for Kiddo 2 next Tuesday at 3:30' : 'Assistant not set up yet', 'aria-label': 'Message', enterkeyhint: 'send', disabled: !f.assistant });
  ta.value = assistantDraft.text;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(140, ta.scrollHeight)}px`; };
  ta.addEventListener('input', () => { assistantDraft.text = ta.value; grow(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  const sendBtn = h('button', { type: 'submit', class: 'btn primary', 'aria-label': 'Send', disabled: !f.assistant }, icon('send'));
  const micBtn = h('button', { type: 'button', class: 'btn', 'aria-label': 'Speak', disabled: !f.voice, onclick: () => startRecording && startRecording() }, icon('mic'));
  let busy = false;
  async function send(textArg) {
    const text = (textArg ?? ta.value).trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true;
    chat.items.push({ role: 'user', text });
    const sg = composer.querySelector('.suggest'); if (sg) sg.remove();
    ta.value = ''; assistantDraft.text = ''; grow();
    const thinking = h('div', { class: 'msg bot muted' }, 'Thinking…');
    renderList(); list.append(thinking); scrollEnd();
    try {
      const r = await api('POST', '/api/assistant', { text, conversationId: chat.conversationId || undefined });
      chat.conversationId = r.conversationId;
      if (r.reply) chat.items.push({ role: 'bot', text: r.reply });
      for (const p of r.proposals) chat.items.push({ role: 'proposal', proposal: p });
      if (r.proposals.length) refreshCounts();
    } catch (e) {
      chat.items.push({ role: 'err', text: errorText(e) });
      if (e.code !== 'offline') { /* keep text for retry */ }
      ta.value = text; assistantDraft.text = text;
    } finally {
      busy = false; sendBtn.disabled = !f.assistant; saveChat(); renderList(); scrollEnd();
    }
  }
  const scrollEnd = () => setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 30);
  const suggestions = ['What’s on this weekend?', 'Remind me to pay the sitter Friday', 'Swim lessons every Saturday 10am for Kiddo 1', 'Add milk and eggs to groceries'];
  const composer = h('div', { class: 'composer' },
    !chat.items.length && f.assistant ? h('div', { class: 'suggest' }, suggestions.map((s) => h('button', { type: 'button', class: 'chip', onclick: () => send(s) }, s))) : null,
    h('form', { onsubmit: (e) => { e.preventDefault(); send(); } }, micBtn, ta, sendBtn));
  setTimeout(() => { grow(); scrollEnd(); }, 0);
  return h('div', { class: 'page' },
    statusBanner(),
    chat.items.length ? h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { chat.items = []; chat.conversationId = null; saveChat(); rerender(); } }, 'New conversation')) : null,
    list, composer);
}
