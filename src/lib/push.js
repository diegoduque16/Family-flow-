// Standards-based Web Push (RFC 8030 / 8291 aes128gcm / RFC 8292 VAPID) using only WebCrypto.
import { b64url, b64urlDecode } from './util.js';
import { getSetting, setSetting } from './db.js';

const enc = new TextEncoder();

function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
const hkdfExtract = (salt, ikm) => hmac(salt, ikm);
async function hkdfExpand(prk, info, len) {
  const t = await hmac(prk, concat(info, new Uint8Array([1])));
  return t.slice(0, len);
}

// VAPID key pair is generated once and stored in D1 settings (no secret to configure by hand).
export async function getVapidKeys(db) {
  const stored = await getSetting(db, 'vapid_keys');
  if (stored) {
    const { publicKey, privateJwk } = JSON.parse(stored);
    return { publicKey, privateJwk };
  }
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const keys = { publicKey: b64url(raw), privateJwk };
  // Another request may have raced us: keep whichever landed first.
  await db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').bind('vapid_keys', JSON.stringify(keys), Date.now()).run();
  return JSON.parse(await getSetting(db, 'vapid_keys'));
}

async function vapidJwt(endpoint, privateJwk, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

export async function encryptPayload(payload, p256dhB64, authB64) {
  const uaPublic = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const prkKey = await hkdfExtract(authSecret, ecdhSecret);
  const ikm = await hkdfExpand(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, enc.encode('Content-Encoding: nonce\0'), 12);
  const plain = concat(enc.encode(payload), new Uint8Array([2]));
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// Returns { ok, status, gone, error }
export async function sendPush(db, sub, message, env = {}) {
  const { publicKey, privateJwk } = await getVapidKeys(db);
  const subject = env.VAPID_SUBJECT || 'mailto:support@familyflow.app';
  const body = await encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth);
  const jwt = await vapidJwt(sub.endpoint, privateJwk, subject);
  const f = env.__fetch || fetch;
  try {
    const res = await f(sub.endpoint, {
      method: 'POST',
      headers: {
        TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        Authorization: `vapid t=${jwt}, k=${publicKey}`,
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true, status: res.status };
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  }
}
