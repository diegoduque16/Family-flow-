// Event + task editors, event details, and the address autocomplete field.
import { h, icon, sheet, toast, choose, confirmDialog, fmtDay, fmtDayShort, fmtRange, fmtTime, reminderLabel, debounce, addDaysStr, avatarEl } from './ui.js';
import { suggestIcon, eventIcon, ICON_CHOICES } from './icons.js';
import { micButton, cleanTitle } from './voice.js';
import { api, state, mutate, membersList, listsList, member, tz, todayStr, nowLocal, localEventRow, groupsList, groupName, sync } from './store.js';
import { parseRrule, buildRrule } from './time.js';

const DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DOW_LABEL = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DOW_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REMINDER_OPTS = [0, 10, 30, 60, 120, 1440, 2880, 10080];

export const canEdit = () => state.me && ['owner', 'adult'].includes(state.me.role);
export const mapsUrl = (loc) => {
  const q = loc.address || loc.name;
  const ios = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
  return ios ? `https://maps.apple.com/?q=${encodeURIComponent(q)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
};

// ---------- address autocomplete (ARIA combobox) ----------
let comboSeq = 0;
export function placeInput({ value = null, label = 'Location', onChange }) {
  const id = `combo${++comboSeq}`;
  let current = value;
  let results = [];
  let active = -1;
  let reqId = 0;
  const input = h('input', {
    class: 'input', id, type: 'text', autocomplete: 'off', autocapitalize: 'words', spellcheck: false, placeholder: 'Search an address or place',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-lb`,
    value: value ? (value.name || value.address) : '',
  });
  const lb = h('ul', { class: 'listbox', id: `${id}-lb`, role: 'listbox', hidden: true });
  const chip = h('div');
  const root = h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), h('div', { class: 'combo' }, input, lb), chip);

  function renderChip() {
    chip.replaceChildren();
    if (current && current.address) {
      chip.append(h('div', { class: 'place-chip' }, icon('pin'), h('div', { class: 'grow' },
        current.name ? h('div', { style: { fontWeight: 650 } }, current.name) : null, h('div', { class: 'muted small' }, current.address)),
      h('a', { class: 'btn ghost sm', href: mapsUrl(current), target: '_blank', rel: 'noopener' }, 'Map')));
    } else if (current && current.name) {
      chip.append(h('p', { class: 'hint' }, 'No address selected — saved as a name only.'));
    }
  }
  function close() { lb.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; }
  function show(items, statusText) {
    results = items;
    active = -1;
    lb.replaceChildren();
    items.forEach((r, i) => {
      lb.append(h('li', { class: 'opt', role: 'option', id: `${id}-o${i}`, 'aria-selected': 'false', onmousedown: (e) => { e.preventDefault(); pick(i); } },
        icon(r.source === 'saved' ? (r.favorite ? 'star' : 'clock') : 'pin'),
        h('div', null, r.name ? h('div', { class: 't' }, r.name) : null, h('div', { class: r.name ? 'a' : 't' }, r.address))));
    });
    if (statusText) lb.append(h('li', { class: 'status', role: 'presentation' }, statusText));
    const open = items.length > 0 || !!statusText;
    lb.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
  }
  function highlight(i) {
    active = i;
    [...lb.querySelectorAll('.opt')].forEach((el, j) => el.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) { input.setAttribute('aria-activedescendant', `${id}-o${i}`); lb.querySelector(`#${id}-o${i}`).scrollIntoView({ block: 'nearest' }); }
  }
  function pick(i) {
    const r = results[i];
    current = { name: r.name || '', address: r.address, lat: r.lat ?? undefined, lon: r.lon ?? undefined };
    input.value = r.name || r.address;
    close(); renderChip();
    onChange && onChange(current);
  }
  const search = debounce(async (q) => {
    const my = ++reqId;
    if (q.length < 2) {
      try {
        const s = await api('GET', '/api/places/saved');
        if (my === reqId) show(s.places.slice(0, 6), s.places.length ? '' : 'Type at least 2 letters to search');
      } catch { if (my === reqId) close(); }
      return;
    }
    show(results.filter((r) => (r.name + r.address).toLowerCase().includes(q.toLowerCase())), 'Searching…');
    try {
      const r = await api('GET', `/api/places?q=${encodeURIComponent(q)}`);
      if (my !== reqId) return;
      const note = r.degraded ? 'Address search is temporarily unavailable — you can keep the name as typed.' : (r.results.length ? '' : 'No matches. Keep typing, or keep the name as typed.');
      show(r.results, note);
    } catch (e) {
      if (my === reqId) show([], e.code === 'offline' ? 'Offline — address search unavailable. Keep the name as typed.' : e.message);
    }
  }, 220);
  input.addEventListener('input', () => {
    current = input.value.trim() ? { name: input.value.trim(), address: '' } : null;
    renderChip();
    onChange && onChange(current);
    search(input.value.trim());
  });
  input.addEventListener('focus', () => search(input.value.trim()));
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    const n = lb.querySelectorAll('.opt').length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); if (lb.hidden) show(results); highlight((active + 1) % n); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); highlight(active <= 0 ? n - 1 : active - 1); }
    else if (e.key === 'Enter' && !lb.hidden && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape' && !lb.hidden) { e.preventDefault(); close(); }
  });
  renderChip();
  return { el: root, get value() { return current; } };
}

// ---------- shared field helpers ----------
const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
function memberPicker(selected, { single = false } = {}) {
  const set = new Set(selected);
  const wrap = h('div', { class: 'chips', role: 'group' });
  const render = () => {
    wrap.replaceChildren(...membersList().map((m) => h('button', {
      type: 'button', class: 'chip', '--c': m.color, 'aria-pressed': String(set.has(m.id)),
      onclick: () => { if (set.has(m.id)) set.delete(m.id); else { if (single) set.clear(); set.add(m.id); } render(); },
    }, m.avatar ? avatarEl(m, { size: 22 }) : h('span', { class: 'dot', '--c': m.color }), m.name)));
  };
  render();
  return { el: wrap, get value() { return [...set]; } };
}

function addMinutes(local, mins) {
  const d = new Date(`${local}:00Z`); d.setUTCMinutes(d.getUTCMinutes() + mins); return d.toISOString().slice(0, 16);
}
function defaultStart(date) {
  const n = nowLocal();
  if (!date || date === n.slice(0, 10)) {
    const d = new Date(`${n}:00Z`); d.setUTCMinutes(0); d.setUTCHours(d.getUTCHours() + 1); return d.toISOString().slice(0, 16);
  }
  return `${date}T09:00`;
}

// ---------- event editor ----------
// opts: { event (existing), occurrence {start,end}, date, prefill (payload), onSave(payload) for proposals }
export function openEventEditor(opts = {}) {
  const ev = opts.event || null;
  const p = opts.prefill || null;
  const isProposal = !!opts.onSave;
  const editingOcc = ev && ev.rrule && opts.occurrence ? opts.occurrence : null;
  const src = p || ev || {};
  let start = editingOcc ? editingOcc.start : (src.start || opts.start || defaultStart(opts.date));
  let end = editingOcc ? editingOcc.end : src.end;
  let allDay = !!src.allDay;
  if (!end) end = allDay ? addDaysStr(start, 1) : addMinutes(start.length > 10 ? start : `${start}T09:00`, 60);

  const title = h('input', { class: 'input', type: 'text', maxlength: 200, value: src.title || '', placeholder: 'e.g. Soccer practice', autofocus: !ev && !p, required: true, enterkeyhint: 'next' });
  const titleErr = h('p', { class: 'err', hidden: true });
  const allDayT = h('input', { type: 'checkbox', checked: allDay, 'aria-label': 'All day' });
  const sDate = h('input', { class: 'input', type: 'date', value: start.slice(0, 10), required: true });
  const sTime = h('input', { class: 'input', type: 'time', value: start.length > 10 ? start.slice(11, 16) : '09:00', step: 300 });
  const eDate = h('input', { class: 'input', type: 'date', value: (allDay ? addDaysStr(end, -1) : end).slice(0, 10) });
  const eTime = h('input', { class: 'input', type: 'time', value: end.length > 10 ? end.slice(11, 16) : '10:00', step: 300 });
  const timeErr = h('p', { class: 'err', hidden: true });

  // recurrence
  const rr = src.rrule ? parseRrule(src.rrule) : null;
  const freqSel = h('select', { class: 'input', 'aria-label': 'Repeats' },
    h('option', { value: '' }, 'Does not repeat'), h('option', { value: 'DAILY' }, 'Every day'), h('option', { value: 'WEEKLY' }, 'Every week'),
    h('option', { value: 'MONTHLY' }, 'Every month'), h('option', { value: 'YEARLY' }, 'Every year'));
  freqSel.value = rr ? rr.freq : '';
  const interval = h('input', { class: 'input', type: 'number', min: 1, max: 99, value: rr ? rr.interval || 1 : 1, inputmode: 'numeric', 'aria-label': 'Repeat every N' });
  const byday = new Set(rr && rr.byday && rr.byday.length ? rr.byday : []);
  const dayBtns = h('div', { class: 'chips', role: 'group', 'aria-label': 'Days of the week' });
  const renderDays = () => dayBtns.replaceChildren(...DOW_LABEL.map((l, i) => h('button', {
    type: 'button', class: 'chip', style: { width: '40px', justifyContent: 'center', padding: '0' }, 'aria-label': DOW_NAME[i], 'aria-pressed': String(byday.has(i)),
    onclick: () => { if (byday.has(i)) byday.delete(i); else byday.add(i); renderDays(); },
  }, l)));
  renderDays();
  const endsSel = h('select', { class: 'input', 'aria-label': 'Ends' }, h('option', { value: 'never' }, 'Never'), h('option', { value: 'until' }, 'On a date'), h('option', { value: 'count' }, 'After a number of times'));
  endsSel.value = rr && rr.until ? 'until' : rr && rr.count ? 'count' : 'never';
  const untilI = h('input', { class: 'input', type: 'date', value: rr && rr.until ? rr.until : '' });
  const countI = h('input', { class: 'input', type: 'number', min: 1, max: 999, value: rr && rr.count ? rr.count : 10, inputmode: 'numeric' });
  const unitLabel = h('span', { class: 'muted' });
  const recurDetail = h('div');
  function renderRecur() {
    const f = freqSel.value;
    recurDetail.hidden = !f;
    unitLabel.textContent = { DAILY: 'day(s)', WEEKLY: 'week(s)', MONTHLY: 'month(s)', YEARLY: 'year(s)' }[f] || '';
    untilI.hidden = endsSel.value !== 'until';
    countI.hidden = endsSel.value !== 'count';
    dayBtns.parentElement && (dayBtns.parentElement.hidden = f !== 'WEEKLY');
  }
  recurDetail.append(
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Every'), h('div', { class: 'row' }, h('div', { style: { width: '90px' } }, interval), unitLabel)),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'On'), dayBtns),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Ends'), endsSel, h('div', { style: { marginTop: '8px' } }, untilI, countI)));
  freqSel.addEventListener('change', () => { if (freqSel.value === 'WEEKLY' && !byday.size) { byday.add(new Date(`${sDate.value}T12:00:00Z`).getUTCDay()); renderDays(); } renderRecur(); });
  endsSel.addEventListener('change', renderRecur);

  const who = memberPicker(src.assignees || (state.me.memberId && !ev && !p ? [] : []));
  const place = placeInput({ value: src.location || null });
  const rem = new Set(src.reminders || (ev || p ? [] : [30]));
  const remWrap = h('div', { class: 'chips' });
  const renderRem = () => remWrap.replaceChildren(...REMINDER_OPTS.map((m) => h('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(rem.has(m)), onclick: () => { if (rem.has(m)) rem.delete(m); else if (rem.size < 5) rem.add(m); renderRem(); },
  }, reminderLabel(m))));
  renderRem();
  // Who sees it: the whole family, one family group, or only me.
  const share = h('select', { class: 'input', 'aria-label': 'Share with' },
    h('option', { value: '' }, 'Everyone in the family'),
    groupsList().map((g) => h('option', { value: g.id }, `${g.name} only`)),
    h('option', { value: '__private' }, 'Only me (private)'));
  share.value = src.visibility === 'private' ? '__private' : (src.groupId && state.groups.has(src.groupId) ? src.groupId : '');
  const shareHint = h('p', { class: 'hint' });
  const renderShare = () => {
    const g = state.groups.get(share.value);
    shareHint.textContent = share.value === '__private' ? 'Only you can see it. No one else is notified.'
      : g ? `Only ${g.memberIds.map((id) => (member(id) || {}).name).filter(Boolean).join(', ') || 'this group'} will see it and get updates.`
      : 'Everyone in the family sees it and gets an update when it’s added or changed.';
  };
  share.addEventListener('change', renderShare);
  renderShare();

  // Activity icon: suggested from the title until you pick one ('-' = no icon).
  let iconTouched = !!src.icon;
  let iconChoice = src.icon && src.icon !== '-' ? src.icon : null;
  const iconPreview = h('span', { style: { fontSize: '28px', minWidth: '36px', textAlign: 'center', lineHeight: 1 }, 'aria-hidden': 'true' });
  const iconNote = h('span', { class: 'hint grow', style: { margin: 0 } });
  const iconGrid = h('div', { class: 'icon-grid', hidden: true, role: 'group', 'aria-label': 'Choose an icon', style: { marginTop: '8px' } });
  const iconToggle = h('button', { type: 'button', class: 'btn ghost sm', 'aria-expanded': 'false' }, 'Change');
  const currentIcon = () => (iconTouched ? iconChoice : suggestIcon(title.value));
  function renderIcon() {
    const cur = currentIcon();
    const sug = suggestIcon(title.value);
    iconPreview.textContent = cur || '–';
    iconNote.textContent = iconTouched ? (cur ? 'Your choice' : 'No icon') : sug ? 'Suggested from the title' : 'No suggestion yet — pick one';
    iconToggle.textContent = iconGrid.hidden ? (cur ? 'Change' : 'Pick an icon') : 'Done';
    const opts = [...new Set([sug, ...ICON_CHOICES].filter(Boolean))];
    iconGrid.replaceChildren(...[
      h('button', { type: 'button', class: 'chip', style: { width: 'auto', padding: '0 12px', fontSize: '14px' }, 'aria-pressed': String(iconTouched && !iconChoice), onclick: () => { iconTouched = true; iconChoice = null; renderIcon(); } }, 'None'),
      sug ? h('button', { type: 'button', class: 'chip', style: { width: 'auto', padding: '0 12px', fontSize: '14px' }, 'aria-pressed': String(!iconTouched), onclick: () => { iconTouched = false; iconChoice = null; renderIcon(); } }, 'Auto') : null,
    ].filter(Boolean),
      ...opts.map((ic) => h('button', { type: 'button', class: 'chip', 'aria-label': `Icon ${ic}`, 'aria-pressed': String(iconTouched && iconChoice === ic), onclick: () => { iconTouched = true; iconChoice = ic; renderIcon(); } }, ic)));
  }
  iconToggle.addEventListener('click', () => { iconGrid.hidden = !iconGrid.hidden; iconToggle.setAttribute('aria-expanded', String(!iconGrid.hidden)); renderIcon(); });
  title.addEventListener('input', () => { if (!iconTouched) renderIcon(); });
  renderIcon();
  const notes = h('textarea', { class: 'input', maxlength: 5000, rows: 3, placeholder: 'Anything to remember' });
  notes.value = src.notes || '';
  const formErr = h('div');

  function syncTimeVisibility() {
    allDay = allDayT.checked;
    sTime.hidden = allDay; eTime.hidden = allDay;
  }
  allDayT.addEventListener('change', syncTimeVisibility);
  // keep duration when start changes
  let lastStart = `${sDate.value}T${sTime.value}`;
  const onStartChange = () => {
    const ns = `${sDate.value}T${sTime.value}`;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(ns) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(lastStart)) {
      const dur = (Date.parse(`${eDate.value}T${eTime.value}:00Z`) - Date.parse(`${lastStart}:00Z`)) / 60000;
      if (Number.isFinite(dur) && dur > 0) { const ne = addMinutes(ns, dur); eDate.value = ne.slice(0, 10); eTime.value = ne.slice(11, 16); }
      else if (allDay && eDate.value < sDate.value) eDate.value = sDate.value;
    }
    lastStart = ns;
  };
  sDate.addEventListener('change', onStartChange);
  sTime.addEventListener('change', onStartChange);

  function collect() {
    titleErr.hidden = true; timeErr.hidden = true; title.removeAttribute('aria-invalid');
    const t = title.value.trim();
    if (!t) { titleErr.textContent = 'Give it a name.'; titleErr.hidden = false; title.setAttribute('aria-invalid', 'true'); title.focus(); return null; }
    if (!sDate.value) { timeErr.textContent = 'Pick a date.'; timeErr.hidden = false; return null; }
    let s, e;
    if (allDay) {
      s = sDate.value;
      const ed = eDate.value && eDate.value >= s ? eDate.value : s;
      e = addDaysStr(ed, 1);
    } else {
      if (!sTime.value || !eTime.value) { timeErr.textContent = 'Pick a start and end time.'; timeErr.hidden = false; return null; }
      s = `${sDate.value}T${sTime.value}`;
      e = `${eDate.value || sDate.value}T${eTime.value}`;
      if (e <= s) { timeErr.textContent = 'The end must be after the start.'; timeErr.hidden = false; return null; }
    }
    let rrule = null;
    if (freqSel.value) {
      const r = { freq: freqSel.value, interval: Math.max(1, Math.min(99, Number(interval.value) || 1)), byday: freqSel.value === 'WEEKLY' ? [...byday].sort() : [], count: null, until: null };
      if (endsSel.value === 'until') {
        if (!untilI.value || untilI.value < s.slice(0, 10)) { timeErr.textContent = 'The repeat end date must be on or after the start.'; timeErr.hidden = false; return null; }
        r.until = untilI.value;
      }
      if (endsSel.value === 'count') r.count = Math.max(1, Math.min(999, Number(countI.value) || 1));
      rrule = buildRrule(r);
    }
    const loc = place.value;
    return {
      title: t, notes: notes.value.trim(), allDay, start: s, end: e, rrule,
      assignees: who.value, visibility: share.value === '__private' ? 'private' : 'shared', groupId: share.value && share.value !== '__private' ? share.value : null,
      icon: iconTouched ? (iconChoice || '-') : null, reminders: [...rem].sort((a, b) => a - b),
      location: loc && (loc.name || loc.address) ? { name: loc.name || '', address: loc.address || '', ...(loc.lat != null ? { lat: loc.lat, lon: loc.lon } : {}) } : null,
    };
  }

  const saveBtn = h('button', { type: 'button', class: 'btn primary' }, isProposal ? 'Confirm & save' : 'Save');
  const s = sheet({
    title: isProposal ? 'Review event' : ev ? 'Edit event' : 'New event',
    full: true,
    body: h('form', { onsubmit: (e) => { e.preventDefault(); save(); }, novalidate: true },
      field('Title', h('div', null, h('div', { class: 'with-mic' }, title, micButton((text) => { title.value = cleanTitle(text); title.dispatchEvent(new Event('input')); title.focus(); }, { label: 'Say the event name', hint: 'Say the event name, like “Soccer practice”. Tap to stop.' })), titleErr)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Icon'), h('div', { class: 'row', style: { gap: '10px' } }, iconPreview, iconNote, iconToggle), iconGrid),
      h('label', { class: 'switch field' }, h('span', { style: { fontWeight: 650 } }, 'All day'), allDayT),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Starts'), h('div', { class: 'two' }, sDate, sTime)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Ends'), h('div', { class: 'two' }, eDate, eTime), timeErr),
      editingOcc ? null : field('Repeats', freqSel), editingOcc ? null : recurDetail,
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Who'), who.el),
      place.el,
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Share with'), share, shareHint),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Reminders'), remWrap, h('p', { class: 'hint' }, 'Sent to everyone who can see this event and has notifications on.')),
      field('Notes', notes),
      formErr,
      h('button', { type: 'submit', hidden: true })),
    foot: [h('button', { type: 'button', class: 'btn', onclick: () => s.close() }, 'Cancel'), saveBtn],
  });
  syncTimeVisibility();
  renderRecur();
  saveBtn.addEventListener('click', () => save());
  // editing the end time on the start day pulls the end date back to that day
  eTime.addEventListener('change', () => {
    if (eDate.value > sDate.value && `${sDate.value}T${eTime.value}` > `${sDate.value}T${sTime.value}` && (Date.parse(`${eDate.value}T00:00:00Z`) - Date.parse(`${sDate.value}T00:00:00Z`)) <= 86400000) eDate.value = sDate.value;
  });

  async function save() {
    const data = collect();
    if (!data) return;
    formErr.replaceChildren();
    saveBtn.disabled = true;
    try {
      if (isProposal) { await opts.onSave(data); s.close(); return; }
      // conflicts (only checked online; never blocks saving)
      if (state.online && data.assignees.length) {
        try {
          const c = await api('POST', '/api/events/conflicts', { ...data, ...(ev ? { id: ev.id } : {}) });
          if (c.conflicts.length) {
            const lines = c.conflicts.slice(0, 4).map((x) => `• ${x.title}, ${fmtDayShortSafe(x.start)} ${fmtTime(x.start)} (${x.members.map((id) => (member(id) || {}).name).filter(Boolean).join(', ')})`).join('\n');
            const go = await choose('Heads up: overlap', `This overlaps with:\n${lines}`, [{ label: 'Save anyway', value: true, kind: 'primary' }, { label: 'Go back', value: false }]);
            if (!go) return;
          }
        } catch (e) { if (e.status === 422) throw e; }
      }
      if (!ev) {
        const tmp = `tmp_${Date.now()}`;
        const r = await mutate({ method: 'POST', path: '/api/events', body: data, kind: 'events', optimistic: { kind: 'events', id: tmp, row: localEventRow(tmp, data) } });
        toast(r.queued ? 'Saved on this device. It will sync when you’re back online.' : 'Event saved');
      } else {
        let scope = 'all';
        if (ev.rrule && opts.occurrence) {
          scope = await choose('Change recurring event', null, [
            { label: 'Only this event', value: 'this' }, { label: 'This and following events', value: 'following' }, { label: 'All events', value: 'all', kind: 'primary' }]);
          if (!scope) return;
        }
        const body = { ...data, version: ev.version, scope };
        if (scope !== 'all') { body.occurrence = opts.occurrence.start; if (scope === 'this') delete body.rrule; }
        else if (ev.rrule && opts.occurrence) {
          // editing "all" from an occurrence: shift the series by the same amount the occurrence moved, keep the series start date
          body.start = shiftLike(ev.start, opts.occurrence.start, data.start);
          body.end = shiftLike(ev.end, opts.occurrence.end, data.end);
        }
        const r = await mutate({ method: 'PATCH', path: `/api/events/${ev.id}`, body, kind: 'events',
          optimistic: scope === 'all' ? { kind: 'events', id: ev.id, row: localEventRow(ev.id, { ...ev, ...data, start: body.start, end: body.end }, ev) } : null,
          offlineOk: scope === 'all' });
        toast(r.queued ? 'Saved on this device. It will sync when you’re back online.' : 'Changes saved');
      }
      s.close();
    } catch (e) {
      formErr.replaceChildren(h('div', { class: 'banner bad' }, errorText(e)));
      if (e.status === 409) formErr.append(h('button', { type: 'button', class: 'btn sm', onclick: () => { s.close(); } }, 'Close and see the latest version'));
    } finally { saveBtn.disabled = false; }
  }
  return s;
}
function fmtDayShortSafe(local) { try { return fmtDay(local); } catch { return local; } }
// Apply the delta (newOcc - oldOcc) to the series' base value.
function shiftLike(base, oldOcc, newOcc) {
  if (base.length !== newOcc.length) return base.slice(0, 10) + newOcc.slice(10);
  if (base.length === 10) {
    const d = (Date.parse(`${newOcc}T00:00:00Z`) - Date.parse(`${oldOcc}T00:00:00Z`)) / 86400000;
    return addDaysStr(base, d);
  }
  const delta = Date.parse(`${newOcc}:00Z`) - Date.parse(`${oldOcc}:00Z`);
  return new Date(Date.parse(`${base}:00Z`) + delta).toISOString().slice(0, 16);
}
export function errorText(e) {
  if (e.status === 409 && e.code === 'conflict') return 'Someone else changed this while you were editing. Close it to see the latest version, then try again.';
  if (e.code === 'offline') return 'You’re offline. This change needs a connection.';
  return e.message || 'Something went wrong.';
}

// ---------- event details ----------
export function openEventDetail(ev, occ) {
  const o = occ || { start: ev.start, end: ev.end };
  const who = (ev.assignees || []).map(member).filter(Boolean);
  const rr = ev.rrule ? describeRrule(ev.rrule) : null;
  const mine = ev.ownerUserId === state.me.user.id;
  const editable = !ev._pending && !ev.readOnly && (canEdit() || mine);
  const src = ev.sourceId ? state.sources.get(ev.sourceId) : null;
  const ic = eventIcon(ev);
  const grp = ev.groupId ? groupName(ev.groupId) : null;
  const s = sheet({
    title: ic ? `${ic} ${ev.title}` : ev.title,
    body: h('div', { style: { paddingTop: '6px' } },
      h('p', { style: { fontSize: '17px', fontWeight: 650, margin: '6px 0 2px' } }, fmtDay(o.start)),
      h('p', { class: 'muted', style: { margin: '0 0 12px' } }, fmtRange(o, ev.allDay), ev.tz !== tz() ? ` (${ev.tz})` : ''),
      rr ? h('div', { class: 'row muted small', style: { marginBottom: '8px' } }, icon('repeat'), rr) : null,
      ev.visibility === 'private' ? h('div', { class: 'row muted small', style: { marginBottom: '8px' } }, icon('lock'), 'Private — only you can see this') : null,
      grp ? h('div', { class: 'row muted small', style: { marginBottom: '8px' } }, icon('people'), `Shared with ${grp} only`) : null,
      who.length ? h('div', { class: 'chips', style: { margin: '10px 0' } }, who.map((m) => h('span', { class: 'chip', '--c': m.color, 'aria-pressed': 'true' }, m.avatar ? avatarEl(m, { size: 22 }) : h('span', { class: 'dot', '--c': m.color }), m.name))) : null,
      ev.location ? h('a', { class: 'place-chip', href: mapsUrl(ev.location), target: '_blank', rel: 'noopener', style: { color: 'inherit', textDecoration: 'none' } }, icon('pin'),
        h('div', { class: 'grow' }, ev.location.name ? h('div', { style: { fontWeight: 650 } }, ev.location.name) : null, ev.location.address ? h('div', { class: 'muted small' }, ev.location.address) : null),
        h('span', { class: 'btn ghost sm' }, 'Directions')) : null,
      (ev.reminders || []).length ? h('div', { class: 'row muted small', style: { margin: '12px 0' } }, icon('bell'), ev.reminders.map(reminderLabel).join(', ')) : null,
      ev.notes ? h('p', { style: { whiteSpace: 'pre-wrap', margin: '12px 0' } }, ev.notes) : null,
      ev._pending ? h('div', { class: 'banner warn' }, 'Waiting to sync. You can edit it once it’s saved to the server.') : null,
      ev.holiday ? h('div', { class: 'banner info' }, h('div', null, h('div', null, ev.federal ? 'US federal holiday — banks, post offices and many schools and offices are closed.' : 'Popular US observance (not a day off).'), h('div', { class: 'small', style: { marginTop: '6px', opacity: 0.8 } }, 'Added automatically. Turn holidays off in More → Household.'))) : null,
      ev.readOnly && !ev.holiday ? h('div', { class: 'banner info' }, icon('link'), `From ${src ? src.name : 'a connected calendar'}${src ? ` (${providerName(src.provider)})` : ''}. To change it, edit it there — it updates here within about 15 minutes.`) : null),
    foot: editable ? [
      h('button', { type: 'button', class: 'btn danger', onclick: async () => { if (await deleteEvent(ev, occ)) s.close(); } }, icon('trash'), 'Delete'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => { s.close(); openEventEditor({ event: ev, occurrence: ev.rrule ? o : null }); } }, icon('edit'), 'Edit'),
    ] : null,
  });
}

async function deleteEvent(ev, occ) {
  let scope = 'all';
  if (ev.rrule && occ) {
    scope = await choose('Delete recurring event', null, [
      { label: 'Only this event', value: 'this', kind: 'danger' }, { label: 'This and following events', value: 'following', kind: 'danger' }, { label: 'All events', value: 'all', kind: 'danger' }]);
    if (!scope) return false;
  } else if (!(await confirmDialog('Delete event?', `“${ev.title}” will be removed for everyone who can see it.`, 'Delete', true))) return false;
  const q = new URLSearchParams({ version: ev.version, scope });
  if (scope !== 'all') q.set('occurrence', occ.start);
  try {
    const r = await mutate({ method: 'DELETE', path: `/api/events/${ev.id}?${q}`, kind: 'events', optimistic: scope === 'all' ? { kind: 'events', id: ev.id, remove: true } : null, offlineOk: scope === 'all' });
    toast(r.queued ? 'Deleted on this device. It will sync when you’re back online.' : 'Deleted');
    return true;
  } catch (e) { toast(errorText(e), { bad: true }); return false; }
}

export const providerName = (p) => ({ google: 'Google Calendar', outlook: 'Outlook', apple: 'Apple Calendar' }[p] || 'calendar link');

export function describeRrule(rule) {
  const r = parseRrule(rule);
  const n = r.interval || 1;
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
  let s = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (r.freq === 'WEEKLY' && r.byday && r.byday.length) s += ` on ${r.byday.map((d) => DOW_NAME[d]).join(', ')}`;
  if (r.until) s += `, until ${fmtDay(r.until)}`;
  if (r.count) s += `, ${r.count} times`;
  return s;
}

// ---------- task editor ----------
export function openTaskEditor(opts = {}) {
  const t = opts.task || null;
  const p = opts.prefill || null;
  const isProposal = !!opts.onSave;
  const src = p || t || {};
  const lists = listsList();
  const title = h('input', { class: 'input', type: 'text', maxlength: 200, value: src.title || '', placeholder: 'e.g. Pack swim bag', autofocus: !t && !p });
  const listSel = h('select', { class: 'input' }, lists.map((l) => h('option', { value: l.id }, l.name)));
  listSel.value = src.listId || opts.listId || (lists[0] && lists[0].id);
  const due = src.due || '';
  const dDate = h('input', { class: 'input', type: 'date', value: due.slice(0, 10) });
  const dTime = h('input', { class: 'input', type: 'time', value: due.length > 10 ? due.slice(11, 16) : '', step: 300, 'aria-label': 'Due time (optional)' });
  const who = memberPicker(src.assignee ? [src.assignee] : [], { single: true });
  const repeat = h('select', { class: 'input' }, h('option', { value: '' }, 'Does not repeat'), h('option', { value: 'daily' }, 'Every day'), h('option', { value: 'weekly' }, 'Every week'), h('option', { value: 'monthly' }, 'Every month'));
  repeat.value = src.repeat || '';
  const remind = h('input', { type: 'checkbox', checked: !!src.remind });
  const notes = h('textarea', { class: 'input', maxlength: 2000, rows: 3 });
  notes.value = src.notes || '';
  const err = h('div');
  const saveBtn = h('button', { type: 'button', class: 'btn primary' }, isProposal ? 'Confirm & save' : 'Save');
  const s = sheet({
    title: isProposal ? 'Review task' : t ? 'Edit task' : 'New task', full: true,
    body: h('form', { onsubmit: (e) => { e.preventDefault(); save(); }, novalidate: true },
      field('Task', h('div', { class: 'with-mic' }, title, micButton((text) => { title.value = cleanTitle(text); title.focus(); }, { label: 'Say the task', hint: 'Say the task, like “Pack swim bag”. Tap to stop.' }))), field('List', listSel),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Due (optional)'), h('div', { class: 'two' }, dDate, dTime)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'For'), who.el),
      field('Repeats', repeat, 'When ticked off, a repeating task moves to its next due date.'),
      h('label', { class: 'switch field' }, h('span', null, h('span', { style: { fontWeight: 650 } }, 'Remind'), h('span', { class: 'hint', style: { display: 'block', margin: 0 } }, 'At the due time, or 9:00 if no time')), remind),
      field('Notes', notes), err, h('button', { type: 'submit', hidden: true })),
    foot: [
      t && canEdit() ? h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog('Delete task?', `“${t.title}”`, 'Delete', true))) return;
        try { await mutate({ method: 'DELETE', path: `/api/tasks/${t.id}`, kind: 'tasks', optimistic: { kind: 'tasks', id: t.id, remove: true } }); s.close(); toast('Task deleted'); } catch (e) { toast(errorText(e), { bad: true }); }
      } }, 'Delete') : h('button', { type: 'button', class: 'btn', onclick: () => s.close() }, 'Cancel'),
      saveBtn],
  });
  saveBtn.addEventListener('click', () => save());
  async function save() {
    const tt = title.value.trim();
    if (!tt) { err.replaceChildren(h('p', { class: 'err' }, 'Give the task a name.')); title.focus(); return; }
    const dueV = dDate.value ? (dTime.value ? `${dDate.value}T${dTime.value}` : dDate.value) : null;
    if (repeat.value && !dueV) { err.replaceChildren(h('p', { class: 'err' }, 'A repeating task needs a due date.')); return; }
    const data = { listId: listSel.value, title: tt, notes: notes.value.trim(), due: dueV, assignee: who.value[0] || null, repeat: repeat.value || null, remind: remind.checked && !!dueV, eventId: src.eventId || null };
    saveBtn.disabled = true;
    try {
      if (isProposal) { await opts.onSave(data); s.close(); return; }
      if (t) {
        const r = await mutate({ method: 'PATCH', path: `/api/tasks/${t.id}`, body: { ...data, version: t.version }, kind: 'tasks', optimistic: { kind: 'tasks', id: t.id, row: { ...t, ...data } } });
        toast(r.queued ? 'Saved on this device; will sync when online.' : 'Task saved');
      } else {
        const tmp = `tmp_${Date.now()}`;
        const r = await mutate({ method: 'POST', path: '/api/tasks', body: data, kind: 'tasks', optimistic: { kind: 'tasks', id: tmp, row: { id: tmp, ...data, done: false, version: 1, sort: 0 } } });
        toast(r.queued ? 'Saved on this device; will sync when online.' : 'Task added');
      }
      s.close();
    } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); } finally { saveBtn.disabled = false; }
  }
  return s;
}

export async function toggleTask(t) {
  if (t._pending) { toast('Waiting to sync — try again in a moment.'); return; }
  try {
    const r = await mutate({ method: 'PATCH', path: `/api/tasks/${t.id}`, body: { done: !t.done, version: t.version }, kind: 'tasks',
      optimistic: { kind: 'tasks', id: t.id, row: { ...t, done: !t.done } } });
    if (!t.done && !r.queued && r.task && !r.task.done && r.task.repeat) toast(`Done! Next one: ${r.task.due.length > 10 ? fmtDay(r.task.due) + ' ' + fmtTime(r.task.due) : fmtDay(r.task.due)}`);
  } catch (e) { toast(errorText(e), { bad: true }); }
}

export function taskDueLabel(t) {
  if (!t.due) return null;
  const today = todayStr();
  const d = t.due.slice(0, 10);
  const overdue = !t.done && (d < today || (d === today && t.due.length > 10 && t.due < nowLocal()));
  const txt = d === today ? `Today${t.due.length > 10 ? ' ' + fmtTime(t.due) : ''}` : d === addDaysStr(today, 1) ? `Tomorrow${t.due.length > 10 ? ' ' + fmtTime(t.due) : ''}` : `${fmtDay(d)}${t.due.length > 10 ? ' ' + fmtTime(t.due) : ''}`;
  return h('span', { class: overdue ? 'overdue' : '' }, overdue ? `Overdue · ${txt}` : txt);
}

// ---------- "Which profile is you?" ----------
// Links the signed-in login to a family profile (Hayley = Mom, Diego = Dad…), so "for Mom" events, assigned tasks and groups reach the right person.
export async function openWhoAmI(onDone) {
  let people = [];
  try { people = (await api('GET', '/api/household/people')).people; } catch { /* offline: show without names */ }
  const takenBy = new Map(people.filter((p) => p.member_id && p.id !== state.me.user.id).map((p) => [p.member_id, p.name]));
  const owner = state.me.role === 'owner';
  const first = String(state.me.user.name || '').split(' ')[0] || 'me';
  const err = h('div');
  let s;
  const pick = async (body, label) => {
    try {
      await api('PATCH', '/api/me/profile', body);
      state.me = await api('GET', '/api/me');
      s.close();
      await sync({ full: true });
      toast(label);
      if (onDone) onDone();
    } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
  };
  s = sheet({
    title: 'Which profile is you?',
    body: h('div', null,
      h('p', { class: 'muted', style: { marginTop: 0 } }, 'Pick your profile so events and tasks “for” you, family groups and alerts reach you. You can rename profiles in More → Family profiles.'),
      h('div', { class: 'card', style: { padding: '4px 12px' } }, h('ul', { class: 'list' }, membersList().map((m) => {
        const t = takenBy.get(m.id);
        const mine = state.me.memberId === m.id;
        return h('li', null, h('button', { type: 'button', class: 'item', disabled: !!t && !owner && !mine, onclick: () => pick({ memberId: m.id }, `You’re ${m.name} now`) },
          avatarEl(m), h('span', { class: 'grow' }, h('div', { class: 'title' }, m.name, mine ? ' (you)' : ''), t ? h('div', { class: 'meta' }, owner ? `Now ${t}’s — choosing it moves it to you` : `${t}’s profile`) : null),
          mine ? icon('check') : null));
      }))),
      h('button', { type: 'button', class: 'btn block', style: { marginTop: '10px' }, onclick: () => pick({ createNamed: first }, `Added you as ${first}`) }, icon('plus'), `I’m not listed — add “${first}”`),
      err),
  });
}

// ---------- import from a PDF or photo ----------
// Photos are converted to a reasonably sized JPEG on the device (also handles iPhone HEIC photos).
async function prepareUpload(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return new Blob([file], { type: 'application/pdf' });
  if (!/^image\//.test(file.type || 'image/')) throw new Error('Choose a PDF or a photo of the schedule.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not open that picture. Try a PDF, JPEG or PNG.')); i.src = url; });
    const scale = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.85));
  } finally { URL.revokeObjectURL(url); }
}

export function openImportDocument() {
  if (!state.me.features.assistant) { toast('Importing needs the assistant, which isn’t switched on for this app yet.', { bad: true }); return; }
  const input = h('input', { type: 'file', accept: 'application/pdf,image/*', hidden: true });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    const s = sheet({ title: 'Reading your file…', body: h('div', { class: 'rec' }, h('div', { class: 'pulse', style: { background: 'var(--accent)' } }, icon('event')),
      h('p', null, `Finding the dates in “${file.name}”`), h('p', { class: 'muted small', style: { textAlign: 'center', margin: 0 } }, 'Long calendars can take up to a minute.')) });
    try {
      const blob = await prepareUpload(file);
      const res = await api('POST', '/api/import/document', blob, { headers: { 'x-file-name': encodeURIComponent(file.name) } });
      s.close();
      if (!res.events.length) { toast('I couldn’t find any dates in that file.', { bad: true }); return; }
      reviewImport(res);
    } catch (e) { s.setBody(h('div', { class: 'stack', style: { padding: '12px 0' } }, h('div', { class: 'banner bad' }, errorText(e)), h('button', { type: 'button', class: 'btn block', onclick: () => s.close() }, 'Close'))); }
  });
  input.click();
}

function whenLabel(e) {
  if (e.allDay) {
    const last = addDaysStr(e.end, -1);
    return last > e.start ? `${fmtDayShort(e.start)} – ${fmtDayShort(last)}` : `${fmtDayShort(e.start)} · all day`;
  }
  return `${fmtDayShort(e.start)} · ${fmtTime(e.start)}${e.end ? `–${fmtTime(e.end)}` : ''}`;
}

function reviewImport(res) {
  const rows = res.events.map((e) => ({ e, on: !e.exists, title: h('input', { class: 'input', value: e.title, maxlength: 200, 'aria-label': 'Title', style: { padding: '6px 10px', minHeight: '36px' } }) }));
  const who = memberPicker([]);
  const share = h('select', { class: 'input', 'aria-label': 'Share with' }, h('option', { value: '' }, 'Everyone'), groupsList().map((g) => h('option', { value: g.id }, `${g.name} only`)), h('option', { value: '__private' }, 'Only me'));
  const rem = h('select', { class: 'input', 'aria-label': 'Reminder' }, h('option', { value: '' }, 'No reminder'), h('option', { value: '1440' }, '1 day before'), h('option', { value: '60' }, '1 hour before'));
  const addBtn = h('button', { type: 'button', class: 'btn primary' });
  const err = h('div');
  const countOn = () => rows.filter((r) => r.on).length;
  const renderBtn = () => { const n = countOn(); addBtn.textContent = n ? `Add ${n} event${n > 1 ? 's' : ''}` : 'Nothing selected'; addBtn.disabled = !n; };
  const list = h('ul', { class: 'list' }, rows.map((r) => {
    const cb = h('input', { type: 'checkbox', checked: r.on, 'aria-label': `Add ${r.e.title}`, style: { width: '22px', height: '22px', flex: 'none', marginTop: '8px' } });
    cb.addEventListener('change', () => { r.on = cb.checked; renderBtn(); });
    const ic = eventIcon({ title: r.e.title });
    return h('li', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 0' } }, cb,
      h('div', { class: 'grow', style: { minWidth: 0 } },
        h('div', { class: 'row', style: { gap: '6px' } }, ic ? h('span', { 'aria-hidden': 'true' }, ic) : null, r.title),
        h('div', { class: 'meta small', style: { marginTop: '4px' } }, whenLabel(r.e), r.e.location ? ` · ${r.e.location.name}` : '',
          r.e.assignees.length ? ` · ${r.e.assignees.map((id) => (member(id) || {}).name).filter(Boolean).join(', ')}` : ''),
        r.e.notes ? h('div', { class: 'faint small' }, r.e.notes) : null,
        r.e.exists ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, 'Already on your calendar') : null));
  }));
  const toggleAll = h('button', { type: 'button', class: 'btn ghost sm', onclick: () => {
    const all = countOn() < rows.length;
    rows.forEach((r) => { r.on = all; });
    list.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = all; });
    renderBtn();
  } }, 'Select all / none');
  renderBtn();
  const s = sheet({
    title: `Found ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`, full: true,
    body: h('div', null,
      res.summary ? h('p', { class: 'muted', style: { marginTop: 0 } }, res.summary) : null,
      h('div', { class: 'card', style: { padding: '12px' } },
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'For (when the file doesn’t say)'), who.el),
        h('div', { class: 'two' }, h('label', { class: 'field', style: { margin: 0 } }, h('span', { class: 'label' }, 'Share with'), share), h('label', { class: 'field', style: { margin: 0 } }, h('span', { class: 'label' }, 'Reminder'), rem))),
      h('div', { class: 'row', style: { justifyContent: 'space-between', margin: '10px 0 0' } }, h('span', { class: 'muted small' }, 'Check the dates, untick anything you don’t want, and fix titles if needed.'), toggleAll),
      list, err),
    foot: [h('button', { type: 'button', class: 'btn', onclick: () => s.close() }, 'Cancel'), addBtn],
  });
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true;
    err.replaceChildren();
    const priv = share.value === '__private';
    const events = rows.filter((r) => r.on).map(({ e, title }) => ({
      title: title.value.trim() || e.title, start: e.start, ...(e.end ? { end: e.end } : {}), allDay: e.allDay, location: e.location, notes: e.notes,
      assignees: e.assignees.length ? e.assignees : who.value, visibility: priv ? 'private' : 'shared', groupId: !priv && share.value ? share.value : null,
      reminders: rem.value ? [Number(rem.value)] : [],
    }));
    try {
      const r = await api('POST', '/api/events/bulk', { events, source: res.fileName || 'a file' });
      await sync();
      if (r.failed.length) err.replaceChildren(h('div', { class: 'banner warn' }, `Added ${r.created.length}. Couldn’t add: ${r.failed.map((f) => `${f.title || 'untitled'} (${f.error})`).join('; ')}`));
      else { s.close(); toast(`Added ${r.created.length} event${r.created.length > 1 ? 's' : ''} to the calendar`); }
    } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); renderBtn(); }
  });
}
