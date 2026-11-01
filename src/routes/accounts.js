// One-tap calendar connection: "Sign in with Google" / "Sign in with Microsoft" (OAuth 2.0 + PKCE), read-only.
// Refresh tokens are stored encrypted (AES-GCM, key derived from that provider's client secret, which lives only
// in Cloudflare secrets), so a copy of the database alone can't be used to read anyone's calendar.
import { HttpError, json, readJson, validate, v, uid, now, sha256, randomToken, b64url, b64urlDecode } from '../lib/util.js';
import { one, all, run, audit } from '../lib/db.js';
import { requireRole } from '../lib/auth.js';
import { applyInstances, importWindow } from './sources.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PROVIDERS = {
  google: {
    label: 'Google Calendar',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email https://www.googleapis.com/auth/calendar.readonly',
    idKey: 'GOOGLE_CLIENT_ID', secretKey: 'GOOGLE_CLIENT_SECRET',
    extraAuth: { access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true' },
  },
  microsoft: {
    label: 'Outlook',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid email offline_access User.Read Calendars.Read',
    idKey: 'MS_CLIENT_ID', secretKey: 'MS_CLIENT_SECRET',
    extraAuth: { prompt: 'select_account', response_mode: 'query' },
  },
};

export const configured = (env, p) => !!(env[PROVIDERS[p].idKey] && env[PROVIDERS[p].secretKey]);
const redirectUri = (origin, p) => `${origin}/oauth/${p}/callback`;
const getFetch = (env) => env.__fetch || fetch;

// ---------- token encryption ----------
async function keyFor(env, provider) {
  const base = await crypto.subtle.importKey('raw', enc.encode(env[PROVIDERS[provider].secretKey]), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('family-flow-tokens'), info: enc.encode(provider) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealToken(env, provider, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(env, provider), enc.encode(token));
  return `${b64url(iv)}.${b64url(ct)}`;
}
export async function openToken(env, provider, sealed) {
  const [iv, ct] = String(sealed || '').split('.');
  try {
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(iv) }, await keyFor(env, provider), b64urlDecode(ct)));
  } catch {
    throw new HttpError(401, 'reconnect', 'This calendar needs to be reconnected (its saved sign-in can no longer be read).');
  }
}

// ---------- start ----------
export async function startConnect(req, env, ctx, { provider }) {
  requireRole(ctx, ['owner', 'adult']);
  if (!PROVIDERS[provider]) throw new HttpError(404, 'not_found', 'Unknown calendar provider.');
  if (!configured(env, provider)) throw new HttpError(503, 'not_configured', `Sign in with ${provider === 'google' ? 'Google' : 'Microsoft'} isn’t set up for this app yet. You can still connect with a calendar link.`);
  const body = validate(v.object({ memberId: v.string({ max: 60 }).nullable(), visibility: v.string({ oneOf: ['shared', 'private'] }).default('shared') }), await readJson(req));
  if (body.memberId && !(await one(env.DB, 'SELECT 1 FROM members WHERE id = ? AND household_id = ? AND deleted_at IS NULL', body.memberId, ctx.household.id))) {
    throw new HttpError(422, 'invalid', 'That family profile doesn’t exist.', { field: 'memberId' });
  }
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  await run(env.DB, 'DELETE FROM oauth_states WHERE created_at < ?', now() - 15 * 60000);
  await run(env.DB, 'INSERT INTO oauth_states (id, user_id, household_id, provider, member_id, visibility, verifier, created_at) VALUES (?,?,?,?,?,?,?,?)',
    await sha256(state), ctx.user.id, ctx.household.id, provider, body.memberId ?? null, body.visibility, verifier, now());
  const P = PROVIDERS[provider];
  const u = new URL(P.authUrl);
  const params = {
    client_id: env[P.idKey], redirect_uri: redirectUri(new URL(req.url).origin, provider), response_type: 'code', scope: P.scope,
    state, code_challenge: challenge, code_challenge_method: 'S256', login_hint: undefined, ...P.extraAuth,
  };
  for (const [k, val] of Object.entries(params)) if (val) u.searchParams.set(k, val);
  return json({ url: u.toString() });
}

// ---------- callback (top-level GET from Google/Microsoft) ----------
const back = (origin, qs) => Response.redirect(`${origin}/#/more/sync?${qs}`, 302);

export async function oauthCallback(req, env, ctx, { provider }) {
  const url = new URL(req.url);
  const origin = url.origin;
  if (!PROVIDERS[provider]) return back(origin, 'error=unknown');
  const err = url.searchParams.get('error');
  if (err) return back(origin, `error=${encodeURIComponent(err === 'access_denied' ? 'denied' : err)}`);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const st = await one(env.DB, 'SELECT * FROM oauth_states WHERE id = ?', await sha256(state));
  if (st) await run(env.DB, 'DELETE FROM oauth_states WHERE id = ?', st.id);
  if (!st || st.provider !== provider || now() - st.created_at > 15 * 60000) return back(origin, 'error=expired');
  // The browser that started must be the one finishing (session cookie), so a link can't be replayed into someone else's account.
  if (!ctx || ctx.user.id !== st.user_id) return back(origin, 'error=session');
  try {
    const tokens = await exchange(env, provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(origin, provider), code_verifier: st.verifier });
    if (!tokens.refresh_token) throw new HttpError(502, 'no_refresh', 'The sign-in didn’t grant ongoing access. Please try again and allow access.');
    const email = await accountEmail(env, provider, tokens.access_token, tokens.id_token);
    const cals = await listCalendars(env, provider, tokens.access_token);
    const primary = cals.filter((c) => c.primary).slice(0, 1);
    const selected = (primary.length ? primary : cals.slice(0, 1)).map(({ id, name }) => ({ id, name }));
    const household = await one(env.DB, 'SELECT * FROM households WHERE id = ?', st.household_id);
    const fakeUrl = `oauth:${provider}:${email}`;
    let src = await one(env.DB, 'SELECT * FROM calendar_sources WHERE household_id = ? AND url = ? AND deleted_at IS NULL', st.household_id, fakeUrl);
    const sealed = await sealToken(env, provider, tokens.refresh_token);
    if (src) {
      await run(env.DB, 'UPDATE calendar_sources SET token_enc = ?, last_status = NULL, last_error = NULL WHERE id = ?', sealed, src.id);
    } else {
      const id = uid('cs_');
      await run(env.DB, `INSERT INTO calendar_sources (id, household_id, owner_user_id, name, provider, url, member_id, visibility, kind, account_email, token_enc, calendars, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, st.household_id, st.user_id, `${PROVIDERS[provider].label} · ${email}`.slice(0, 60),
      provider === 'google' ? 'google' : 'outlook', fakeUrl, st.member_id, st.visibility, provider, email, sealed, JSON.stringify(selected), now());
      src = await one(env.DB, 'SELECT * FROM calendar_sources WHERE id = ?', id);
    }
    const r = await syncAccount(env, { ...src, token_enc: sealed }, household, tokens.access_token);
    await audit(env.DB, { householdId: st.household_id, userId: st.user_id, action: 'source.connect', refType: 'source', refId: src.id, detail: { provider } });
    return back(origin, `connected=${encodeURIComponent(src.id)}&count=${r.total || 0}`);
  } catch (e) {
    console.error('oauth callback failed', e);
    return back(origin, `error=${encodeURIComponent(e instanceof HttpError ? e.message : 'Sign-in failed. Please try again.')}`);
  }
}

async function exchange(env, provider, params) {
  const P = PROVIDERS[provider];
  const body = new URLSearchParams({ client_id: env[P.idKey], client_secret: env[P.secretKey], ...params });
  if (provider === 'microsoft') body.set('scope', P.scope);
  const res = await getFetch(env)(P.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'invalid_grant') throw new HttpError(401, 'reconnect', `Access to this ${P.label} account was removed or has expired. Tap Reconnect to sign in again.`);
    throw new HttpError(502, 'oauth_error', `${P.label} sign-in failed (${data.error || res.status}${data.error_description ? `: ${String(data.error_description).slice(0, 120)}` : ''}).`);
  }
  return data;
}

async function accountEmail(env, provider, accessToken, idToken) {
  if (idToken) {
    try { const p = JSON.parse(dec.decode(b64urlDecode(idToken.split('.')[1]))); if (p.email || p.preferred_username) return p.email || p.preferred_username; } catch { /* fall through */ }
  }
  if (provider === 'microsoft') {
    const me = await api(env, accessToken, 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName');
    return me.mail || me.userPrincipalName || 'Microsoft account';
  }
  return 'Google account';
}

async function api(env, accessToken, url, headers = {}) {
  const res = await getFetch(env)(url, { headers: { authorization: `Bearer ${accessToken}`, ...headers }, signal: AbortSignal.timeout(20000) });
  if (res.status === 401) throw new HttpError(401, 'reconnect', 'The calendar sign-in has expired. Tap Reconnect.');
  if (res.status === 403) throw new HttpError(403, 'forbidden', 'The calendar service refused access. Your organisation may block third-party apps; ask your IT admin, or use a calendar link instead.');
  if (!res.ok) throw new HttpError(502, 'provider_error', `The calendar service returned an error (HTTP ${res.status}). We’ll try again automatically.`);
  return res.json();
}

export async function listCalendars(env, provider, accessToken) {
  if (provider === 'google') {
    const d = await api(env, accessToken, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=100');
    return (d.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary }));
  }
  const d = await api(env, accessToken, 'https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,isDefaultCalendar&$top=100');
  return (d.value || []).map((c) => ({ id: c.id, name: c.name, primary: !!c.isDefaultCalendar }));
}

// ---------- fetching events (already expanded into single instances by the provider) ----------
const isoDate = (ms) => new Date(ms).toISOString();
async function googleInstances(env, token, calId, fromMs, toMs) {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`);
    u.searchParams.set('singleEvents', 'true');
    u.searchParams.set('timeMin', isoDate(fromMs));
    u.searchParams.set('timeMax', isoDate(toMs));
    u.searchParams.set('maxResults', '2500');
    u.searchParams.set('fields', 'nextPageToken,items(id,status,summary,description,location,start,end)');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const d = await api(env, token, u.toString());
    for (const e of d.items || []) {
      if (e.status === 'cancelled' || !e.start) continue;
      const base = { uid: `${calId}|${e.id}`, recurrenceKey: '', title: (e.summary || '(No title)').slice(0, 200), notes: (e.description || '').replace(/<[^>]+>/g, '').slice(0, 5000), location: (e.location || '').slice(0, 300) };
      if (e.start.date) out.push({ ...base, allDay: true, startDate: e.start.date, endDate: (e.end && e.end.date) || e.start.date });
      else out.push({ ...base, allDay: false, startUtc: Date.parse(e.start.dateTime), endUtc: Date.parse((e.end && e.end.dateTime) || e.start.dateTime) });
    }
    pageToken = d.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}
async function graphInstances(env, token, calId, fromMs, toMs) {
  const out = [];
  let next = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calId)}/calendarView?startDateTime=${isoDate(fromMs)}&endDateTime=${isoDate(toMs)}&$top=500&$select=id,subject,bodyPreview,location,start,end,isAllDay,isCancelled`;
  for (let page = 0; page < 20 && next; page++) {
    const d = await api(env, token, next, { prefer: 'outlook.timezone="UTC"' });
    for (const e of d.value || []) {
      if (e.isCancelled) continue;
      const base = { uid: `${calId}|${e.id}`, recurrenceKey: '', title: (e.subject || '(No title)').slice(0, 200), notes: (e.bodyPreview || '').slice(0, 5000), location: ((e.location && e.location.displayName) || '').slice(0, 300) };
      const s = Date.parse(`${e.start.dateTime.slice(0, 19)}Z`);
      const en = Date.parse(`${e.end.dateTime.slice(0, 19)}Z`);
      if (e.isAllDay) out.push({ ...base, allDay: true, startDate: e.start.dateTime.slice(0, 10), endDate: e.end.dateTime.slice(0, 10) });
      else out.push({ ...base, allDay: false, startUtc: s, endUtc: en });
    }
    next = d['@odata.nextLink'] || null;
  }
  return out;
}

async function accessTokenFor(env, src) {
  const refresh = await openToken(env, src.kind, src.token_enc);
  const t = await exchange(env, src.kind, { grant_type: 'refresh_token', refresh_token: refresh });
  // Microsoft rotates refresh tokens; keep the newest.
  if (t.refresh_token && t.refresh_token !== refresh) await run(env.DB, 'UPDATE calendar_sources SET token_enc = ? WHERE id = ?', await sealToken(env, src.kind, t.refresh_token), src.id);
  return t.access_token;
}

export async function syncAccount(env, src, household, accessToken = null) {
  const t = now();
  try {
    if (!configured(env, src.kind)) throw new HttpError(503, 'not_configured', 'Sign-in for this provider was switched off for the app.');
    const token = accessToken || await accessTokenFor(env, src);
    const { fromMs, toMs } = importWindow(t);
    const cals = JSON.parse(src.calendars || '[]');
    const instances = [];
    for (const c of cals) instances.push(...(src.kind === 'google' ? await googleInstances(env, token, c.id, fromMs, toMs) : await graphInstances(env, token, c.id, fromMs, toMs)));
    const r = await applyInstances(env.DB, src, household, instances.slice(0, 4000));
    await run(env.DB, "UPDATE calendar_sources SET last_sync_at = ?, last_ok_at = ?, last_status = 'ok', last_error = ?, event_count = ? WHERE id = ?",
      t, t, instances.length > 4000 ? 'Very large calendar: only the first 4,000 events in range were imported.' : null, r.total, src.id);
    return { ok: true, ...r };
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : `Update failed: ${String(e.message || e).slice(0, 200)}`;
    await run(env.DB, "UPDATE calendar_sources SET last_sync_at = ?, last_status = 'error', last_error = ? WHERE id = ?", t, msg, src.id);
    return { ok: false, error: msg, code: e.code };
  }
}

// ---------- choose which calendars of the account to show ----------
async function loadAccount(env, ctx, id) {
  const s = await one(env.DB, 'SELECT * FROM calendar_sources WHERE id = ? AND household_id = ? AND deleted_at IS NULL', id, ctx.household.id);
  if (!s || s.kind === 'ics') throw new HttpError(404, 'not_found', 'That connected account no longer exists.');
  if (s.owner_user_id !== ctx.user.id) throw new HttpError(403, 'forbidden', 'Only the person who connected this account can choose its calendars.');
  return s;
}
export async function accountCalendars(req, env, ctx, { id }) {
  const s = await loadAccount(env, ctx, id);
  const token = await accessTokenFor(env, s);
  const all = await listCalendars(env, s.kind, token);
  const sel = new Set(JSON.parse(s.calendars || '[]').map((c) => c.id));
  return json({ calendars: all.map((c) => ({ ...c, selected: sel.has(c.id) })) });
}
export async function setAccountCalendars(req, env, ctx, { id }) {
  const s = await loadAccount(env, ctx, id);
  const body = validate(v.object({ calendars: v.array(v.object({ id: v.string({ min: 1, max: 300 }), name: v.string({ max: 200 }).default('') }), { max: 25 }) }), await readJson(req));
  await run(env.DB, 'UPDATE calendar_sources SET calendars = ? WHERE id = ?', JSON.stringify(body.calendars), id);
  const household = await one(env.DB, 'SELECT * FROM households WHERE id = ?', s.household_id);
  const r = await syncAccount(env, { ...s, calendars: JSON.stringify(body.calendars) }, household);
  return json({ ok: r.ok, sync: r });
}
