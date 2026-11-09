// First-run setup wizard: 1) bring in calendars, 2) who's in the family, 3) alerts + home screen.
// Opens automatically once for people who just joined (server says setupNeeded); reopen any time from More → Setup guide.
import { h, icon, sheet, toast, avatarEl } from './ui.js';
import { api, state, membersList, mutate, sync } from './store.js';
import { addSourceSheet, connectAccountSheet, connectIcloudSheet } from './more.js';
import { openImportDocument, errorText } from './editors.js';
import { openInstallHelp, isInstalled } from './install.js';

const COLORS = ['#E76F51', '#2A9D8F', '#E9A23B', '#7C6CF2', '#D9487D', '#3A86FF', '#6A994E', '#8D6E63', '#F4A261', '#264653', '#9B5DE5', '#00A6A6'];
let open = false;

export function maybeStartSetup() {
  if (state.me && state.me.setupNeeded && !open) setTimeout(openSetup, 400);
}

async function markDone() {
  state.me.setupNeeded = false;
  try { await api('PATCH', '/api/me/prefs', { setupDone: true }); } catch { /* not important */ }
}

export function openSetup() {
  if (open) return;
  open = true;
  const canEdit = state.me.role !== 'child';
  const steps = canEdit ? ['calendars', 'family', 'alerts'] : ['calendars', 'alerts'];
  let i = 0;
  let sources = [];
  const body = h('div');
  const back = h('button', { type: 'button', class: 'btn' });
  const next = h('button', { type: 'button', class: 'btn primary' });
  const s = sheet({ title: 'Set up Family Flow', full: true, body, foot: [back, next], onClose: () => { open = false; markDone(); } });

  const loadSources = async () => { try { sources = (await api('GET', '/api/calendar-sources')).sources; } catch { sources = []; } };
  const refresh = async () => { await loadSources(); render(); };

  const dots = () => h('div', { class: 'setup-dots', 'aria-label': `Step ${i + 1} of ${steps.length}` }, steps.map((_, k) => h('span', { class: k === i ? 'on' : k < i ? 'done' : '' })));

  const tile = (emoji, title, sub, onclick, done = false) => h('button', { type: 'button', class: `setup-tile${done ? ' done' : ''}`, onclick },
    h('span', { class: 'e', 'aria-hidden': 'true' }, done ? '✓' : emoji),
    h('span', { class: 'grow' }, h('b', null, title), h('span', { class: 'small muted', style: { display: 'block' } }, sub)),
    icon('chev', 'chev'));

  function calendarsStep() {
    const f = state.me.features || {};
    const has = (p) => sources.some((x) => x.provider === p);
    const school = sources.filter((x) => x.provider === 'ics');
    return h('div', null,
      h('h3', { class: 'setup-h' }, `Welcome, ${state.me.user.name.split(' ')[0]}! 👋`),
      h('p', { class: 'muted' }, 'First, bring in the calendars your family already uses, so everything shows up in one place. Add as many as you like, or skip and do it later.'),
      h('div', { class: 'stack', style: { gap: '10px' } },
        tile('🏫', 'School or activity calendar', school.length ? school.map((x) => x.name).join(', ') : 'ParentSquare, sports teams, clubs — paste their calendar link', () => addSourceSheet('school', refresh), !!school.length),
        f.googleCalendar ? tile('🟦', 'Google Calendar', has('google') ? 'Connected' : 'Sign in with Google', () => connectAccountSheet('google'), has('google'))
          : tile('🟦', 'Google Calendar', has('google') ? 'Connected' : 'Paste your private calendar link', () => addSourceSheet('google', refresh), has('google')),
        f.microsoftCalendar ? tile('📨', 'Outlook', has('outlook') ? 'Connected' : 'Sign in with Microsoft', () => connectAccountSheet('microsoft'), has('outlook'))
          : tile('📨', 'Outlook', has('outlook') ? 'Connected' : 'Paste your published calendar link', () => addSourceSheet('outlook', refresh), has('outlook')),
        f.icloudCalendar ? tile('🍎', 'Apple / iPhone Calendar', has('apple') ? 'Connected' : 'Sign in with your Apple ID', () => connectIcloudSheet(refresh), has('apple'))
          : tile('🍎', 'Apple / iPhone Calendar', has('apple') ? 'Connected' : 'Share an iCloud calendar link', () => addSourceSheet('apple', refresh), has('apple')),
        f.assistant ? tile('📄', 'A PDF or photo of a schedule', 'School year calendar, game schedule, a flyer…', () => openImportDocument()) : null),
      h('p', { class: 'faint small', style: { marginTop: '12px' } }, 'Calendars you bring in are read-only and refresh automatically. You can manage them later in More → Connected calendars.'));
  }

  function familyStep() {
    const name = h('input', { class: 'input', placeholder: 'Name, e.g. Mia', maxlength: 40, 'aria-label': 'Name' });
    const kind = h('select', { class: 'input', 'aria-label': 'Adult or child', style: { width: '110px', flex: 'none' } }, h('option', { value: 'child' }, 'Child'), h('option', { value: 'adult' }, 'Adult'));
    const err = h('div');
    const add = async () => {
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      const color = COLORS.find((c) => !membersList().some((m) => m.color === c)) || COLORS[membersList().length % COLORS.length];
      try { await mutate({ method: 'POST', path: '/api/members', body: { name: n, kind: kind.value, color }, kind: 'members', offlineOk: false }); await sync(); render(); setTimeout(() => { const x = body.querySelector('input[aria-label="Name"]'); if (x) x.focus(); }, 50); }
      catch (e) { err.replaceChildren(h('div', { class: 'banner bad' }, errorText(e))); }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    return h('div', null,
      h('h3', { class: 'setup-h' }, 'Who’s in your family?'),
      h('p', { class: 'muted' }, 'Add kids and anyone else you plan for. They don’t need an account — each gets a colour so you can see whose events are whose.'),
      h('div', { class: 'card', style: { padding: '8px 12px' } }, h('ul', { class: 'list' }, membersList().map((m) => h('li', { class: 'row', style: { gap: '10px', padding: '8px 0' } }, avatarEl(m, { size: 32 }), h('span', { class: 'grow' }, m.name, m.label && m.fullName !== m.label ? h('span', { class: 'faint' }, ` · ${m.fullName}`) : null), h('span', { class: 'faint small' }, m.kind === 'child' ? 'Child' : 'Adult'))))),
      h('div', { class: 'row', style: { gap: '8px', marginTop: '10px' } }, name, kind, h('button', { type: 'button', class: 'btn', onclick: add }, icon('plus'), 'Add')),
      err,
      h('p', { class: 'faint small', style: { marginTop: '12px' } }, 'To let another adult sign in (like your partner), invite them from More → People & invites.'));
  }

  function alertsStep() {
    return h('div', null,
      h('h3', { class: 'setup-h' }, 'Stay in the loop'),
      h('p', { class: 'muted' }, 'Last step: get reminders and know when the family adds or changes plans.'),
      h('div', { class: 'stack', style: { gap: '10px' } },
        isInstalled() ? null : tile('📲', 'Add to your home screen', 'Opens like a normal app' + (/iPhone|iPad/.test(navigator.userAgent) ? ' — needed for iPhone notifications' : ''), () => openInstallHelp()),
        tile('🔔', 'Turn on notifications', 'Reminders and family updates on this phone', () => { s.close(); location.hash = '#/more/notifications'; })),
      h('p', { class: 'faint small', style: { marginTop: '12px' } }, 'You can reopen this guide any time from More → Setup guide.'));
  }

  function render() {
    const step = steps[i];
    body.replaceChildren(dots(), step === 'calendars' ? calendarsStep() : step === 'family' ? familyStep() : alertsStep());
    back.textContent = i === 0 ? 'Skip for now' : 'Back';
    next.textContent = i === steps.length - 1 ? 'Done' : 'Next';
  }
  back.addEventListener('click', () => { if (i === 0) { s.close(); toast('You can finish setup any time from More → Setup guide'); } else { i -= 1; render(); } });
  next.addEventListener('click', () => { if (i === steps.length - 1) { s.close(); toast('You’re all set 🎉'); } else { i += 1; render(); } });
  render();
  loadSources().then(render);
}
