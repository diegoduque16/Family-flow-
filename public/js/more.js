// "More" area: tasks & lists, family profiles, people & invites, places, calendar sync, notifications, household, data, diagnostics, account.
import { h, icon, toast, sheet, confirmDialog, copyText, initials, avatarEl, labelInput } from './ui.js';
import { AVATAR_CHOICES } from './icons.js';
import { HOLIDAY_REGIONS, isUsZone } from './holidays.js';
import { micButton, splitItems, cleanTitle } from './voice.js';
import { api, state, mutate, membersList, listsList, member, sync, clearLocalData, emit, groupsList, myGroups, groupName } from './store.js';
import { openTaskEditor, placeInput, canEdit, errorText, providerName, openWhoAmI } from './editors.js';
import { taskRow } from './views.js';

const COLORS = ['#E76F51', '#2A9D8F', '#E9A23B', '#7C6CF2', '#D9487D', '#3A86FF', '#6A994E', '#8D6E63', '#F4A261', '#264653', '#9B5DE5', '#00A6A6'];
const isOwner = () => state.me.role === 'owner';
const back = () => h('div', { class: 'row', style: { margin: '0 0 4px -8px' } }, h('a', { class: 'btn ghost sm', href: '#/more' }, icon('back'), 'More'));

export function MoreView() {
  const item = (href, ic, title, sub, show = true) => show ? h('li', null, h('a', { class: 'item', href }, h('span', { class: 'icon-btn', style: { background: 'var(--accent-soft)', color: 'var(--accent)' } }, icon(ic)), h('span', { class: 'grow' }, h('div', { class: 'title' }, title), sub ? h('div', { class: 'meta' }, sub) : null), icon('chev', 'chev'))) : null;
  return h('div', { class: 'page' },
    h('div', { class: 'card' }, h('ul', { class: 'list' },
      item('#/more/tasks', 'task', 'Tasks & lists', 'To-do, groceries, shopping'),
      item('#/more/family', 'people', 'Family profiles', membersList().map((m) => m.name).join(', ')),
      item('#/more/groups', 'people', 'Family groups', groupsList().length ? groupsList().map((g) => g.name).join(', ') : 'Nuclear, extended family…'),
      item('#/more/people', 'user', 'People & invites', 'Who can sign in to this household'),
      item('#/more/places', 'pin', 'Saved places', 'Home, school, favourite spots'))),
    h('div', { class: 'card' }, h('ul', { class: 'list' },
      item('#/more/notifications', 'bell', 'Notifications', 'Reminders and family updates'),
      item('#/more/sync', 'link', 'Connected calendars', 'Google, Outlook, Apple — in and out'),
      item('#/more/household', 'home', 'Household', state.household ? `${state.household.name} · ${state.household.timezone}` : ''),
      item('#/more/data', 'download', 'Your data', 'Export or delete'),
      item('#/more/diagnostics', 'shield', 'Diagnostics', 'Live health checks', isOwner()),
      item('#/more/account', 'user', 'Account', state.me.user.email))),
    h('p', { class: 'faint small', style: { textAlign: 'center' } }, 'Family Flow · Phase 1'));
}

// ---------- tasks & lists ----------
let currentList = null;
export function TasksView(rerender) {
  const lists = listsList();
  if (!currentList || !state.lists.has(currentList)) currentList = lists[0] && lists[0].id;
  const list = state.lists.get(currentList);
  const tasks = [...state.tasks.values()].filter((t) => t.listId === currentList);
  const open = tasks.filter((t) => !t.done).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.sort - b.sort);
  const done = tasks.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 20);
  const quick = h('input', { class: 'input', placeholder: list && list.kind === 'shopping' ? 'Add an item' : 'Add a task', 'aria-label': 'New item', enterkeyhint: 'done', maxlength: 200 });
  const addQuick = async () => {
    const title = quick.value.trim();
    if (!title) return;
    quick.value = '';
    const tmp = `tmp_${Date.now()}`;
    const body = { listId: currentList, title, notes: '', due: null, assignee: null, repeat: null, remind: false, eventId: null };
    try { await mutate({ method: 'POST', path: '/api/tasks', body, kind: 'tasks', optimistic: { kind: 'tasks', id: tmp, row: { id: tmp, ...body, done: false, version: 1, sort: 0 } } }); quick.blur(); rerender(); const q2 = document.querySelector('[aria-label="New item"]'); if (q2) q2.focus(); } catch (e) { toast(errorText(e), { bad: true }); quick.value = title; }
  };
  quick.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addQuick(); } });
  // Voice: shopping lists add every item you name at once; to-do lists put the text in the box to check first.
  const voiceAdd = async (text) => {
    if (list && list.kind === 'shopping') {
      const items = splitItems(text);
      let n = 0;
      for (const title of items) {
        const tmp = `tmp_${Date.now()}_${n}`;
        const body = { listId: currentList, title, notes: '', due: null, assignee: null, repeat: null, remind: false, eventId: null };
        try { await mutate({ method: 'POST', path: '/api/tasks', body, kind: 'tasks', optimistic: { kind: 'tasks', id: tmp, row: { id: tmp, ...body, done: false, version: 1, sort: 0 } } }); n++; } catch (e) { toast(errorText(e), { bad: true }); break; }
      }
      if (n) toast(n === 1 ? `Added “${items[0]}”` : `Added ${n} items: ${items.slice(0, n).join(', ')}`);
      rerender();
    } else {
      quick.value = cleanTitle(text);
      quick.focus();
      toast('Check it, then tap + to add.');
    }
  };
  return h('div', { class: 'page' }, back('Tasks & lists'),
    h('div', { class: 'filter' }, lists.map((l) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(l.id === currentList), onclick: () => { currentList = l.id; rerender(); } }, l.name, l.groupId ? h('span', { class: 'faint', title: `${groupName(l.groupId) || 'Group'} only` }, ' 👥') : null)),
      canEdit() ? h('button', { type: 'button', class: 'chip', onclick: () => listEditor(null, rerender) }, '+ New list') : null),
    list ? h('div', { class: 'card' },
      h('h2', null, list.name, h('span', { class: 'spacer' }), canEdit() ? h('button', { type: 'button', class: 'btn ghost sm', onclick: () => listEditor(list, rerender) }, 'Edit list') : null),
      list.groupId ? h('p', { class: 'muted small', style: { margin: '-4px 0 8px' } }, `👥 Only ${groupName(list.groupId) || 'a family group'} can see this list`) : null,
      canEdit() ? h('div', { class: 'quick-add' }, quick, micButton(voiceAdd, { label: list && list.kind === 'shopping' ? 'Say items to add' : 'Say a task', hint: list && list.kind === 'shopping' ? 'Say the items, like “milk, eggs and bread”. Tap to stop.' : 'Say the task, like “Call the plumber”. Tap to stop.' }), h('button', { type: 'button', class: 'btn primary', onclick: addQuick, 'aria-label': 'Add' }, icon('plus'))) : null,
      open.length ? h('ul', { class: 'list', style: { marginTop: '8px' } }, open.map((t) => taskRow(t))) : h('div', { class: 'empty' }, 'Nothing here yet.'),
      done.length ? [h('div', { class: 'section-title' }, 'Done'), h('ul', { class: 'list' }, done.map((t) => taskRow(t)))] : null) : null,
    canEdit() ? h('button', { type: 'button', class: 'btn block', onclick: () => openTaskEditor({ listId: currentList }) }, 'Add with details (due date, person, reminder)') : null);
}
function listEditor(l, rerender) {
  const name = h('input', { class: 'input', value: l ? l.name : '', maxlength: 60, autofocus: true });
  const kind = h('select', { class: 'input', disabled: !!l }, h('option', { value: 'todo' }, 'To-do list'), h('option', { value: 'shopping' }, 'Shopping list'));
  kind.value = l ? l.kind : 'todo';
  const mine = myGroups();
  const who = h('select', { class: 'input' }, h('option', { value: '' }, 'Everyone in the family'), mine.map((g) => h('option', { value: g.id }, `${g.name} only`)));
  who.value = l && l.groupId && mine.some((g) => g.id === l.groupId) ? l.groupId : '';
  const err = h('div');
  const s = sheet({
    title: l ? 'Edit list' : 'New list',
    body: h('div', null, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name), h('label', { class: 'field' }, h('span', { class: 'label' }, 'Type'), kind),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Who can see it'), who,
        h('p', { class: 'hint' }, mine.length ? 'Limit a list to one of your family groups — handy for gift lists.' : 'Tip: create family groups in More → Family groups to keep a list to just some people.')), err),
    foot: [
      l ? h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog('Delete list?', `“${l.name}” and all its items will be deleted.`, 'Delete', true))) return;
        try { await mutate({ method: 'DELETE', path: `/api/lists/${l.id}`, kind: 'lists', optimistic: { kind: 'lists', id: l.id, remove: true }, offlineOk: false }); await sync(); s.close(); rerender(); } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, 'Delete') : h('button', { type: 'button', class: 'btn', onclick: () => s.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) return;
        try {
          const groupId = who.value || null;
          if (l) await mutate({ method: 'PATCH', path: `/api/lists/${l.id}`, body: { name: name.value.trim(), groupId, version: l.version }, kind: 'lists', offlineOk: false });
          else { const r = await mutate({ method: 'POST', path: '/api/lists', body: { name: name.value.trim(), kind: kind.value, groupId }, kind: 'lists', offlineOk: false }); currentList = r.list.id; }
          s.close(); rerender();
        } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, 'Save')],
  });
}

// ---------- family profiles ----------
let peopleCache = null;
export function FamilyView(rerender) {
  if (!peopleCache) api('GET', '/api/household/people').then(({ people }) => { peopleCache = people; rerender(); }).catch(() => {});
  const loginOf = (m) => (peopleCache || []).find((p) => p.member_id === m.id);
  return h('div', { class: 'page' }, back('Family profiles'),
    h('p', { class: 'muted' }, 'Everyone in the family, with how they show up in the app (Mom, Dad, Grandma…) and a photo or avatar. Kids and relatives don’t need a login — invite people who should sign in from People & invites.'),
    h('div', { class: 'card' }, h('ul', { class: 'list' }, membersList().map((m) => h('li', null,
      h('button', { type: 'button', class: 'item', onclick: () => memberEditor(m, rerender), disabled: !canEdit() },
        avatarEl(m, { size: 40 }),
        h('span', { class: 'grow', style: { minWidth: 0 } },
          h('div', { class: 'title' }, m.name, loginOf(m) && loginOf(m).id === state.me.user.id ? h('span', { class: 'faint' }, ' · you') : null),
          h('div', { class: 'meta' }, [m.label && m.fullName !== m.label ? m.fullName : null, m.kind === 'child' ? 'Child' : 'Adult', ...groupsList().filter((g) => g.memberIds.includes(m.id)).map((g) => g.name)].filter(Boolean).join(' · ')),
          peopleCache ? h('div', { class: 'small', style: { marginTop: '2px', overflowWrap: 'anywhere', color: loginOf(m) ? 'var(--ink-2)' : 'var(--ink-3)' } },
            loginOf(m) ? `🔑 Signs in as ${loginOf(m).email || loginOf(m).name}` : 'No login – doesn’t sign in') : null),
        canEdit() ? icon('chev', 'chev') : null))))),
    canEdit() ? h('button', { type: 'button', class: 'btn block primary', onclick: () => memberEditor(null, rerender) }, icon('plus'), 'Add a profile') : null,
    h('button', { type: 'button', class: 'btn block', onclick: () => openWhoAmI(() => { peopleCache = null; rerender(); }) }, 'Which profile is me?'));
}
function memberEditor(m, rerender) {
  const name = h('input', { class: 'input', value: m ? (m.fullName ?? m.name) : '', maxlength: 40, autofocus: true, placeholder: 'e.g. Rosa Duque' });
  const lab = labelInput(m ? m.label || '' : '');
  let color = m ? m.color : COLORS.find((c) => !membersList().some((x) => x.color === c)) || COLORS[0];
  const sw = h('div', { class: 'colors', role: 'radiogroup', 'aria-label': 'Colour' });
  const renderSw = () => { sw.replaceChildren(...COLORS.map((c) => h('button', { type: 'button', class: 'swatch', '--c': c, role: 'radio', 'aria-checked': String(c === color), 'aria-label': c, onclick: () => { color = c; renderSw(); if (typeof renderAvatar === 'function') renderAvatar(); } }))); };
  renderSw();
  const kind = h('select', { class: 'input' }, h('option', { value: 'adult' }, 'Adult'), h('option', { value: 'child' }, 'Child'));
  kind.value = m ? m.kind : 'child';
  const err = h('div');
  // Picture: a photo (cropped square and shrunk on this device) or an emoji avatar.
  let avatar = m ? m.avatar || null : null;
  const preview = h('div');
  const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const emojiRow = h('div', { class: 'icon-grid', role: 'group', 'aria-label': 'Avatars', hidden: true, style: { marginTop: '8px' } });
  const renderAvatar = () => {
    preview.replaceChildren(avatarEl({ name: lab.value || name.value || '?', color, avatar }, { size: 64 }));
    emojiRow.replaceChildren(...AVATAR_CHOICES.map((a) => h('button', { type: 'button', class: 'chip', 'aria-label': `Avatar ${a}`, 'aria-pressed': String(avatar === a), onclick: () => { avatar = a; renderAvatar(); } }, a)));
  };
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    try { avatar = await photoToDataUrl(f); renderAvatar(); } catch (e) { if (e.message === 'cancelled') return; err.replaceChildren(h('div', { class: 'banner bad' }, e.message || 'Could not use that picture.')); }
  });
  name.addEventListener('input', renderAvatar);
  lab.input.addEventListener('input', renderAvatar);
  const picture = h('div', { class: 'field' }, h('span', { class: 'label' }, 'Picture'),
    h('div', { class: 'avatar-edit' }, preview,
      h('div', { class: 'stack', style: { gap: '6px' } },
        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
          h('button', { type: 'button', class: 'btn sm', onclick: () => fileIn.click() }, '📷 Photo'),
          h('button', { type: 'button', class: 'btn sm', onclick: () => { emojiRow.hidden = !emojiRow.hidden; } }, '😀 Avatar'),
          h('button', { type: 'button', class: 'btn sm', onclick: async () => {
            if (!/^data:image\//.test(avatar || '')) { fileIn.click(); return; }
            try { avatar = await photoToDataUrl(await (await fetch(avatar)).blob()); renderAvatar(); } catch (e) { if (e.message !== 'cancelled') err.replaceChildren(h('div', { class: 'banner bad' }, e.message)); }
          } }, '✥ Adjust'),
          h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { avatar = null; renderAvatar(); } }, 'Remove')),
        h('p', { class: 'hint', style: { margin: 0 } }, 'After choosing a photo you can drag and zoom to centre it. “Adjust” re-centres the current one.'))),
    emojiRow, fileIn);
  const s = sheet({
    title: m ? 'Edit profile' : 'New profile',
    body: h('div', null, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Shows up as'), lab.el, h('p', { class: 'hint' }, 'What the family sees on the calendar and in alerts — e.g. Mom, Dad, Grandma. Empty = the name.')),
      picture, h('div', { class: 'field' }, h('span', { class: 'label' }, 'Colour'), sw),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Type'), kind), err),
    foot: [
      m ? h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog(`Remove ${m.name}?`, 'They’ll be removed from events and tasks. The events themselves stay.', 'Remove', true))) return;
        try { await mutate({ method: 'DELETE', path: `/api/members/${m.id}`, kind: 'members', optimistic: { kind: 'members', id: m.id, remove: true }, offlineOk: false }); s.close(); rerender(); } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, 'Remove') : h('button', { type: 'button', class: 'btn', onclick: () => s.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) { err.replaceChildren(h('p', { class: 'err' }, 'Enter a name.')); return; }
        const body = { name: name.value.trim(), label: lab.value || null, color, kind: kind.value, avatar };
        try {
          if (m) await mutate({ method: 'PATCH', path: `/api/members/${m.id}`, body: { ...body, version: m.version }, kind: 'members', offlineOk: false });
          else await mutate({ method: 'POST', path: '/api/members', body, kind: 'members', offlineOk: false });
          s.close(); rerender();
        } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, 'Save')],
  });
  renderAvatar();
}

// Photo picker with a crop step: drag to centre the face, slide (or pinch / scroll) to zoom. Saves a small square JPEG.
async function photoToDataUrl(file, size = 192) {
  if (!/^image\//.test(file.type || 'image/')) throw new Error('Please choose a picture.');
  const url = URL.createObjectURL(file);
  let img;
  try {
    img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not open that picture. Try a JPEG or PNG.')); i.src = url; });
  } finally { URL.revokeObjectURL(url); }
  const W = img.naturalWidth, H = img.naturalHeight;
  const FRAME = 260;
  const base = FRAME / Math.min(W, H); // scale at which the photo just covers the frame
  let zoom = 1, cx = W / 2, cy = H / 2; // centre of the frame, in photo pixels
  const view = h('canvas', { width: FRAME * 2, height: FRAME * 2, style: { width: `${FRAME}px`, height: `${FRAME}px`, borderRadius: '50%', touchAction: 'none', cursor: 'grab', background: 'var(--surface-2, #eee)', display: 'block', margin: '0 auto' }, 'aria-label': 'Drag to move the photo' });
  const clamp = () => {
    const half = FRAME / 2 / (base * zoom);
    cx = Math.min(Math.max(cx, half), W - half);
    cy = Math.min(Math.max(cy, half), H - half);
  };
  const drawTo = (canvas, px) => {
    const g = canvas.getContext('2d');
    const k = (px / FRAME) * base * zoom; // canvas px per photo px
    g.fillStyle = '#fff'; g.fillRect(0, 0, px, px);
    g.drawImage(img, px / 2 - cx * k, px / 2 - cy * k, W * k, H * k);
  };
  const draw = () => { clamp(); drawTo(view, FRAME * 2); };
  const slider = h('input', { type: 'range', min: '1', max: '4', step: '0.01', value: '1', 'aria-label': 'Zoom', style: { width: '100%' } });
  slider.addEventListener('input', () => { zoom = Number(slider.value); draw(); });
  // Drag (one finger / mouse) and pinch (two fingers).
  const pts = new Map();
  let pinch0 = null;
  view.addEventListener('pointerdown', (e) => { view.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); view.style.cursor = 'grabbing'; });
  view.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0) { zoom = Math.min(4, Math.max(1, pinch0.zoom * d / pinch0.d)); slider.value = String(zoom); }
      else pinch0 = { d, zoom };
    } else {
      const k = base * zoom;
      cx -= (e.clientX - prev.x) / k; cy -= (e.clientY - prev.y) / k;
    }
    draw();
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = null; view.style.cursor = 'grab'; };
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
  view.addEventListener('wheel', (e) => { e.preventDefault(); zoom = Math.min(4, Math.max(1, zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))); slider.value = String(zoom); draw(); }, { passive: false });
  draw();
  return new Promise((resolve, reject) => {
    let done = false;
    const s = sheet({
      title: 'Position the photo',
      body: h('div', { class: 'stack', style: { padding: '8px 0', gap: '14px' } },
        view,
        h('div', { class: 'row', style: { gap: '10px' } }, h('span', { 'aria-hidden': 'true' }, '−'), slider, h('span', { 'aria-hidden': 'true' }, '+')),
        h('p', { class: 'muted small', style: { textAlign: 'center', margin: 0 } }, 'Drag to centre the face. Slide or pinch to zoom.')),
      foot: [
        h('button', { type: 'button', class: 'btn', onclick: () => { done = true; s.close(); reject(new Error('cancelled')); } }, 'Cancel'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => {
          const c = document.createElement('canvas');
          c.width = size; c.height = size;
          drawTo(c, size);
          let q = 0.85;
          let out = c.toDataURL('image/jpeg', q);
          while (out.length > 100000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
          done = true; s.close(); resolve(out);
        } }, 'Use photo')],
      onClose: () => { if (!done) reject(new Error('cancelled')); },
    });
  });
}
// ---------- family groups ----------
export function GroupsView(rerender) {
  const groups = groupsList();
  return h('div', { class: 'page' }, back('Family groups'),
    h('p', { class: 'muted' }, 'Groups let you share some events and lists with just part of the family — for example “Nuclear family” for school and chores, and “Extended family” for holidays with grandparents and cousins. When adding an event, choose who to share it with.'),
    groups.length ? h('div', { class: 'card' }, h('ul', { class: 'list' }, groups.map((g) => {
      const ms = g.memberIds.map(member).filter(Boolean);
      return h('li', null, h('button', { type: 'button', class: 'item', onclick: () => groupEditor(g, rerender), disabled: !canEdit() },
        h('span', { class: 'row', style: { gap: '0' } }, ms.slice(0, 4).map((m, i) => h('span', { style: { marginLeft: i ? '-10px' : '0' } }, avatarEl(m, { size: 32 })))),
        h('span', { class: 'grow' }, h('div', { class: 'title' }, g.name), h('div', { class: 'meta' }, ms.map((m) => m.name).join(', ') || 'No one yet')),
        canEdit() ? icon('chev', 'chev') : null));
    }))) : h('div', { class: 'card empty' }, h('div', { class: 'big' }, 'No groups yet'), 'Start with “Nuclear family” and “Extended family”.'),
    canEdit() ? h('div', { class: 'stack' },
      h('button', { type: 'button', class: 'btn block primary', onclick: () => groupEditor(null, rerender) }, icon('plus'), 'New group'),
      !groups.length ? h('button', { type: 'button', class: 'btn block', onclick: async () => {
        try {
          const all = membersList().map((m) => m.id);
          await api('POST', '/api/groups', { name: 'Nuclear family', memberIds: all });
          await api('POST', '/api/groups', { name: 'Extended family', memberIds: all });
          await sync(); toast('Two groups created — edit them to choose who’s in each.'); rerender();
        } catch (e) { toast(errorText(e), { bad: true }); }
      } }, 'Quick start: create “Nuclear” and “Extended family”') : null) : null,
    h('p', { class: 'faint small' }, 'Groups are made of family profiles. Someone sees a group’s events when their login is linked to a profile in the group (People & invites → Edit).'));
}

async function groupLink(g) {
  try {
    const r = await api('POST', '/api/invites', { groupId: g.id });
    const text = `Join our “${g.name}” on Family Flow — the ${state.household.name} calendar: ${r.url}\nCreate your account with your name (you can choose how you show up, like Abuela or Uncle). On iPhone, open it in Safari, then Share → Add to Home Screen.`;
    sheet({
      title: `${g.name} link`,
      body: h('div', { class: 'stack', style: { padding: '8px 0' } },
        h('p', { class: 'muted' }, `Anyone with this link can join ${state.household.name} and will be in “${g.name}”. Up to ${r.maxUses} people, for ${r.expiresInDays} days. Already in the family? Opening it adds them to the group.`),
        h('code', { class: 'copy' }, r.url),
        sendButtons(text, `Join ${g.name} on Family Flow`)),
    });
  } catch (e) { toast(errorText(e), { bad: true }); }
}

function groupEditor(g, rerender) {
  const name = h('input', { class: 'input', value: g ? g.name : '', maxlength: 40, autofocus: !g, placeholder: 'e.g. Extended family' });
  const set = new Set(g ? g.memberIds : []);
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Who is in this group' });
  const render = () => chips.replaceChildren(...membersList().map((m) => h('button', {
    type: 'button', class: 'chip', '--c': m.color, 'aria-pressed': String(set.has(m.id)), onclick: () => { if (set.has(m.id)) set.delete(m.id); else set.add(m.id); render(); },
  }, avatarEl(m, { size: 22 }), m.name)));
  render();
  const err = h('div');
  const s = sheet({
    title: g ? 'Edit group' : 'New group',
    body: h('div', null, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Who’s in it'), chips, h('p', { class: 'hint' }, 'Missing someone? Add them in More → Family profiles, or send them the group link below.')),
      g ? h('div', { class: 'card', style: { padding: '12px', margin: '6px 0 10px' } },
        h('div', { style: { fontWeight: 650 } }, `Invite people to ${g.name}`),
        h('p', { class: 'hint', style: { margin: '4px 0 10px' } }, 'One link for a group chat: everyone who joins with it gets their own profile and lands in this group. Works for up to 30 people for 14 days.'),
        h('button', { type: 'button', class: 'btn block primary', onclick: () => { s.close(); groupLink(g); } }, icon('share'), 'Get the group link')) : null,
      err),
    foot: [
      g ? h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog(`Delete “${g.name}”?`, 'Events and lists shared with this group will become visible to the whole family.', 'Delete', true))) return;
        try { await api('DELETE', `/api/groups/${g.id}`); await sync(); s.close(); rerender(); } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, 'Delete') : h('button', { type: 'button', class: 'btn', onclick: () => s.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) { err.replaceChildren(h('p', { class: 'err' }, 'Give the group a name.')); return; }
        try {
          if (g) await api('PATCH', `/api/groups/${g.id}`, { name: name.value.trim(), memberIds: [...set], version: g.version });
          else await api('POST', '/api/groups', { name: name.value.trim(), memberIds: [...set] });
          await sync(); s.close(); rerender();
        } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, 'Save')],
  });
}

// ---------- people & invites ----------
export function PeopleView(rerender) {
  const root = h('div', { class: 'page' }, back('People & invites'), h('div', { class: 'empty' }, 'Loading…'));
  (async () => {
    try {
      const { people } = await api('GET', '/api/household/people');
      const roleName = { owner: 'Owner', adult: 'Adult', child: 'Child' };
      root.replaceChildren(back('People & invites'),
        h('p', { class: 'muted' }, 'Owners manage the household. Adults can add and edit everything. Children can see shared events and tick off tasks.'),
        h('div', { class: 'card' }, h('ul', { class: 'list' }, people.map((p) => {
          const prof = member(p.member_id);
          const me = p.id === state.me.user.id;
          return h('li', { style: { padding: '12px 0' } },
            h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
              prof ? avatarEl(prof, { size: 40 }) : h('span', { class: 'avatar', '--c': 'var(--ink-3)' }, initials(p.name)),
              h('div', { class: 'grow', style: { minWidth: 0 } },
                h('div', { class: 'title', style: { fontWeight: 650 } }, p.name, me ? h('span', { class: 'faint' }, ' (you)') : null),
                p.email ? h('div', { class: 'small', style: { overflowWrap: 'anywhere' } }, `🔑 ${p.email}`) : null,
                h('div', { class: 'small', style: { marginTop: '2px' } },
                  prof ? ['Shows up as ', h('b', null, prof.name), prof.label && prof.fullName && prof.fullName !== prof.label ? ` (${prof.fullName})` : ''] : h('span', { style: { color: 'var(--warn)' } }, 'No profile linked yet'),
                  h('span', { class: 'faint' }, ` · ${roleName[p.role]}`)))),
            h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginTop: '8px', paddingLeft: '52px' } },
              me ? h('button', { type: 'button', class: 'btn sm', onclick: () => openWhoAmI(rerender) }, prof ? 'Change my profile' : 'Pick my profile') : null,
              !me ? h('button', { type: 'button', class: 'btn sm', onclick: () => sendAppLink(p) }, icon('share'), 'Send link') : null,
              isOwner() ? h('button', { type: 'button', class: 'btn sm', onclick: () => personEditor(p, rerender) }, 'Edit') :
                me ? h('button', { type: 'button', class: 'btn ghost sm', onclick: () => leave(p) }, 'Leave') : null));
        }))),
        h('div', { class: 'card' }, h('h2', null, 'Lost the link?'),
          h('p', { class: 'muted small', style: { marginTop: 0 } }, 'People who already joined just need the app’s address and their own email and password. Tap “Send link” next to them, or share it here.'),
          h('button', { type: 'button', class: 'btn block', onclick: () => sendAppLink(null) }, icon('share'), 'Share the Family Flow link')),
        isOwner() ? h('div', { class: 'card' }, h('h2', null, 'Invite someone'),
          h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Creates a one-time link that works for 7 days. Send it however you like (text, email).'),
          h('div', { class: 'two' },
            h('button', { type: 'button', class: 'btn', onclick: () => invite('adult') }, 'Invite an adult'),
            h('button', { type: 'button', class: 'btn', onclick: () => invite('child') }, 'Invite a child'))) : null);
    } catch (e) { root.replaceChildren(back('People & invites'), h('div', { class: 'banner bad' }, errorText(e))); }
  })();
  return root;
}
// Buttons to send a message: WhatsApp and Messages open with the text filled in (you pick the person), plus Copy and the phone's share sheet.
// The share sheet gets the text only (link included in it): WhatsApp on iPhone drops the message when a separate url is shared.
function sendButtons(text, title) {
  const enc = encodeURIComponent(text);
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return h('div', { class: 'stack', style: { gap: '8px' } },
    h('div', { class: 'two' },
      h('a', { class: 'btn primary', href: `https://wa.me/?text=${enc}`, target: '_blank', rel: 'noopener' }, '💬 WhatsApp'),
      h('a', { class: 'btn', href: ios ? `sms:&body=${enc}` : `sms:?body=${enc}` }, '✉️ Text message')),
    h('div', { class: 'two' },
      h('button', { type: 'button', class: 'btn', onclick: () => copyText(text) }, icon('copy'), 'Copy'),
      navigator.share ? h('button', { type: 'button', class: 'btn', onclick: () => navigator.share({ title, text }).catch(() => {}) }, icon('share'), 'More…') : h('a', { class: 'btn', href: `mailto:?subject=${encodeURIComponent(title)}&body=${enc}` }, '📧 Email')));
}

// For people who already have an account: the app's address plus how to sign in and install it.
function sendAppLink(p) {
  const url = `${location.origin}/`;
  const first = p ? String(p.name || '').split(' ')[0] : '';
  const text = [
    `${first ? `Hi ${first}! ` : ''}Here’s our Family Flow: ${url}`,
    p && p.email ? `Sign in with ${p.email} and your password.` : 'Sign in with your email and password.',
    'On iPhone: open it in Safari, tap Share → Add to Home Screen, then open it from the icon to turn on notifications.',
  ].join('\n');
  sheet({
    title: p ? `Send ${first || 'them'} the link` : 'Family Flow link',
    body: h('div', { class: 'stack', style: { padding: '8px 0' } },
      h('p', { class: 'muted' }, p ? `${first || 'They'} already ${p.name ? 'has' : 'have'} an account, so no new invitation is needed — just the app’s address.` : 'Share this with anyone in the family who already has an account.'),
      h('code', { class: 'copy', style: { whiteSpace: 'pre-wrap' } }, text),
      sendButtons(text, 'Family Flow'),
      h('p', { class: 'faint small', style: { margin: 0 } }, 'Forgot the password? Password reset by email isn’t set up yet — the owner can remove them and send a new invitation.')),
  });
}

async function invite(role) {
  let people = [];
  try { people = (await api('GET', '/api/household/people')).people; } catch { /* ignore */ }
  const linked = new Set(people.map((p) => p.member_id).filter(Boolean));
  const free = membersList().filter((m) => !linked.has(m.id) && (role === 'child' ? m.kind === 'child' : true));
  const prof = h('select', { class: 'input' }, h('option', { value: '' }, 'Let them choose when they join'), free.map((m) => h('option', { value: m.id }, m.name)));
  const s = sheet({
    title: role === 'adult' ? 'Invite an adult' : 'Invite a child',
    body: h('div', null, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Who is this for?'), prof,
      h('p', { class: 'hint' }, 'Pick their profile (e.g. Mom for Hayley) so they’re set up as soon as they join.'))),
    foot: [h('button', { type: 'button', class: 'btn', onclick: () => s.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => { s.close(); createInvite(role, prof.value || null); } }, 'Create link')],
  });
}
async function createInvite(role, memberId) {
  const who = memberId && member(memberId);
  try {
    const r = await api('POST', '/api/invites', memberId ? { role, memberId } : { role });
    sheet({
      title: 'Invitation link',
      body: h('div', { class: 'stack', style: { padding: '8px 0' } },
        h('p', { class: 'muted' }, `Anyone with this link can join ${state.household.name} as ${role === 'adult' ? 'an adult' : 'a child'}${who ? ` — they’ll be ${who.name}` : ''}. It works once and expires in 7 days.`),
        h('code', { class: 'copy' }, r.url),
        sendButtons(`Join ${state.household.name} on Family Flow: ${r.url}\nOn iPhone: open it in Safari, create your account, then tap Share → Add to Home Screen.`, 'Join our family on Family Flow')),
    });
  } catch (e) { toast(errorText(e), { bad: true }); }
}
function personEditor(p, rerender) {
  const role = h('select', { class: 'input' }, h('option', { value: 'owner' }, 'Owner'), h('option', { value: 'adult' }, 'Adult'), h('option', { value: 'child' }, 'Child'));
  role.value = p.role;
  const prof = h('select', { class: 'input' }, h('option', { value: '' }, 'None'), membersList().map((m) => h('option', { value: m.id }, m.name)));
  api('GET', '/api/household/people').then(({ people }) => { for (const o of prof.options) { const other = people.find((x) => x.member_id && x.member_id === o.value && x.id !== p.id); if (other) o.textContent = `${member(o.value).name} (now ${other.email || other.name}’s — will move)`; } }).catch(() => {});
  prof.value = p.member_id || '';
  const err = h('div');
  const s = sheet({
    title: p.name,
    body: h('div', null, p.email ? h('p', { class: 'muted', style: { marginTop: 0, overflowWrap: 'anywhere' } }, `🔑 Signs in as ${p.email}`) : null, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Role'), role), h('label', { class: 'field' }, h('span', { class: 'label' }, 'Their family profile'), prof, h('p', { class: 'hint' }, 'Which profile is this person — e.g. Hayley is Mom. Each profile belongs to one login.')), err),
    foot: [
      h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog(p.id === state.me.user.id ? 'Leave household?' : `Remove ${p.name}?`, 'They will no longer be able to sign in to this household. Their events stay.', 'Remove', true))) return;
        try { await api('DELETE', `/api/household/people/${p.id}`); s.close(); if (p.id === state.me.user.id) location.reload(); else rerender(); } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, p.id === state.me.user.id ? 'Leave' : 'Remove'),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        try { await api('PATCH', `/api/household/people/${p.id}`, { role: role.value, memberId: prof.value || null }); s.close(); toast('Saved'); if (p.id === state.me.user.id) location.reload(); else rerender(); } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, 'Save')],
  });
}
async function leave(p) {
  if (!(await confirmDialog('Leave household?', `You’ll lose access to ${state.household.name}.`, 'Leave', true))) return;
  try { await api('DELETE', `/api/household/people/${p.id}`); location.reload(); } catch (e) { toast(errorText(e), { bad: true }); }
}

// ---------- saved places ----------
export function PlacesView(rerender) {
  const root = h('div', { class: 'page' }, back('Saved places'), h('div', { class: 'empty' }, 'Loading…'));
  (async () => {
    try {
      const { places } = await api('GET', '/api/places/saved');
      let pick = null;
      const pi = placeInput({ label: 'Add a place', onChange: (v) => { pick = v; } });
      const nameI = h('input', { class: 'input', placeholder: 'Nickname, e.g. Home or School', maxlength: 200 });
      root.replaceChildren(back('Saved places'),
        h('p', { class: 'muted' }, 'Places you use show up first when you type a location. Starred places are always at the top.'),
        places.length ? h('div', { class: 'card' }, h('ul', { class: 'list' }, places.map((p) => h('li', null, h('div', { class: 'item' },
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': p.favorite ? 'Unstar' : 'Star', style: { color: p.favorite ? '#E9A23B' : 'var(--ink-3)' }, onclick: async () => { await api('POST', '/api/places/saved', { name: p.name, address: p.address, favorite: !p.favorite }); rerender(); } }, icon('star')),
          h('span', { class: 'grow' }, h('div', { class: 'title' }, p.name || p.address), p.name ? h('div', { class: 'meta' }, p.address) : null),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Delete ${p.name || p.address}`, onclick: async () => { await api('DELETE', `/api/places/saved/${p.id}`); rerender(); } }, icon('trash'))))))) :
          h('div', { class: 'card empty' }, 'No saved places yet.'),
        h('div', { class: 'card' }, pi.el, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Nickname (optional)'), nameI),
          h('button', { type: 'button', class: 'btn primary block', onclick: async () => {
            if (!pick || !pick.address) { toast('Pick an address from the suggestions first.'); return; }
            try { await api('POST', '/api/places/saved', { ...pick, name: nameI.value.trim() || pick.name, favorite: true }); toast('Place saved'); rerender(); } catch (e) { toast(errorText(e), { bad: true }); }
          } }, 'Save place')));
    } catch (e) { root.replaceChildren(back('Saved places'), h('div', { class: 'banner bad' }, errorText(e))); }
  })();
  return root;
}

// ---------- connected calendars (import + export) ----------
const HOWTO = {
  google: ['On a computer, open calendar.google.com.', 'Click the gear (top right) → Settings.', 'On the left, under “Settings for my calendars”, click the calendar you want.',
    'Scroll to “Integrate calendar” and copy the “Secret address in iCal format”.', 'Paste it below. (Work or school Google accounts: your administrator may have turned this off.)'],
  outlook: ['Open outlook.com (or Outlook on the web for work) and go to the calendar.', 'Settings (gear) → Calendar → Shared calendars.', 'Under “Publish a calendar”, pick the calendar and “Can view all details”, then Publish.',
    'Copy the ICS link (not the HTML one) and paste it below. (Work accounts: your IT admin may have turned publishing off.)'],
  apple: ['On iPhone: Calendar app → Calendars → tap ⓘ next to an iCloud calendar.', 'Turn on “Public Calendar” and tap Share Link → Copy.', 'Paste it below.'],
};
function sourceStatus(s) {
  const ago = s.lastOkAt ? timeAgoShort(s.lastOkAt) : null;
  if (s.status === 'error') return h('div', { class: 'banner bad', style: { margin: '6px 0 0' } }, s.error || 'Last update failed.');
  return h('div', { class: 'meta' }, `${s.eventCount} event${s.eventCount === 1 ? '' : 's'} · updated ${ago || 'never'}${s.error ? ` · ${s.error}` : ''}`);
}
function timeAgoShort(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}
function addSourceSheet(provider, rerender) {
  const url = h('input', { class: 'input', type: 'url', inputmode: 'url', autocapitalize: 'none', autocomplete: 'off', spellcheck: false, placeholder: provider === 'apple' ? 'webcal://…' : 'https://…', 'aria-label': 'Calendar link', autofocus: true });
  const who = h('select', { class: 'input' }, h('option', { value: '' }, 'Nobody in particular'), membersList().map((m) => h('option', { value: m.id }, m.name)));
  if (state.me.memberId) who.value = state.me.memberId;
  const priv = h('input', { type: 'checkbox' });
  const err = h('div');
  const btn = h('button', { type: 'button', class: 'btn primary' }, 'Connect');
  const steps = HOWTO[provider] || [];
  const s = sheet({
    title: `Bring in ${provider === 'google' ? 'Google Calendar' : provider === 'outlook' ? 'Outlook' : provider === 'apple' ? 'Apple Calendar' : 'a calendar'}`, full: true,
    body: h('div', null,
      steps.length ? h('ol', { class: 'muted small', style: { paddingLeft: '20px', margin: '10px 0' } }, steps.map((x) => h('li', { style: { margin: '4px 0' } }, x))) : h('p', { class: 'muted small' }, 'Paste a link to any calendar file (.ics or webcal://).'),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Calendar link'), url, h('p', { class: 'hint' }, 'This link is private, like a password: only you will see it here.')),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Whose events are these?'), who, h('p', { class: 'hint' }, 'Their colour is used, and overlaps with their Family Flow events are flagged.')),
      h('label', { class: 'switch field' }, h('span', null, h('span', { style: { fontWeight: 650 } }, 'Only visible to me'), h('span', { class: 'hint', style: { display: 'block', margin: 0 } }, 'Off: the whole family sees these events')), priv),
      h('p', { class: 'hint' }, 'One-way: events show in Family Flow and update about every 15 minutes. Changes are made in the original calendar.'),
      err),
    foot: [h('button', { type: 'button', class: 'btn', onclick: () => s.close() }, 'Cancel'), btn],
  });
  btn.addEventListener('click', async () => {
    if (!url.value.trim()) { err.replaceChildren(h('p', { class: 'err' }, 'Paste the calendar link first.')); return; }
    btn.disabled = true; btn.textContent = 'Checking the link…'; err.replaceChildren();
    try {
      const r = await api('POST', '/api/calendar-sources', { url: url.value.trim(), memberId: who.value || null, visibility: priv.checked ? 'private' : 'shared' });
      s.close();
      toast(`Connected “${r.source.name}” — ${r.imported} event${r.imported === 1 ? '' : 's'} imported`);
      await sync(); rerender();
    } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
    finally { btn.disabled = false; btn.textContent = 'Connect'; }
  });
}
function editSourceSheet(src, rerender) {
  const name = h('input', { class: 'input', value: src.name, maxlength: 60 });
  const who = h('select', { class: 'input' }, h('option', { value: '' }, 'Nobody in particular'), membersList().map((m) => h('option', { value: m.id }, m.name)));
  who.value = src.memberId || '';
  const priv = h('input', { type: 'checkbox', checked: src.visibility === 'private', disabled: !src.mine });
  const err = h('div');
  const s = sheet({
    title: src.name,
    body: h('div', null,
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Whose events'), who),
      h('label', { class: 'switch field' }, h('span', { style: { fontWeight: 650 } }, 'Only visible to the person who connected it'), priv),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Link'), h('code', { class: 'copy' }, src.link)),
      err),
    foot: [
      h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog('Disconnect calendar?', `Its events will be removed from Family Flow. Nothing changes in ${providerName(src.provider)}.`, 'Disconnect', true))) return;
        try { await api('DELETE', `/api/calendar-sources/${src.id}`); s.close(); toast('Disconnected'); await sync(); rerender(); } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, 'Disconnect'),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        try { await api('PATCH', `/api/calendar-sources/${src.id}`, { name: name.value.trim() || src.name, memberId: who.value || null, visibility: priv.checked ? 'private' : 'shared' }); s.close(); await sync(); rerender(); } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, 'Save')],
  });
}

function connectAccountSheet(provider) {
  const who = h('select', { class: 'input' }, h('option', { value: '' }, 'Nobody in particular'), membersList().map((m) => h('option', { value: m.id }, m.name)));
  if (state.me.memberId) who.value = state.me.memberId;
  const priv = h('input', { type: 'checkbox' });
  const name = provider === 'google' ? 'Google' : 'Microsoft';
  const go = h('button', { type: 'button', class: 'btn primary' }, `Continue to ${name}`);
  const s = sheet({
    title: `Sign in with ${name}`,
    body: h('div', null,
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Whose calendar is it?'), who),
      h('label', { class: 'switch field' }, h('span', null, h('span', { style: { fontWeight: 650 } }, 'Only visible to me'), h('span', { class: 'hint', style: { display: 'block', margin: 0 } }, 'Off: the whole family sees these events')), priv),
      h('p', { class: 'hint' }, `You’ll sign in on ${name}’s own page and allow read-only access. Family Flow never sees your password and can’t change your calendar.`)),
    foot: [h('button', { type: 'button', class: 'btn', onclick: () => s.close() }, 'Cancel'), go],
  });
  go.addEventListener('click', () => { go.disabled = true; startAccount(provider, { memberId: who.value || null, visibility: priv.checked ? 'private' : 'shared' }).finally(() => { go.disabled = false; }); });
}
async function startAccount(provider, body) {
  try {
    const r = await api('POST', `/api/calendar-accounts/${provider}/start`, body);
    location.href = r.url; // full-page redirect; works inside the home-screen app too
  } catch (e) { toast(errorText(e), { bad: true }); }
}
async function chooseCalendarsSheet(src, rerender, justConnected = false) {
  let cals;
  try { cals = (await api('GET', `/api/calendar-sources/${src.id}/calendars`)).calendars; } catch (e) { toast(errorText(e), { bad: true }); return; }
  const picked = new Set(cals.filter((c) => c.selected).map((c) => c.id));
  const listEl = h('ul', { class: 'list' });
  const render = () => listEl.replaceChildren(...cals.map((c) => h('li', null, h('label', { class: 'item', style: { cursor: 'pointer' } },
    h('input', { type: 'checkbox', checked: picked.has(c.id), style: { width: '22px', height: '22px' }, onchange: (e) => { if (e.target.checked) picked.add(c.id); else picked.delete(c.id); } }),
    h('span', { class: 'grow' }, h('div', { class: 'title' }, c.name), c.primary ? h('div', { class: 'meta' }, 'Main calendar') : null)))));
  render();
  const save = h('button', { type: 'button', class: 'btn primary' }, 'Save');
  const s = sheet({
    title: justConnected ? 'Which calendars should show?' : 'Choose calendars',
    body: h('div', null, h('p', { class: 'muted small' }, src.accountEmail || ''), listEl),
    foot: [h('button', { type: 'button', class: 'btn', onclick: () => s.close() }, justConnected ? 'Keep main only' : 'Cancel'), save],
  });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const r = await api('POST', `/api/calendar-sources/${src.id}/calendars`, { calendars: cals.filter((c) => picked.has(c.id)).map(({ id, name }) => ({ id, name })) });
      s.close(); toast(r.ok ? 'Calendars updated' : r.sync.error, { bad: !r.ok }); await sync(); rerender();
    } catch (e) { toast(errorText(e), { bad: true }); } finally { save.disabled = false; }
  });
}

export function SyncView(rerender) {
  const root = h('div', { class: 'page' }, back(), h('div', { class: 'empty' }, 'Loading…'));
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  if (qs.has('connected') || qs.has('error')) history.replaceState(null, '', '#/more/sync');
  (async () => {
    if (qs.get('error')) {
      const e = qs.get('error');
      toast(e === 'denied' ? 'Sign-in was cancelled — nothing was connected.' : e === 'expired' || e === 'session' ? 'That sign-in took too long or was opened in another browser. Please try again from this screen.' : e, { bad: true, ms: 8000 });
    }
    try {
      const [cs, feed] = await Promise.all([api('GET', '/api/calendar-sources'), api('GET', '/api/calendar-feed')]);
      state.sources = new Map(cs.sources.map((x) => [x.id, x]));
      const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feed.webcal)}`;
      const f = state.me.features || {};
      const provIcon = (p) => h('span', { class: 'avatar', '--c': { google: '#4285F4', outlook: '#0F6CBD', apple: '#555' }[p] || 'var(--accent)' }, { google: 'G', outlook: 'O', apple: '' }[p] || '⇣');
      if (qs.get('connected')) {
        const src = state.sources.get(qs.get('connected'));
        toast(`Connected — ${qs.get('count') || 0} events imported`);
        await sync();
        if (src && src.calendars) setTimeout(() => chooseCalendarsSheet(src, rerender, true), 300);
      }
      root.replaceChildren(back(),
        h('div', { class: 'card' },
          h('h2', null, 'Bring calendars into Family Flow'),
          cs.sources.length ? h('ul', { class: 'list' }, cs.sources.map((s) => h('li', null, h('div', { class: 'item' },
            provIcon(s.provider),
            h('span', { class: 'grow' }, h('div', { class: 'title' }, s.name, s.visibility === 'private' ? ' 🔒' : '', member(s.memberId) ? h('span', { class: 'faint' }, ` · ${member(s.memberId).name}`) : null), sourceStatus(s),
              s.kind !== 'ics' && s.calendars ? h('div', { class: 'meta' }, `Showing: ${s.calendars.map((x) => x.name).join(', ') || 'no calendars'}`) : null,
              s.kind !== 'ics' && s.mine ? h('div', { class: 'row', style: { gap: '6px', marginTop: '6px' } },
                h('button', { type: 'button', class: 'btn sm', onclick: () => chooseCalendarsSheet(s, rerender) }, 'Choose calendars'),
                s.status === 'error' ? h('button', { type: 'button', class: 'btn sm primary', onclick: () => startAccount(s.kind, { memberId: s.memberId, visibility: s.visibility }) }, 'Reconnect') : null) : null),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Update ${s.name} now`, onclick: async (e) => {
              e.currentTarget.disabled = true;
              try { const r = await api('POST', `/api/calendar-sources/${s.id}/sync`, {}); toast(r.sync.ok ? `${s.name} is up to date` : r.sync.error, { bad: !r.sync.ok }); await sync(); rerender(); } catch (er) { toast(errorText(er), { bad: true }); }
            } }, icon('sync')),
            (s.mine || isOwner()) ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Settings for ${s.name}`, onclick: () => editSourceSheet(s, rerender) }, icon('edit')) : null)))) :
            h('p', { class: 'muted small', style: { marginTop: 0 } }, 'See work, school or personal calendars next to your family’s plans. Overlaps are flagged automatically.'),
          canEdit() ? h('div', { class: 'stack', style: { marginTop: '10px' } },
            f.googleCalendar ? h('button', { type: 'button', class: 'btn primary block', onclick: () => connectAccountSheet('google') }, provIcon('google'), 'Sign in with Google') : null,
            f.microsoftCalendar ? h('button', { type: 'button', class: 'btn primary block', onclick: () => connectAccountSheet('microsoft') }, provIcon('outlook'), 'Sign in with Microsoft (Outlook)') : null,
            h('details', { open: !(f.googleCalendar || f.microsoftCalendar) }, h('summary', { class: 'muted small', style: { padding: '8px 0' } }, f.googleCalendar || f.microsoftCalendar ? 'Other ways: paste a calendar link' : 'Connect with a calendar link'),
              h('div', { class: 'stack' },
                h('button', { type: 'button', class: 'btn block', onclick: () => addSourceSheet('google', rerender) }, 'Google Calendar link'),
                h('button', { type: 'button', class: 'btn block', onclick: () => addSourceSheet('outlook', rerender) }, 'Outlook / Microsoft 365 link'),
                h('button', { type: 'button', class: 'btn block', onclick: () => addSourceSheet('apple', rerender) }, 'Apple iCloud calendar link'),
                h('button', { type: 'button', class: 'btn ghost block', onclick: () => addSourceSheet('ics', rerender) }, 'Other calendar link (.ics)')))) : null,
          h('p', { class: 'hint' }, `One-way and read-only: updates about every ${cs.refreshMinutes} minutes.`)),
        canEdit() ? h('div', { class: 'card' },
          h('h2', null, 'Show Family Flow in other calendars'),
          h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Adds your shared Family Flow events (not private or imported ones) to Google, Apple or Outlook. One-way.'),
          h('div', { class: 'stack' },
            h('a', { class: 'btn block', href: feed.webcal }, 'Add to Apple Calendar'),
            h('a', { class: 'btn block', href: google, target: '_blank', rel: 'noopener' }, 'Add to Google Calendar'),
            h('details', null, h('summary', { class: 'muted small', style: { padding: '8px 0' } }, 'Copy the link (Outlook, others)'), h('code', { class: 'copy' }, feed.url), h('button', { type: 'button', class: 'btn sm', style: { marginTop: '8px' }, onclick: () => copyText(feed.url) }, icon('copy'), 'Copy link'))),
          isOwner() ? h('button', { type: 'button', class: 'btn ghost block', style: { marginTop: '8px' }, onclick: async () => { if (await confirmDialog('Make a new link?', 'Existing subscriptions in other calendars will stop updating and need to be added again.', 'Make new link', true)) { await api('POST', '/api/calendar-feed/rotate', {}); toast('New link created'); rerender(); } } }, 'Link leaked? Make a new one') : null) : null);
    } catch (e) { root.replaceChildren(back(), h('div', { class: 'banner bad' }, errorText(e))); }
  })();
  return root;
}

// ---------- notifications ----------
function urlB64ToUint8(b64) { const pad = '='.repeat((4 - (b64.length % 4)) % 4); const s = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
export function NotificationsView(rerender) {
  const root = h('div', { class: 'page' }, back('Notifications'));
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const status = h('div');
  const card = h('div', { class: 'card' }, h('h2', null, 'Reminders on this device'), status);
  const actT = h('input', { type: 'checkbox', checked: state.me.notifyActivity !== false });
  actT.addEventListener('change', async () => {
    try { await api('PATCH', '/api/me/prefs', { notifyActivity: actT.checked }); state.me.notifyActivity = actT.checked; toast(actT.checked ? 'Family updates are on' : 'Family updates are off'); }
    catch (e) { actT.checked = !actT.checked; toast(errorText(e), { bad: true }); }
  });
  root.append(card,
    h('div', { class: 'card' }, h('h2', null, 'Family updates'),
      h('label', { class: 'switch field', style: { marginBottom: 0 } }, h('span', null, h('span', { style: { fontWeight: 650 } }, 'Tell me when the family changes things'),
        h('span', { class: 'hint', style: { display: 'block', margin: 0 } }, 'When someone adds, moves or cancels an event you can see, or assigns you a task.')), actT)),
    h('div', { class: 'card' }, h('h2', null, 'Always in your inbox'), h('p', { class: 'muted small', style: { margin: 0 } }, 'Every reminder and update also appears in the Inbox tab, even if phone notifications are off.')));
  (async () => {
    if (!supported) {
      status.replaceChildren(h('div', { class: 'banner warn' }, ios && !standalone
        ? 'On iPhone and iPad, notifications work after you add Family Flow to your Home Screen: tap the Share button in Safari, then “Add to Home Screen”, then open it from there.'
        : 'This browser doesn’t support web notifications.'));
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const perm = Notification.permission;
    if (perm === 'denied') { status.replaceChildren(h('div', { class: 'banner bad' }, 'Notifications are blocked for this site. Turn them on in your browser or phone settings, then come back.')); return; }
    if (sub) {
      status.replaceChildren(h('div', { class: 'banner good' }, icon('check'), 'On for this device.'),
        h('div', { class: 'two' },
          h('button', { type: 'button', class: 'btn', onclick: async () => {
            try { const r = await api('POST', '/api/push/test', {}); r.delivered ? toast('Test sent — it should arrive in a few seconds.') : toast(`Push service refused: ${r.results.map((x) => x.error).join('; ')}`, { bad: true }); } catch (e) { toast(errorText(e), { bad: true }); }
          } }, 'Send a test'),
          h('button', { type: 'button', class: 'btn', onclick: async () => { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); rerender(); } }, 'Turn off')));
    } else {
      status.replaceChildren(h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Get a notification on this phone or computer when a reminder is due or someone in the family adds or changes something.'),
        h('button', { type: 'button', class: 'btn primary block', onclick: async () => {
          try {
            const p = await Notification.requestPermission();
            if (p !== 'granted') { toast('Permission was not granted.'); rerender(); return; }
            const { publicKey } = await api('GET', '/api/push/key');
            const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(publicKey) });
            await api('POST', '/api/push/subscribe', s.toJSON());
            toast('Notifications are on'); rerender();
          } catch (e) { toast(e.message || 'Could not turn on notifications.', { bad: true }); }
        } }, icon('bell'), 'Turn on notifications'));
    }
  })().catch((e) => status.replaceChildren(h('div', { class: 'banner bad' }, String(e.message || e))));
  return root;
}

// ---------- household ----------
export function HouseholdView(rerender) {
  const hh = state.household;
  const name = h('input', { class: 'input', value: hh.name, maxlength: 60, disabled: !isOwner() });
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [hh.timezone];
  const tzSel = h('select', { class: 'input', disabled: !isOwner() }, zones.map((z) => h('option', { value: z }, z.replace(/_/g, ' '))));
  tzSel.value = hh.timezone;
  const holSel = h('select', { class: 'input', disabled: !isOwner() },
    h('option', { value: 'auto' }, `Automatic (${isUsZone(hh.timezone) ? 'United States' : 'none for this time zone'})`),
    HOLIDAY_REGIONS.map((r) => h('option', { value: r.id }, r.name)),
    h('option', { value: 'none' }, 'Don’t show holidays'));
  holSel.value = hh.holidaysSetting || 'auto';
  const others = state.me.households.filter((x) => x.id !== hh.id);
  return h('div', { class: 'page' }, back('Household'),
    h('div', { class: 'card' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Home time zone'), tzSel, h('p', { class: 'hint' }, 'New events use this zone. Changing it doesn’t move existing events.')),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Holidays on the calendar'), holSel, h('p', { class: 'hint' }, 'Federal holidays (with the weekday off when one falls on a weekend) plus popular days like Mother’s Day and Halloween.')),
      isOwner() ? h('button', { type: 'button', class: 'btn primary block', onclick: async () => {
        try { await api('PATCH', '/api/household', { name: name.value.trim(), timezone: tzSel.value, holidays: holSel.value }); await sync({ full: true }); toast('Saved'); rerender(); } catch (e) { toast(errorText(e), { bad: true }); }
      } }, 'Save') : h('p', { class: 'hint' }, 'Only owners can change these.')),
    h('div', { class: 'card' }, h('h2', null, 'Other households'),
      others.length ? h('ul', { class: 'list' }, others.map((o) => h('li', null, h('button', { type: 'button', class: 'item', onclick: async () => { await api('POST', '/api/households/switch', { householdId: o.id }); location.hash = '#/today'; location.reload(); } },
        h('span', { class: 'grow' }, h('div', { class: 'title' }, o.name), h('div', { class: 'meta' }, o.role)), h('span', { class: 'btn ghost sm' }, 'Switch'))))) : h('p', { class: 'muted small', style: { marginTop: 0 } }, 'You’re only in this household.'),
      h('button', { type: 'button', class: 'btn block', onclick: async () => {
        const n = prompt('Name for the new household');
        if (!n || !n.trim()) return;
        try { await api('POST', '/api/households', { name: n.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); location.hash = '#/today'; location.reload(); } catch (e) { toast(errorText(e), { bad: true }); }
      } }, 'Create another household')));
}

// ---------- data ----------
export function DataView() {
  return h('div', { class: 'page' }, back('Your data'),
    h('div', { class: 'card' }, h('h2', null, 'Export'), h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Download everything in this household (profiles, events, lists, tasks, places) as a JSON file.'),
      h('button', { type: 'button', class: 'btn block', onclick: async () => {
        try {
          const data = await api('GET', '/api/household/export');
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `family-flow-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.append(a); a.click(); a.remove();
        } catch (e) { toast(errorText(e), { bad: true }); }
      } }, icon('download'), 'Download export')),
    h('div', { class: 'card' }, h('h2', null, 'How your data is kept'),
      h('ul', { class: 'muted small', style: { margin: 0, paddingLeft: '18px' } },
        h('li', null, 'Stored in a Cloudflare D1 database (with 30-day point-in-time recovery) and backed up daily to separate storage, with each backup read back to verify it.'),
        h('li', null, 'A copy is cached on this device so the app opens offline. Changes made offline sync when you reconnect.'),
        h('li', null, 'Passwords are stored only as salted hashes.'))),
    isOwner() ? h('div', { class: 'card' }, h('h2', null, 'Delete household'), h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Permanently deletes this household and everything in it for everyone. This can’t be undone.'),
      h('button', { type: 'button', class: 'btn danger block', onclick: async () => {
        const typed = prompt(`Type the household name (“${state.household.name}”) to delete it permanently.`);
        if (typed === null) return;
        try { await api('DELETE', '/api/household', { confirm: typed }); await clearLocalData(); location.hash = '#/today'; location.reload(); } catch (e) { toast(errorText(e), { bad: true }); }
      } }, 'Delete household…')) : null);
}

// ---------- diagnostics ----------
export function DiagnosticsView(rerender) {
  const root = h('div', { class: 'page' }, back('Diagnostics'), h('div', { class: 'empty' }, 'Running checks…'));
  (async () => {
    try {
      const d = await api('GET', '/api/diagnostics');
      const label = { ok: 'OK', warn: 'CHECK', fail: 'FAIL' };
      root.replaceChildren(back('Diagnostics'),
        h('div', { class: `banner ${d.overall === 'ok' ? 'good' : d.overall === 'warn' ? 'warn' : 'bad'}` },
          d.overall === 'ok' ? 'All checks passed just now.' : d.overall === 'warn' ? 'Working, with some things to check.' : 'Something needs attention.'),
        h('div', { class: 'card' }, d.checks.map((c) => h('div', { class: 'diag' }, h('span', { class: `st ${c.status}` }, label[c.status]),
          h('div', { class: 'grow' }, h('div', { style: { fontWeight: 650 } }, c.name), h('div', { class: 'muted small' }, c.detail), h('div', { class: 'faint small' }, `${c.ms} ms`))))),
        h('div', { class: 'card' }, h('h2', null, 'This device'),
          h('div', { class: 'muted small' }, `Online: ${state.online ? 'yes' : 'no'} · Last sync: ${state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleTimeString() : 'never'} · Waiting to sync: ${state.outbox.length} · Sync position: ${state.seq}`),
          h('div', { class: 'two', style: { marginTop: '10px' } },
            h('button', { type: 'button', class: 'btn', onclick: async () => { await sync({ full: true }); toast(state.syncError ? `Sync failed: ${state.syncError}` : 'Re-downloaded everything'); rerender(); } }, 'Full re-sync'),
            h('button', { type: 'button', class: 'btn', onclick: async () => { try { const r = await api('POST', '/api/diagnostics/backup', {}); toast(r.ok ? `Backup verified (${(r.bytes / 1024).toFixed(1)} KB)` : `Backup failed: ${r.error}`, { bad: !r.ok }); rerender(); } catch (e) { toast(errorText(e), { bad: true }); } } }, 'Back up now'))),
        h('p', { class: 'faint small' }, `Checked ${new Date(d.checkedAt).toLocaleString()}`),
        h('button', { type: 'button', class: 'btn block', onclick: rerender }, 'Run checks again'));
    } catch (e) { root.replaceChildren(back('Diagnostics'), h('div', { class: 'banner bad' }, errorText(e))); }
  })();
  return root;
}

// ---------- account ----------
export function AccountView() {
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const nxt = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8 });
  return h('div', { class: 'page' }, back('Account'),
    h('div', { class: 'card' }, h('div', { class: 'title', style: { fontWeight: 700 } }, state.me.user.name), h('div', { class: 'muted' }, state.me.user.email),
      h('button', { type: 'button', class: 'btn block', style: { marginTop: '12px' }, onclick: async () => { await api('POST', '/api/auth/logout', {}).catch(() => {}); await clearLocalData(); location.hash = ''; location.reload(); } }, 'Sign out')),
    h('div', { class: 'card' }, h('h2', null, 'Change password'),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Current password'), cur),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'New password (8+ characters)'), nxt),
      h('button', { type: 'button', class: 'btn primary block', onclick: async () => {
        try { await api('POST', '/api/me/password', { current: cur.value, next: nxt.value }); cur.value = ''; nxt.value = ''; toast('Password changed. Other devices were signed out.'); } catch (e) { toast(errorText(e), { bad: true }); }
      } }, 'Change password')),
    h('div', { class: 'card' }, h('h2', null, 'Delete account'),
      h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Deletes your login. Household data stays for the other members. If you’re the only owner, delete the household or make someone else owner first.'),
      h('button', { type: 'button', class: 'btn danger block', onclick: async () => {
        const pw = prompt('Enter your password to permanently delete your account.');
        if (!pw) return;
        try { await api('DELETE', '/api/me', { password: pw }); await clearLocalData(); location.hash = ''; location.reload(); } catch (e) { toast(errorText(e), { bad: true }); }
      } }, 'Delete my account…')));
}
