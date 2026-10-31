// "More" area: tasks & lists, family profiles, people & invites, places, calendar sync, notifications, household, data, diagnostics, account.
import { h, icon, toast, sheet, confirmDialog, copyText, initials } from './ui.js';
import { api, state, mutate, membersList, listsList, member, sync, clearLocalData, emit } from './store.js';
import { openTaskEditor, placeInput, canEdit, errorText, providerName } from './editors.js';
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
      item('#/more/people', 'user', 'People & invites', 'Who can sign in to this household'),
      item('#/more/places', 'pin', 'Saved places', 'Home, school, favourite spots'))),
    h('div', { class: 'card' }, h('ul', { class: 'list' },
      item('#/more/notifications', 'bell', 'Notifications', 'Reminders on this device'),
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
  return h('div', { class: 'page' }, back('Tasks & lists'),
    h('div', { class: 'filter' }, lists.map((l) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(l.id === currentList), onclick: () => { currentList = l.id; rerender(); } }, l.name)),
      canEdit() ? h('button', { type: 'button', class: 'chip', onclick: () => listEditor(null, rerender) }, '+ New list') : null),
    list ? h('div', { class: 'card' },
      h('h2', null, list.name, h('span', { class: 'spacer' }), canEdit() ? h('button', { type: 'button', class: 'btn ghost sm', onclick: () => listEditor(list, rerender) }, 'Edit list') : null),
      canEdit() ? h('div', { class: 'quick-add' }, quick, h('button', { type: 'button', class: 'btn primary', onclick: addQuick, 'aria-label': 'Add' }, icon('plus'))) : null,
      open.length ? h('ul', { class: 'list', style: { marginTop: '8px' } }, open.map((t) => taskRow(t))) : h('div', { class: 'empty' }, 'Nothing here yet.'),
      done.length ? [h('div', { class: 'section-title' }, 'Done'), h('ul', { class: 'list' }, done.map((t) => taskRow(t)))] : null) : null,
    canEdit() ? h('button', { type: 'button', class: 'btn block', onclick: () => openTaskEditor({ listId: currentList }) }, 'Add with details (due date, person, reminder)') : null);
}
function listEditor(l, rerender) {
  const name = h('input', { class: 'input', value: l ? l.name : '', maxlength: 60, autofocus: true });
  const kind = h('select', { class: 'input', disabled: !!l }, h('option', { value: 'todo' }, 'To-do list'), h('option', { value: 'shopping' }, 'Shopping list'));
  kind.value = l ? l.kind : 'todo';
  const err = h('div');
  const s = sheet({
    title: l ? 'Edit list' : 'New list',
    body: h('div', null, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name), h('label', { class: 'field' }, h('span', { class: 'label' }, 'Type'), kind), err),
    foot: [
      l ? h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog('Delete list?', `“${l.name}” and all its items will be deleted.`, 'Delete', true))) return;
        try { await mutate({ method: 'DELETE', path: `/api/lists/${l.id}`, kind: 'lists', optimistic: { kind: 'lists', id: l.id, remove: true }, offlineOk: false }); await sync(); s.close(); rerender(); } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, 'Delete') : h('button', { type: 'button', class: 'btn', onclick: () => s.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) return;
        try {
          if (l) await mutate({ method: 'PATCH', path: `/api/lists/${l.id}`, body: { name: name.value.trim(), version: l.version }, kind: 'lists', offlineOk: false });
          else { const r = await mutate({ method: 'POST', path: '/api/lists', body: { name: name.value.trim(), kind: kind.value }, kind: 'lists', offlineOk: false }); currentList = r.list.id; }
          s.close(); rerender();
        } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, 'Save')],
  });
}

// ---------- family profiles ----------
export function FamilyView(rerender) {
  return h('div', { class: 'page' }, back('Family profiles'),
    h('p', { class: 'muted' }, 'Profiles are who events and tasks are for. They don’t need their own login — invite people separately if they should sign in.'),
    h('div', { class: 'card' }, h('ul', { class: 'list' }, membersList().map((m) => h('li', null,
      h('button', { type: 'button', class: 'item', onclick: () => memberEditor(m, rerender), disabled: !canEdit() },
        h('span', { class: 'avatar', '--c': m.color }, initials(m.name)),
        h('span', { class: 'grow' }, h('div', { class: 'title' }, m.name), h('div', { class: 'meta' }, m.kind === 'child' ? 'Child' : 'Adult')),
        canEdit() ? icon('chev', 'chev') : null))))),
    canEdit() ? h('button', { type: 'button', class: 'btn block primary', onclick: () => memberEditor(null, rerender) }, icon('plus'), 'Add a profile') : null);
}
function memberEditor(m, rerender) {
  const name = h('input', { class: 'input', value: m ? m.name : '', maxlength: 40, autofocus: true, placeholder: 'e.g. Grandma' });
  let color = m ? m.color : COLORS.find((c) => !membersList().some((x) => x.color === c)) || COLORS[0];
  const sw = h('div', { class: 'colors', role: 'radiogroup', 'aria-label': 'Colour' });
  const renderSw = () => sw.replaceChildren(...COLORS.map((c) => h('button', { type: 'button', class: 'swatch', '--c': c, role: 'radio', 'aria-checked': String(c === color), 'aria-label': c, onclick: () => { color = c; renderSw(); } })));
  renderSw();
  const kind = h('select', { class: 'input' }, h('option', { value: 'adult' }, 'Adult'), h('option', { value: 'child' }, 'Child'));
  kind.value = m ? m.kind : 'child';
  const err = h('div');
  const s = sheet({
    title: m ? 'Edit profile' : 'New profile',
    body: h('div', null, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name), h('div', { class: 'field' }, h('span', { class: 'label' }, 'Colour'), sw),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Type'), kind), err),
    foot: [
      m ? h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog(`Remove ${m.name}?`, 'They’ll be removed from events and tasks. The events themselves stay.', 'Remove', true))) return;
        try { await mutate({ method: 'DELETE', path: `/api/members/${m.id}`, kind: 'members', optimistic: { kind: 'members', id: m.id, remove: true }, offlineOk: false }); s.close(); rerender(); } catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
      } }, 'Remove') : h('button', { type: 'button', class: 'btn', onclick: () => s.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) { err.replaceChildren(h('p', { class: 'err' }, 'Enter a name.')); return; }
        const body = { name: name.value.trim(), color, kind: kind.value };
        try {
          if (m) await mutate({ method: 'PATCH', path: `/api/members/${m.id}`, body: { ...body, version: m.version }, kind: 'members', offlineOk: false });
          else await mutate({ method: 'POST', path: '/api/members', body, kind: 'members', offlineOk: false });
          s.close(); rerender();
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
        h('div', { class: 'card' }, h('ul', { class: 'list' }, people.map((p) => h('li', null, h('div', { class: 'item' },
          h('span', { class: 'avatar', '--c': (member(p.member_id) || { color: 'var(--ink-3)' }).color }, initials(p.name)),
          h('span', { class: 'grow' }, h('div', { class: 'title' }, p.name, p.id === state.me.user.id ? ' (you)' : ''), h('div', { class: 'meta' }, [roleName[p.role], p.email, member(p.member_id) ? `profile: ${member(p.member_id).name}` : null].filter(Boolean).join(' · '))),
          isOwner() ? h('button', { type: 'button', class: 'btn ghost sm', onclick: () => personEditor(p, rerender) }, 'Edit') :
            p.id === state.me.user.id ? h('button', { type: 'button', class: 'btn ghost sm', onclick: () => leave(p) }, 'Leave') : null))))),
        isOwner() ? h('div', { class: 'card' }, h('h2', null, 'Invite someone'),
          h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Creates a one-time link that works for 7 days. Send it however you like (text, email).'),
          h('div', { class: 'two' },
            h('button', { type: 'button', class: 'btn', onclick: () => invite('adult') }, 'Invite an adult'),
            h('button', { type: 'button', class: 'btn', onclick: () => invite('child') }, 'Invite a child'))) : null);
    } catch (e) { root.replaceChildren(back('People & invites'), h('div', { class: 'banner bad' }, errorText(e))); }
  })();
  return root;
}
async function invite(role) {
  try {
    const r = await api('POST', '/api/invites', { role });
    sheet({
      title: 'Invitation link',
      body: h('div', { class: 'stack', style: { padding: '8px 0' } },
        h('p', { class: 'muted' }, `Anyone with this link can join ${state.household.name} as ${role === 'adult' ? 'an adult' : 'a child'}. It works once and expires in 7 days.`),
        h('code', { class: 'copy' }, r.url),
        h('div', { class: 'two' },
          h('button', { type: 'button', class: 'btn', onclick: () => copyText(r.url) }, icon('copy'), 'Copy'),
          navigator.share ? h('button', { type: 'button', class: 'btn primary', onclick: () => navigator.share({ title: 'Join our family on Family Flow', text: `Join ${state.household.name} on Family Flow`, url: r.url }).catch(() => {}) }, icon('share'), 'Share') : null)),
    });
  } catch (e) { toast(errorText(e), { bad: true }); }
}
function personEditor(p, rerender) {
  const role = h('select', { class: 'input' }, h('option', { value: 'owner' }, 'Owner'), h('option', { value: 'adult' }, 'Adult'), h('option', { value: 'child' }, 'Child'));
  role.value = p.role;
  const prof = h('select', { class: 'input' }, h('option', { value: '' }, 'None'), membersList().map((m) => h('option', { value: m.id }, m.name)));
  prof.value = p.member_id || '';
  const err = h('div');
  const s = sheet({
    title: p.name,
    body: h('div', null, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Role'), role), h('label', { class: 'field' }, h('span', { class: 'label' }, 'Their family profile'), prof), err),
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

export function SyncView(rerender) {
  const root = h('div', { class: 'page' }, back(), h('div', { class: 'empty' }, 'Loading…'));
  (async () => {
    try {
      const [cs, feed] = await Promise.all([api('GET', '/api/calendar-sources'), api('GET', '/api/calendar-feed')]);
      state.sources = new Map(cs.sources.map((x) => [x.id, x]));
      const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feed.webcal)}`;
      const provIcon = (p) => h('span', { class: 'avatar', '--c': { google: '#4285F4', outlook: '#0F6CBD', apple: '#555' }[p] || 'var(--accent)' }, { google: 'G', outlook: 'O', apple: '' }[p] || '⇣');
      root.replaceChildren(back(),
        h('div', { class: 'card' },
          h('h2', null, 'Bring calendars into Family Flow'),
          cs.sources.length ? h('ul', { class: 'list' }, cs.sources.map((s) => h('li', null, h('div', { class: 'item' },
            provIcon(s.provider),
            h('span', { class: 'grow' }, h('div', { class: 'title' }, s.name, s.visibility === 'private' ? ' 🔒' : '', member(s.memberId) ? h('span', { class: 'faint' }, ` · ${member(s.memberId).name}`) : null), sourceStatus(s)),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Update ${s.name} now`, onclick: async (e) => {
              e.currentTarget.disabled = true;
              try { const r = await api('POST', `/api/calendar-sources/${s.id}/sync`, {}); toast(r.sync.ok ? `${s.name} is up to date` : r.sync.error, { bad: !r.sync.ok }); await sync(); rerender(); } catch (er) { toast(errorText(er), { bad: true }); }
            } }, icon('sync')),
            (s.mine || isOwner()) ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Settings for ${s.name}`, onclick: () => editSourceSheet(s, rerender) }, icon('edit')) : null)))) :
            h('p', { class: 'muted small', style: { marginTop: 0 } }, 'See work, school or personal calendars next to your family’s plans. Overlaps are flagged automatically.'),
          canEdit() ? h('div', { class: 'stack', style: { marginTop: '10px' } },
            h('button', { type: 'button', class: 'btn block', onclick: () => addSourceSheet('google', rerender) }, 'Add Google Calendar'),
            h('button', { type: 'button', class: 'btn block', onclick: () => addSourceSheet('outlook', rerender) }, 'Add Outlook / Microsoft 365'),
            h('button', { type: 'button', class: 'btn block', onclick: () => addSourceSheet('apple', rerender) }, 'Add Apple iCloud calendar'),
            h('button', { type: 'button', class: 'btn ghost block', onclick: () => addSourceSheet('ics', rerender) }, 'Other calendar link (.ics)')) : null,
          h('p', { class: 'hint' }, `One-way and read-only: updates about every ${cs.refreshMinutes} minutes. Google and Outlook can take a while to publish changes to these links.`)),
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
  root.append(card, h('div', { class: 'card' }, h('h2', null, 'Always in your inbox'), h('p', { class: 'muted small', style: { margin: 0 } }, 'Every reminder also appears in the Inbox tab, even if phone notifications are off.')));
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
      status.replaceChildren(h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Get a notification on this phone or computer when a reminder is due.'),
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
  const others = state.me.households.filter((x) => x.id !== hh.id);
  return h('div', { class: 'page' }, back('Household'),
    h('div', { class: 'card' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Home time zone'), tzSel, h('p', { class: 'hint' }, 'New events use this zone. Changing it doesn’t move existing events.')),
      isOwner() ? h('button', { type: 'button', class: 'btn primary block', onclick: async () => {
        try { await api('PATCH', '/api/household', { name: name.value.trim(), timezone: tzSel.value }); await sync({ full: true }); toast('Saved'); rerender(); } catch (e) { toast(errorText(e), { bad: true }); }
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
