// App shell: boot, sign-in/sign-up/join, tab navigation, the universal Add button and voice capture.
import { h, icon, toast, sheet, closeAllSheets } from './ui.js';
import { api, state, on, sync, loadCached, startAutoSync, refreshCounts, clearLocalData, resetState } from './store.js';
import { TodayView, CalendarView, InboxView, AssistantView, assistantDraft } from './views.js';
import { MoreView, TasksView, FamilyView, PeopleView, PlacesView, SyncView, NotificationsView, HouseholdView, DataView, DiagnosticsView, AccountView } from './more.js';
import { openEventEditor, openTaskEditor, openEventDetail, errorText } from './editors.js';

const app = document.getElementById('app');
const TABS = [
  { id: 'today', label: 'Today', icon: 'today' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'assistant', label: 'Assistant', icon: 'assistant' },
  { id: 'more', label: 'More', icon: 'more' },
];
const SUB = {
  tasks: ['Tasks & lists', TasksView], family: ['Family', FamilyView], people: ['People', PeopleView], places: ['Places', PlacesView],
  sync: ['Calendar sync', SyncView], notifications: ['Notifications', NotificationsView], household: ['Household', HouseholdView],
  data: ['Your data', DataView], diagnostics: ['Diagnostics', DiagnosticsView], account: ['Account', AccountView],
};

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { tab: parts[0] || 'today', sub: parts[1] || null, arg: parts[2] || null };
}

// ---------- auth screens ----------
function authScreen(mode, invite) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const name = h('input', { class: 'input', autocomplete: 'name', maxlength: 60, required: true });
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', required: true });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', minlength: mode === 'login' ? 1 : 8, required: true });
  const hh = h('input', { class: 'input', maxlength: 60, placeholder: 'e.g. The Duque Family' });
  const err = h('div', { role: 'alert' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, mode === 'login' ? 'Sign in' : invite ? `Join ${invite.householdName}` : 'Create our family space');
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, hint ? h('p', { class: 'hint' }, hint) : null);
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.replaceChildren();
    btn.disabled = true;
    try {
      if (mode === 'login') await api('POST', '/api/auth/login', { email: email.value.trim(), password: pw.value });
      else {
        if (pw.value.length < 8) throw new Error('Use at least 8 characters for your password.');
        await api('POST', '/api/auth/signup', { name: name.value.trim(), email: email.value.trim(), password: pw.value, timezone: tz,
          ...(invite ? { inviteToken: invite.token } : { householdName: hh.value.trim() || `${name.value.trim().split(' ').slice(-1)[0]} Family` }) });
      }
      location.hash = '#/today';
      await boot();
    } catch (e2) {
      err.replaceChildren(h('div', { class: 'banner bad' }, e2.message));
    } finally { btn.disabled = false; }
  } },
  mode === 'signup' ? field('Your name', name) : null,
  field('Email', email),
  field('Password', pw, mode === 'signup' ? 'At least 8 characters.' : null),
  mode === 'signup' && !invite ? field('Family name', hh, 'You can change this later and invite others.') : null,
  err, btn);
  const other = mode === 'login'
    ? h('p', { class: 'muted', style: { textAlign: 'center' } }, 'New here? ', h('a', { href: '#/signup' }, 'Create an account'))
    : h('p', { class: 'muted', style: { textAlign: 'center' } }, 'Already have an account? ', h('a', { href: invite ? `#/join/${invite.token}/login` : '#/login' }, 'Sign in'));
  app.replaceChildren(h('main', { class: 'auth' }, h('div', { class: 'box' },
    h('img', { class: 'logo', src: '/icons/icon.svg', alt: '' }),
    h('h1', null, mode === 'login' ? 'Welcome back' : invite ? 'You’re invited' : 'Family Flow'),
    h('p', { class: 'lead' }, invite ? `Join ${invite.householdName} on Family Flow as ${invite.role === 'adult' ? 'an adult' : 'a child'}.` : mode === 'login' ? 'Sign in to your family’s calendar.' : 'One calendar, one to-do list, one assistant for the whole family.'),
    form, other)));
  setTimeout(() => (mode === 'signup' ? name : email).focus(), 30);
}

async function joinFlow(token, wantLogin) {
  let info;
  try { info = await api('GET', `/api/invites/${encodeURIComponent(token)}`); } catch (e) {
    app.replaceChildren(h('main', { class: 'auth' }, h('div', { class: 'box' }, h('h1', null, 'Invitation'), h('div', { class: 'banner bad' }, e.message), h('a', { class: 'btn block', href: '#/' }, 'Go to Family Flow'))));
    return;
  }
  const invite = { ...info, token };
  if (state.me) {
    app.replaceChildren(h('main', { class: 'auth' }, h('div', { class: 'box' }, h('h1', null, 'You’re invited'),
      h('p', { class: 'lead' }, `Join ${info.householdName} as ${info.role === 'adult' ? 'an adult' : 'a child'}? You’re signed in as ${state.me.user.email}.`),
      h('button', { class: 'btn primary block', type: 'button', onclick: async () => {
        try { await api('POST', `/api/invites/${encodeURIComponent(token)}/accept`, {}); await clearLocalData(); location.hash = '#/today'; await boot(); } catch (e) { toast(errorText(e), { bad: true }); }
      } }, `Join ${info.householdName}`),
      h('a', { class: 'btn block', href: '#/today', style: { marginTop: '10px' } }, 'Not now'))));
    return;
  }
  if (wantLogin) {
    authScreen('login');
    // after login, come back to accept
    const off = on('signed-in', () => { off(); location.hash = `#/join/${token}`; });
    return;
  }
  authScreen('signup', invite);
}

// ---------- shell ----------
let mounted = null;
function shell() {
  const header = h('header', { class: 'topbar' });
  const main = h('main', { id: 'main', tabindex: '-1' });
  const tabs = h('nav', { class: 'tabbar', 'aria-label': 'Main' });
  const fabs = h('div', { class: 'fab-group' },
    h('button', { type: 'button', class: 'fab mic', 'aria-label': 'Speak to add', onclick: () => startRecording() }, icon('mic')),
    h('button', { type: 'button', class: 'fab', 'aria-label': 'Add', onclick: () => addMenu() }, icon('plus')));
  app.replaceChildren(h('div', { class: 'shell' }, header, main), fabs, tabs);
  mounted = { header, main, tabs, fabs };
}

function render() {
  if (!state.me) return;
  if (!mounted) shell();
  const r = route();
  if (r.tab === 'join' && r.sub) { joinFlow(r.sub, false); mounted = null; return; }
  if (r.tab === 'event' && r.sub) { const ev = state.events.get(r.sub); location.hash = '#/calendar'; if (ev) setTimeout(() => openEventDetail(ev), 50); return; }
  if (r.tab === 'tasks') { location.hash = '#/more/tasks'; return; }
  const tab = TABS.find((t) => t.id === r.tab) ? r.tab : 'today';
  const rerender = () => render();
  let title = TABS.find((t) => t.id === tab).label;
  let view;
  if (tab === 'today') view = TodayView(rerender);
  else if (tab === 'calendar') view = CalendarView(rerender);
  else if (tab === 'inbox') view = InboxView(rerender);
  else if (tab === 'assistant') view = AssistantView(rerender, { startRecording });
  else if (r.sub && SUB[r.sub]) { title = SUB[r.sub][0]; view = SUB[r.sub][1](rerender); }
  else view = MoreView(rerender);
  const sub = tab === 'today' || tab === 'more' ? state.household && state.household.name : null;
  mounted.header.replaceChildren(h('h1', null, title, sub ? h('span', { class: 'sub' }, sub) : null),
    h('span', { class: 'faint small sync-status', 'aria-live': 'polite' }, state.syncing ? 'Syncing…' : !state.online ? 'Offline' : ''));
  const keepScroll = mounted.lastTab === `${tab}/${r.sub}` ? window.scrollY : 0;
  const ae = document.activeElement;
  const refocus = ae && mounted.main.contains(ae) && ae.getAttribute('aria-label');
  mounted.main.replaceChildren(view);
  if (refocus) { const el = mounted.main.querySelector(`[aria-label="${CSS.escape(refocus)}"]`); if (el) el.focus({ preventScroll: true }); }
  if (mounted.lastTab !== `${tab}/${r.sub}`) window.scrollTo(0, 0); else window.scrollTo(0, keepScroll);
  mounted.lastTab = `${tab}/${r.sub}`;
  mounted.fabs.hidden = tab === 'assistant';
  renderTabs(tab);
  document.title = `${title} · Family Flow`;
}
function updateBadges() { if (mounted) renderTabs(mounted.lastTab.split('/')[0]); }
function renderTabs(tab) {
  const badge = { inbox: state.proposalsCount + state.unread };
  mounted.tabs.replaceChildren(...TABS.map((t) => h('a', { class: 'tab', href: `#/${t.id}`, 'aria-current': t.id === tab ? 'page' : null },
    icon(t.icon), t.label, badge[t.id] ? h('span', { class: 'badge', 'aria-label': `${badge[t.id]} new` }, String(badge[t.id] > 99 ? '99+' : badge[t.id])) : null)));
}

function addMenu() {
  const s = sheet({
    title: 'Add',
    body: h('div', { class: 'menu-grid' },
      h('button', { type: 'button', class: 'menu-tile', onclick: () => { s.close(); openEventEditor({}); } }, icon('event'), 'Event'),
      h('button', { type: 'button', class: 'menu-tile', onclick: () => { s.close(); openTaskEditor({}); } }, icon('task'), 'Task'),
      h('button', { type: 'button', class: 'menu-tile', onclick: () => { s.close(); location.hash = '#/assistant'; } }, icon('assistant'), 'Ask assistant')),
  });
}

// ---------- voice capture ----------
// Records up to 60s, transcribes on the server, then puts the text in the assistant box so it can be checked before sending.
async function startRecording() {
  if (!state.me.features.voice) { toast('Voice isn’t available on this server yet. You can type instead.'); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('This browser can’t record audio. You can type instead.'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {
    toast('Microphone access was blocked. Allow it in your browser settings, or type instead.', { bad: true }); return;
  }
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  let cancelled = false;
  const t0 = Date.now();
  const timeEl = h('div', { class: 'time' }, '0:00');
  const tick = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); timeEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; if (s >= 60) stop(); }, 250);
  const stop = () => { if (rec.state !== 'inactive') rec.stop(); };
  const sh = sheet({
    title: 'Listening…',
    body: h('div', { class: 'rec' }, h('button', { type: 'button', class: 'pulse', style: { border: 0 }, 'aria-label': 'Stop recording', onclick: stop }, icon('stop')), timeEl,
      h('p', { class: 'muted small', style: { textAlign: 'center', margin: 0 } }, 'Say something like “Swim lessons for Kiddo 1 every Saturday at 10”. Tap to stop.')),
    onClose: () => { if (rec.state !== 'inactive') { cancelled = true; rec.stop(); } },
  });
  rec.onstop = async () => {
    clearInterval(tick);
    stream.getTracks().forEach((t) => t.stop());
    if (cancelled) return;
    sh.setBody(h('div', { class: 'rec' }, h('p', null, 'Transcribing…')));
    try {
      const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
      if (blob.size < 1000) throw new Error('That was too short. Hold on a moment longer and try again.');
      const r = await api('POST', '/api/transcribe', blob);
      sh.close();
      if (!r.text) { toast('I didn’t catch anything. Try again a little closer to the mic.'); return; }
      assistantDraft.text = r.text;
      if (location.hash === '#/assistant') render(); else location.hash = '#/assistant';
      toast('Check the text, then tap send.');
    } catch (e) {
      sh.setBody(h('div', { class: 'stack', style: { padding: '12px 0' } }, h('div', { class: 'banner bad' }, errorText(e)), h('button', { type: 'button', class: 'btn primary block', onclick: () => { sh.close(); startRecording(); } }, 'Try again')));
    }
  };
  rec.start(250);
}

// ---------- boot ----------
export async function boot() {
  const r = route();
  try {
    state.me = await api('GET', '/api/me');
  } catch (e) {
    if (e.code === 'offline') {
      // offline start: use what we cached last time
      try { const cached = JSON.parse(localStorage.getItem('ff:me') || 'null'); if (cached) state.me = cached; } catch { /* ignore */ }
      if (!state.me) { app.replaceChildren(h('main', { class: 'auth' }, h('div', { class: 'box' }, h('h1', null, 'You’re offline'), h('p', { class: 'lead' }, 'Connect to the internet to sign in the first time.'), h('button', { class: 'btn primary block', onclick: () => location.reload() }, 'Try again')))); return; }
      state.online = false;
    } else {
      state.me = null;
      resetState();
      mounted = null;
      if (r.tab === 'join' && r.sub) return joinFlow(r.sub, r.arg === 'login');
      return authScreen(r.tab === 'signup' ? 'signup' : 'login');
    }
  }
  try { localStorage.setItem('ff:me', JSON.stringify(state.me)); } catch { /* ignore */ }
  if (!state.me.household) {
    app.replaceChildren(h('main', { class: 'auth' }, h('div', { class: 'box' }, h('h1', null, 'No household yet'),
      h('p', { class: 'lead' }, 'Create a new family space, or open an invitation link from someone in yours.'),
      h('button', { class: 'btn primary block', onclick: async () => { await api('POST', '/api/households', { name: `${state.me.user.name.split(' ').slice(-1)[0]} Family`, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); boot(); } }, 'Create a family space'))));
    return;
  }
  if (r.tab === 'join' && r.sub) { await joinFlow(r.sub); return; }
  resetState();
  const had = await loadCached();
  mounted = null;
  if (had) render();
  await sync();
  if (!state.lastSyncAt && !had) {
    app.replaceChildren(h('main', { class: 'auth' }, h('div', { class: 'box' }, h('h1', null, 'Couldn’t load your calendar'), h('div', { class: 'banner bad' }, state.syncError || 'The server can’t be reached.'), h('button', { class: 'btn primary block', onclick: () => location.reload() }, 'Try again'))));
    return;
  }
  render();
  startAutoSync();
  refreshCounts();
  emitSignedIn();
}
function emitSignedIn() { import('./store.js').then((m) => m.emit('signed-in')); }

let pendingRender = false;
const LIVE = new Set(['today', 'calendar', 'more/tasks', 'more/family', 'more/null', 'inbox']);
function isBusy() {
  if (document.querySelector('.sheet')) return true;
  const ae = document.activeElement;
  return !!(ae && mounted && mounted.main.contains(ae) && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && ae.value);
}
function softRender({ dataOnly = false } = {}) {
  if (!state.me || !mounted) return;
  const r = route();
  if (dataOnly && !LIVE.has(r.tab === 'more' ? `more/${r.sub}` : r.tab)) return;
  if (isBusy()) { pendingRender = true; return; }
  render();
}
function renderHeaderStatus() {
  if (!mounted) return;
  const el = mounted.header.querySelector('.sync-status');
  if (el) el.textContent = state.syncing ? 'Syncing…' : !state.online ? 'Offline' : '';
}
on('change', () => softRender({ dataOnly: true }));
on('status', () => { renderHeaderStatus(); if (!state.syncing && !state.online) softRender({ dataOnly: true }); });
on('counts', () => { if (!mounted) return; const r = route(); if (r.tab !== 'inbox' && r.tab !== 'assistant') softRender(); else updateBadges(); });
on('signed-out', () => { if (state.me) { state.me = null; closeAllSheets(); clearLocalData(); toast('Your session ended. Please sign in again.'); boot(); } });
on('outbox-rejected', ({ error }) => toast(`A change you made offline couldn’t be saved: ${error.message}`, { bad: true }));
const flushPending = () => setTimeout(() => { if (pendingRender && !isBusy()) { pendingRender = false; render(); } }, 50);
new MutationObserver(flushPending).observe(document.body, { childList: true });
document.addEventListener('focusout', flushPending);

window.addEventListener('hashchange', () => { closeAllSheets(); if (state.me) render(); else boot(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker failed to register', e));
}
boot();
