// Password hashing, sessions, request authentication and CSRF protection.
import { HttpError, b64url, b64urlDecode, randomToken, sha256, now } from './util.js';
import { one, run } from './db.js';

const PBKDF2_ITER = 100_000; // Workers' maximum for PBKDF2
const SESSION_DAYS = 60;
export const COOKIE = 'ff_session';

export async function hashPassword(password, saltB64 = null, iter = PBKDF2_ITER) {
  const salt = saltB64 ? b64urlDecode(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return { hash: b64url(bits), salt: b64url(salt), iter };
}

export async function verifyPassword(password, user) {
  const { hash } = await hashPassword(password, user.pw_salt, user.pw_iter);
  // constant-time compare
  if (hash.length !== user.pw_hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ user.pw_hash.charCodeAt(i);
  return diff === 0;
}

export async function createSession(db, userId, userAgent = '') {
  const token = randomToken(32);
  const id = await sha256(token);
  const t = now();
  await run(db, 'INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)',
    id, userId, t, t + SESSION_DAYS * 86400000, String(userAgent).slice(0, 200));
  return token;
}

export function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export function clearCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

// Mutating requests must carry our custom header (blocks cross-site form posts) and, if the
// browser sent an Origin, it must match ours.
export function checkCsrf(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  if (request.headers.get('x-ff') !== '1') throw new HttpError(403, 'csrf', 'Request blocked for security reasons.');
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'csrf', 'Request blocked for security reasons.');
}

// Returns { user, session } or null.
export async function loadSession(request, db) {
  const token = readCookie(request, COOKIE);
  if (!token || token.length > 100) return null;
  const id = await sha256(token);
  const row = await one(db,
    `SELECT s.id AS sid, s.expires_at, u.id, u.email, u.name, u.current_household_id
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, id);
  if (!row) return null;
  if (row.expires_at < now()) {
    await run(db, 'DELETE FROM sessions WHERE id = ?', id);
    return null;
  }
  return { sessionId: row.sid, user: { id: row.id, email: row.email, name: row.name, current_household_id: row.current_household_id } };
}

// Resolves the active household and the caller's role in it.
export async function loadContext(request, db) {
  const s = await loadSession(request, db);
  if (!s) return null;
  let m = null;
  if (s.user.current_household_id) {
    m = await one(db, 'SELECT household_id, role, member_id FROM memberships WHERE user_id = ? AND household_id = ?', s.user.id, s.user.current_household_id);
  }
  if (!m) {
    m = await one(db, 'SELECT household_id, role, member_id FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1', s.user.id);
    if (m) await run(db, 'UPDATE users SET current_household_id = ? WHERE id = ?', m.household_id, s.user.id);
  }
  const household = m ? await one(db, 'SELECT id, name, timezone, seq FROM households WHERE id = ?', m.household_id) : null;
  return { ...s, household, role: m ? m.role : null, memberId: m ? m.member_id : null };
}

export const canEdit = (ctx) => ctx.role === 'owner' || ctx.role === 'adult';

export function requireRole(ctx, roles) {
  if (!ctx.household) throw new HttpError(409, 'no_household', 'Create or join a household first.');
  if (!roles.includes(ctx.role)) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
}
