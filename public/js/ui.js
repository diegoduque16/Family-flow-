// Tiny DOM helpers, icons, sheets, toasts and formatting. No framework; all text goes through textContent (no HTML injection).

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('--')) el.style.setProperty(k, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v; // only used with static, trusted strings (icons)
      else if (k === 'value') continue; // set after children (selects need their options first)
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  if (attrs && attrs.value !== undefined && attrs.value !== null) el.value = attrs.value;
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const P = {
  today: '<path d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/><path d="M8 2v4M16 2v4M4 10h16"/><circle cx="12" cy="15" r="1.6" fill="currentColor"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/>',
  inbox: '<path d="M3 13l2.5-7.5A2 2 0 0 1 7.4 4h9.2a2 2 0 0 1 1.9 1.5L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  assistant: '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z"/><path d="M18.5 15l.8 2 2 .8-2 .7-.8 2-.8-2-2-.7 2-.8z"/>',
  more: '<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  repeat: '<path d="M4 11V9a3 3 0 0 1 3-3h12l-3-3M20 13v2a3 3 0 0 1-3 3H5l3 3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  task: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 12.2l2.4 2.4 4.8-5"/>',
  event: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/><path d="M12 13v5M9.5 15.5h5"/>',
  people: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5c.8-3.2 3.2-5 6-5s5.2 1.8 6 5"/><circle cx="17" cy="9.5" r="2.6"/><path d="M16.5 14.6c2.2.2 3.8 1.7 4.5 4.4"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.5" cy="6.5" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="17.5" r="1.2"/>',
  home: '<path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M9.5 20.5v-6h5v6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  shield: '<path d="M12 3l7 3v5.5c0 4.3-3 7.8-7 9.5-4-1.7-7-5.2-7-9.5V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1-3.8 4-5.8 7.5-5.8s6.5 2 7.5 5.8"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  wifi: '<path d="M3 9a13 13 0 0 1 18 0M6 12.5a8.5 8.5 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  share: '<path d="M12 3v12M7.5 7.5L12 3l4.5 4.5"/><path d="M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12"/>',
  sync: '<path d="M20 12a8 8 0 0 1-14 5.3M4 12A8 8 0 0 1 18 6.7"/><path d="M18 3v4h-4M6 21v-4h4"/>',
};
export function icon(name, extra = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.9');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  if (extra) s.setAttribute('class', extra);
  s.innerHTML = P[name] || '';
  return s;
}

// ---------- toasts ----------
export function toast(msg, { bad = false, action, onAction, ms = 3800 } = {}) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast${bad ? ' bad' : ''}`, role: bad ? 'alert' : 'status' }, h('span', null, msg),
    action ? h('button', { type: 'button', onclick: () => { onAction(); t.remove(); } }, action) : null);
  box.append(t);
  setTimeout(() => t.remove(), action ? ms + 3000 : ms);
}

// ---------- sheets ----------
const stack = [];
export function sheet({ title, body, foot, full = false, onClose, label }) {
  const prevFocus = document.activeElement;
  const scrim = h('div', { class: 'scrim' });
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close' }, icon('close'));
  const box = h('section', { class: `sheet${full ? ' full' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': label || title },
    h('div', { class: 'sheet-head' }, h('h2', null, title), closeBtn),
    h('div', { class: 'sheet-body' }, body),
    foot ? h('div', { class: 'sheet-foot' }, foot) : null);
  let closed = false;
  const api = {
    el: box,
    close(result) {
      if (closed) return;
      closed = true;
      scrim.remove(); box.remove();
      stack.splice(stack.indexOf(api), 1);
      document.body.style.overflow = stack.length ? 'hidden' : '';
      if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
      if (onClose) onClose(result);
    },
    setBody(b) { const sb = box.querySelector('.sheet-body'); sb.replaceChildren(b); },
  };
  scrim.addEventListener('click', () => api.close());
  closeBtn.addEventListener('click', () => api.close());
  document.body.append(scrim, box);
  document.body.style.overflow = 'hidden';
  stack.push(api);
  setTimeout(() => {
    const f = box.querySelector('[autofocus]') || box.querySelector('.sheet-body input, .sheet-body button, .sheet-body textarea, .sheet-body select') || closeBtn;
    f.focus({ preventScroll: true });
  }, 30);
  return api;
}
export function closeAllSheets() { while (stack.length) stack[stack.length - 1].close(); }
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length && !e.defaultPrevented) stack[stack.length - 1].close();
  if (e.key === 'Tab' && stack.length) { // focus trap
    const box = stack[stack.length - 1].el;
    const f = [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
});

// Promise-based choice dialog. options: [{label, value, kind}]
export function choose(title, message, options) {
  return new Promise((resolve) => {
    let picked = null;
    const s = sheet({
      title,
      body: h('div', { class: 'stack', style: { padding: '8px 0' } },
        message ? h('p', { class: 'muted', style: { margin: '4px 0 8px', whiteSpace: 'pre-line' } }, message) : null,
        options.map((o) => h('button', { type: 'button', class: `btn block ${o.kind || ''}`, onclick: () => { picked = o.value; s.close(); } }, o.label))),
      onClose: () => resolve(picked),
    });
  });
}
export const confirmDialog = (title, message, okLabel = 'OK', danger = false) =>
  choose(title, message, [{ label: okLabel, value: true, kind: danger ? 'danger' : 'primary' }, { label: 'Cancel', value: false }]).then((v) => v === true);

// ---------- formatting ----------
const fmtCache = new Map();
function f(opts) {
  const k = JSON.stringify(opts);
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }));
  return fmtCache.get(k);
}
// Local wall-clock strings are formatted as if UTC so the browser's own zone never shifts them.
const asDate = (local) => new Date(`${local.slice(0, 10)}T${local.length > 10 ? local.slice(11, 16) : '12:00'}:00Z`);
export const fmtTime = (local) => f({ hour: 'numeric', minute: '2-digit' }).format(asDate(local)).replace(':00', '').replace(' ', ' ');
export const fmtDay = (local) => f({ weekday: 'long', month: 'long', day: 'numeric' }).format(asDate(local));
export const fmtDayShort = (local) => f({ weekday: 'short', month: 'short', day: 'numeric' }).format(asDate(local));
export const fmtMonth = (local) => f({ month: 'long', year: 'numeric' }).format(asDate(local));
export const fmtWeekday = (local) => f({ weekday: 'short' }).format(asDate(local));
export function relDay(date, today) {
  const d = Math.round((asDate(date) - asDate(today)) / 86400000);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  return '';
}
export function fmtRange(o, allDay) {
  if (allDay) {
    const endIncl = addDaysStr(o.end, -1);
    return endIncl > o.start.slice(0, 10) ? `${fmtDayShort(o.start)} – ${fmtDayShort(endIncl)}` : 'All day';
  }
  return o.end.slice(0, 10) === o.start.slice(0, 10) ? `${fmtTime(o.start)} – ${fmtTime(o.end)}` : `${fmtTime(o.start)} – ${fmtDayShort(o.end)} ${fmtTime(o.end)}`;
}
export function addDaysStr(date, n) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Couldn’t copy automatically. Press and hold to copy.'); }
}
export function reminderLabel(m) {
  if (m === 0) return 'At start';
  if (m < 60) return `${m} min before`;
  if (m < 1440) return `${m / 60} hr before`;
  if (m % 10080 === 0) return `${m / 10080} wk before`;
  return `${m / 1440} day${m === 1440 ? '' : 's'} before`;
}
