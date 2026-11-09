// "Add Family Flow to your home screen" banner.
// Android / desktop Chrome & Edge: one tap opens the browser's own install prompt.
// iPhone / iPad: websites can't add themselves, so the button shows the two taps (Share → Add to Home Screen).
import { h, sheet, toast } from './ui.js';

let deferred = null;
const listeners = new Set();
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; listeners.forEach((f) => f()); });
window.addEventListener('appinstalled', () => { deferred = null; try { localStorage.setItem('ff:installed', '1'); } catch { /* ignore */ } listeners.forEach((f) => f()); });

const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isIOSSafari = isIOS && !/CriOS|FxiOS|EdgiOS|GSA\//.test(ua);
const isMobile = isIOS || /Android/.test(ua);
export const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const SNOOZE_DAYS = 10;
function snoozed() {
  try { return Number(localStorage.getItem('ff:installSnooze') || 0) > Date.now() || localStorage.getItem('ff:installed') === '1'; } catch { return false; }
}
function snooze() { try { localStorage.setItem('ff:installSnooze', String(Date.now() + SNOOZE_DAYS * 86400000)); } catch { /* ignore */ } }

const shareIcon = () => {
  const el = h('span', { class: 'ios-share', role: 'img', 'aria-label': 'Share button' });
  el.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7.5 7.5L12 3l4.5 4.5M6 11H5a1 1 0 00-1 1v8a1 1 0 001 1h14a1 1 0 001-1v-8a1 1 0 00-1-1h-1"/></svg>';
  return el;
};

export function openInstallHelp() {
  if (deferred) {
    const e = deferred;
    deferred = null;
    e.prompt();
    e.userChoice.then((c) => { if (c.outcome === 'accepted') toast('Added — open Family Flow from your home screen'); }).catch(() => {});
    return;
  }
  const steps = isIOS
    ? (isIOSSafari
      ? [['1', ['Tap the Share button ', shareIcon(), ' at the bottom of Safari (top right on iPad).']], ['2', ['Scroll down and tap ', h('b', null, 'Add to Home Screen'), '.']], ['3', ['Tap ', h('b', null, 'Add'), '. Then open Family Flow from its new icon.']]]
      : [['1', ['Tap the Share button ', shareIcon(), ' in the address bar or menu.']], ['2', ['Tap ', h('b', null, 'Add to Home Screen'), '.']], ['3', ['If you don’t see it, open this page in ', h('b', null, 'Safari'), ' and try there.']]])
    : [['1', ['Open your browser’s menu (⋮).']], ['2', ['Tap ', h('b', null, 'Install app'), ' or ', h('b', null, 'Add to Home screen'), '.']], ['3', ['Open Family Flow from its new icon.']]];
  sheet({
    title: 'Add Family Flow to your home screen',
    body: h('div', { class: 'stack', style: { padding: '6px 0 4px', gap: '14px' } },
      h('p', { class: 'muted', style: { margin: 0 } }, 'It opens full-screen like a normal app' + (isIOS ? ', and on iPhone it’s needed for notifications.' : '.')),
      h('ol', { class: 'install-steps' }, steps.map(([n, text]) => h('li', null, h('span', { class: 'num' }, n), h('span', null, ...text)))),
      isIOSSafari ? h('div', { class: 'install-arrow', 'aria-hidden': 'true' }, '↓') : null),
  });
}

// Banner for the Today screen. Returns null when installed, on a computer without an install prompt, or snoozed.
export function installBanner(rerender) {
  if (isInstalled() || snoozed()) return null;
  if (!isMobile && !deferred) { if (rerender && !listeners.has(rerender)) listeners.add(rerender); return null; }
  if (rerender && !listeners.has(rerender)) listeners.add(rerender);
  return h('div', { class: 'install-banner' },
    h('img', { src: '/icons/icon-192.png', alt: '', width: 44, height: 44 }),
    h('div', { class: 'grow' }, h('b', null, 'Get the Family Flow app'), h('div', { class: 'small muted' }, isIOS ? 'Add it to your home screen for one-tap access and notifications.' : 'Install it on your phone — one tap, no app store.')),
    h('div', { class: 'stack', style: { gap: '4px', alignItems: 'flex-end' } },
      h('button', { type: 'button', class: 'btn primary sm', onclick: openInstallHelp }, deferred ? 'Install' : 'Add'),
      h('button', { type: 'button', class: 'btn ghost sm', style: { padding: '2px 6px', minHeight: 0 }, onclick: (ev) => { snooze(); ev.currentTarget.closest('.install-banner').remove(); } }, 'Not now')));
}
