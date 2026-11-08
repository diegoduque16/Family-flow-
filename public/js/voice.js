// Voice capture: records up to 60 s, transcribes on the server (Workers AI Whisper) and returns the text.
// Used by the mic button (assistant), the task form and list quick-add.
import { h, icon, toast, sheet } from './ui.js';
import { api, state } from './store.js';

export const voiceAvailable = () => !!(state.me && state.me.features && state.me.features.voice);

const errText = (e) => (e && e.message) || 'Something went wrong.';

// Resolves to the transcribed text, or null if cancelled / nothing heard.
export function recordVoice({ hint = 'Speak now. Tap to stop.', title = 'Listening…' } = {}) {
  return new Promise(async (resolve) => {
    if (!voiceAvailable()) { toast('Voice isn’t available on this server yet. You can type instead.'); resolve(null); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('This browser can’t record audio. You can type instead.'); resolve(null); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {
      toast('Microphone access was blocked. Allow it in your browser settings, or type instead.', { bad: true }); resolve(null); return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    let cancelled = false;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const t0 = Date.now();
    const timeEl = h('div', { class: 'time' }, '0:00');
    const stop = () => { if (rec.state !== 'inactive') rec.stop(); };
    const tick = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); timeEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; if (s >= 60) stop(); }, 250);
    const sh = sheet({
      title,
      body: h('div', { class: 'rec' }, h('button', { type: 'button', class: 'pulse', style: { border: 0 }, 'aria-label': 'Stop recording', onclick: stop }, icon('stop')), timeEl,
        h('p', { class: 'muted small', style: { textAlign: 'center', margin: 0 } }, hint)),
      onClose: () => { if (rec.state !== 'inactive') { cancelled = true; rec.stop(); } else done(null); },
    });
    rec.onstop = async () => {
      clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
      if (cancelled) { done(null); return; }
      sh.setBody(h('div', { class: 'rec' }, h('p', null, 'Transcribing…')));
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
        if (blob.size < 1000) throw new Error('That was too short. Hold on a moment longer and try again.');
        const r = await api('POST', '/api/transcribe', blob);
        const text = String(r.text || '').trim();
        done(text || null);
        sh.close();
        if (!text) toast('I didn’t catch anything. Try again a little closer to the mic.');
      } catch (e) {
        sh.setBody(h('div', { class: 'stack', style: { padding: '12px 0' } }, h('div', { class: 'banner bad' }, errText(e)),
          h('button', { type: 'button', class: 'btn primary block', onclick: () => { sh.close(); recordVoice({ hint, title }).then(done); } }, 'Try again')));
      }
    };
    rec.start(250);
  });
}

// Small round mic button that fills/acts on the transcribed text.
export function micButton(onText, { label = 'Speak instead of typing', hint } = {}) {
  if (!voiceAvailable()) return null;
  return h('button', { type: 'button', class: 'btn mic-btn', 'aria-label': label, title: label, onclick: async () => { const t = await recordVoice({ hint }); if (t) onText(t); } }, icon('mic'));
}

// "milk, eggs and bread" -> ['milk', 'eggs', 'bread'] (for shopping lists).
// Splits on commas; "and" only splits the last item of a comma list (so "mac and cheese" stays one item).
export function splitItems(text) {
  const parts = String(text || '').replace(/[.!?]+$/g, '').split(/\s*[,;]\s*/);
  if (parts.length > 1) {
    const last = parts.pop();
    parts.push(...last.split(/\s+and\s+/i));
  }
  return parts
    .map((s) => s.replace(/^(and|some|a|an|the)\s+/i, '').trim())
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .slice(0, 20);
}

// Voice text -> task title: capital first letter, no trailing full stop.
export const cleanTitle = (t) => { const s = String(t || '').trim().replace(/[.!]+$/, ''); return s.charAt(0).toUpperCase() + s.slice(1); };
