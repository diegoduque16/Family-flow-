// Shared helpers: ids, responses, errors, validation, crypto encodings.

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const now = () => Date.now();

export function uid(prefix = '') {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return prefix + b64url(b);
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64url(d);
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
  }
  console.error('Unhandled error', err && err.stack || err);
  return json({ error: { code: 'internal', message: 'Something went wrong on our side. Please try again; if it keeps happening, check Diagnostics.' } }, 500);
}

export async function readJson(request, maxBytes = 200_000) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw new HttpError(413, 'too_large', 'Request is too large.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', 'Request is too large.');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.');
  }
}

// ---------- tiny schema validator ----------
// v.object({ title: v.string({ min: 1, max: 200 }), ... }) -> fn(input) => clean | throws HttpError(422)

class Invalid extends Error {
  constructor(path, message) { super(message); this.path = path; }
}

const mk = (fn) => {
  fn.optional = () => mk((x, p) => (x === undefined || x === null ? undefined : fn(x, p)));
  fn.nullable = () => mk((x, p) => (x === null ? null : x === undefined ? undefined : fn(x, p)));
  fn.default = (d) => mk((x, p) => (x === undefined || x === null ? (typeof d === 'function' ? d() : d) : fn(x, p)));
  return fn;
};

export const v = {
  string: ({ min = 0, max = 10_000, pattern, trim = true, oneOf } = {}) => mk((x, p) => {
    if (typeof x !== 'string') throw new Invalid(p, 'must be text');
    const s = trim ? x.trim() : x;
    if (s.length < min) throw new Invalid(p, min === 1 ? 'is required' : `must be at least ${min} characters`);
    if (s.length > max) throw new Invalid(p, `must be at most ${max} characters`);
    if (pattern && !pattern.test(s)) throw new Invalid(p, 'has an invalid format');
    if (oneOf && !oneOf.includes(s)) throw new Invalid(p, `must be one of: ${oneOf.join(', ')}`);
    return s;
  }),
  number: ({ min = -Infinity, max = Infinity, int = false } = {}) => mk((x, p) => {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Invalid(p, 'must be a number');
    if (int && !Number.isInteger(x)) throw new Invalid(p, 'must be a whole number');
    if (x < min || x > max) throw new Invalid(p, `must be between ${min} and ${max}`);
    return x;
  }),
  boolean: () => mk((x, p) => {
    if (typeof x !== 'boolean') throw new Invalid(p, 'must be true or false');
    return x;
  }),
  array: (item, { max = 100 } = {}) => mk((x, p) => {
    if (!Array.isArray(x)) throw new Invalid(p, 'must be a list');
    if (x.length > max) throw new Invalid(p, `can have at most ${max} items`);
    return x.map((el, i) => item(el, `${p}[${i}]`));
  }),
  object: (shape) => mk((x, p = '') => {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Invalid(p || 'body', 'must be an object');
    const out = {};
    for (const [k, fn] of Object.entries(shape)) {
      const r = fn(x[k], p ? `${p}.${k}` : k);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }),
};

export function validate(schema, input) {
  try {
    return schema(input, '');
  } catch (e) {
    if (e instanceof Invalid) throw new HttpError(422, 'invalid', `${e.path} ${e.message}`, { field: e.path });
    throw e;
  }
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseJsonCol(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
