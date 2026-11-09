// Sign-up, sign-in, households, family profiles, invitations, data export / deletion.
import { eventVisible, listVisible } from '../lib/audience.js';
import { addToGroup } from './groups.js';
import { notifyActivity } from '../lib/activity.js';
import { HttpError, json, readJson, validate, v, uid, now, randomToken, sha256, EMAIL_RE, COLOR_RE, isValidTimeZone } from '../lib/util.js';
import { one, all, run, nextSeq, audit, rateLimit } from '../lib/db.js';
import { hashPassword, verifyPassword, createSession, sessionCookie, clearCookie, requireRole } from '../lib/auth.js';

// (No placeholder profiles: everyone gets a profile with their own name and an optional label like Mom or Dad.)
const DEFAULT_LISTS = [
  { name: 'To-do', kind: 'todo' },
  { name: 'Groceries', kind: 'shopping' },
  { name: 'Shopping', kind: 'shopping' },
];

const ip = (req) => req.headers.get('cf-connecting-ip') || 'local';

export function memberOut(r) {
  return { id: r.id, name: r.name, label: r.label || null, color: r.color, kind: r.kind, avatar: r.avatar || null, sort: r.sort, version: r.version, seq: r.seq, deleted: !!r.deleted_at };
}

// The name a profile shows up as in the app ("Mom"), falling back to the person's name.
export const memberLabel = (m) => (m && (m.label || m.name)) || '';
export const PROFILE_COLORS = ['#E76F51', '#2A9D8F', '#E9A23B', '#7C6CF2', '#D9487D', '#3A86FF', '#6A994E', '#8D6E63', '#F4A261', '#264653', '#9B5DE5', '#00A6A6'];
const cleanLabel = (x) => { const t = String(x || '').trim().slice(0, 30); return t || null; };

// Creates a family profile for a person (their own name, optional label) and returns its id.
async function createProfileFor(db, householdId, { name, label = null, kind = 'adult' }) {
  const used = (await all(db, 'SELECT color FROM members WHERE household_id = ? AND deleted_at IS NULL', householdId)).map((r) => r.color);
  const count = await one(db, 'SELECT COUNT(*) AS n FROM members WHERE household_id = ? AND deleted_at IS NULL', householdId);
  const id = uid('m_');
  const t = now();
  await run(db, 'INSERT INTO members (id, household_id, name, color, kind, sort, version, seq, created_at, updated_at, label) VALUES (?,?,?,?,?,?,1,?,?,?,?)',
    id, householdId, String(name || 'Me').trim().slice(0, 40), PROFILE_COLORS.find((c) => !used.includes(c)) || PROFILE_COLORS[count.n % PROFILE_COLORS.length], kind, count.n,
    await nextSeq(db, householdId), t, t, cleanLabel(label));
  return id;
}

async function createHousehold(db, { name, timezone }, userId, { userName = null, label = null } = {}) {
  const id = uid('hh_');
  const t = now();
  await run(db, 'INSERT INTO households (id, name, timezone, ics_token, seq, created_at) VALUES (?,?,?,?,0,?)', id, name, timezone, randomToken(24), t);
  // The creator gets a profile with their own name; others are added (or join) with theirs.
  if (!userName) userName = ((await one(db, 'SELECT name FROM users WHERE id = ?', userId)) || {}).name;
  const myProfile = await createProfileFor(db, id, { name: userName, label, kind: 'adult' });
  let sort = 0;
  for (const l of DEFAULT_LISTS) {
    const seq = await nextSeq(db, id);
    await run(db, 'INSERT INTO lists (id, household_id, name, kind, sort, version, seq, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)',
      uid('l_'), id, l.name, l.kind, sort++, seq, t, t);
  }
  await run(db, 'INSERT INTO memberships (household_id, user_id, role, member_id, created_at) VALUES (?,?,?,?,?)', id, userId, 'owner', myProfile, t);
  await run(db, 'UPDATE users SET current_household_id = ? WHERE id = ?', id, userId);
  await audit(db, { householdId: id, userId, action: 'household.create' });
  return id;
}

const signupSchema = v.object({
  name: v.string({ min: 1, max: 60 }),
  email: v.string({ min: 3, max: 200, pattern: EMAIL_RE }),
  password: v.string({ min: 8, max: 200, trim: false }),
  householdName: v.string({ min: 1, max: 60 }).optional(),
  timezone: v.string({ max: 60 }).optional(),
  inviteToken: v.string({ max: 100 }).optional(),
  label: v.string({ max: 30 }).optional(), // how they want to show up, e.g. Mom
});

export async function signup(req, env, ctx) {
  const db = env.DB;
  await rateLimit(db, `signup:${ip(req)}`, 10, 3600);
  const body = validate(signupSchema, await readJson(req));
  const email = body.email.toLowerCase();
  if (await one(db, 'SELECT id FROM users WHERE email = ?', email)) {
    throw new HttpError(409, 'email_taken', 'An account with this email already exists. Try signing in instead.');
  }
  if (!body.inviteToken && !body.householdName) throw new HttpError(422, 'invalid', 'householdName is required', { field: 'householdName' });
  const tz = body.timezone && isValidTimeZone(body.timezone) ? body.timezone : 'America/New_York';
  let invite = null;
  if (body.inviteToken) invite = await findInvite(db, body.inviteToken);

  const pw = await hashPassword(body.password);
  const userId = uid('u_');
  await run(db, 'INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, created_at) VALUES (?,?,?,?,?,?,?)',
    userId, email, body.name, pw.hash, pw.salt, pw.iter, now());
  if (invite) await acceptInvite(db, invite, userId, { label: body.label, env, waitUntil: ctx && ctx.waitUntil });
  else await createHousehold(db, { name: body.householdName, timezone: tz }, userId, { userName: body.name, label: body.label });
  await audit(db, { userId, action: 'user.signup' });
  const token = await createSession(db, userId, req.headers.get('user-agent'));
  return json({ ok: true }, 201, { 'set-cookie': sessionCookie(token, req) });
}

const loginSchema = v.object({
  email: v.string({ min: 3, max: 200 }),
  password: v.string({ min: 1, max: 200, trim: false }),
});

export async function login(req, env) {
  const db = env.DB;
  const body = validate(loginSchema, await readJson(req));
  const email = body.email.toLowerCase();
  await rateLimit(db, `login:ip:${ip(req)}`, 30, 900);
  await rateLimit(db, `login:email:${email}`, 10, 900);
  const user = await one(db, 'SELECT * FROM users WHERE email = ?', email);
  if (!user || !(await verifyPassword(body.password, user))) {
    throw new HttpError(401, 'bad_login', 'That email and password do not match.');
  }
  const token = await createSession(db, user.id, req.headers.get('user-agent'));
  await audit(db, { userId: user.id, action: 'user.login' });
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, req) });
}

export async function logout(req, env, ctx) {
  if (ctx) await run(env.DB, 'DELETE FROM sessions WHERE id = ?', ctx.sessionId);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie(req) });
}

export async function me(req, env, ctx) {
  const db = env.DB;
  const households = await all(db,
    'SELECT h.id, h.name, m.role FROM memberships m JOIN households h ON h.id = m.household_id WHERE m.user_id = ? ORDER BY m.created_at', ctx.user.id);
  return json({
    user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name },
    household: ctx.household ? { id: ctx.household.id, name: ctx.household.name, timezone: ctx.household.timezone } : null,
    role: ctx.role,
    memberId: ctx.memberId,
    ...(await (async () => {
      if (!ctx.household) return { notifyActivity: true, setupNeeded: false };
      const ms = (await one(db, 'SELECT notify_activity, setup_done_at, created_at FROM memberships WHERE household_id = ? AND user_id = ?', ctx.household.id, ctx.user.id)) || {};
      // The setup wizard is for people who join after it was introduced; earlier members can open it from More.
      return { notifyActivity: ms.notify_activity !== 0, setupNeeded: !ms.setup_done_at && Number(ms.created_at || 0) > SETUP_WIZARD_SINCE };
    })()),
    households,
    features: {
      assistant: !!env.ANTHROPIC_API_KEY,
      voice: !!env.AI,
      places: !!env.GEOAPIFY_API_KEY,
      googleCalendar: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      microsoftCalendar: !!(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET),
      icloudCalendar: !!env.CREDENTIALS_KEY,
    },
  });
}

// Personal settings for this household (currently: family-activity alerts on/off).
const SETUP_WIZARD_SINCE = Date.UTC(2026, 10, 9, 4, 0); // 8 Nov 2026, 11 PM New York
export async function updatePrefs(req, env, ctx) {
  const body = validate(v.object({ notifyActivity: v.boolean().optional(), setupDone: v.boolean().optional() }), await readJson(req));
  if (body.notifyActivity !== undefined) await run(env.DB, 'UPDATE memberships SET notify_activity = ? WHERE household_id = ? AND user_id = ?', body.notifyActivity ? 1 : 0, ctx.household.id, ctx.user.id);
  if (body.setupDone !== undefined) await run(env.DB, 'UPDATE memberships SET setup_done_at = ? WHERE household_id = ? AND user_id = ?', body.setupDone ? now() : null, ctx.household.id, ctx.user.id);
  return json({ ok: true, ...body });
}

export async function switchHousehold(req, env, ctx) {
  const { householdId } = validate(v.object({ householdId: v.string({ min: 1, max: 60 }) }), await readJson(req));
  const m = await one(env.DB, 'SELECT 1 FROM memberships WHERE user_id = ? AND household_id = ?', ctx.user.id, householdId);
  if (!m) throw new HttpError(403, 'forbidden', 'You are not a member of that household.');
  await run(env.DB, 'UPDATE users SET current_household_id = ? WHERE id = ?', householdId, ctx.user.id);
  return json({ ok: true });
}

export async function newHousehold(req, env, ctx) {
  const body = validate(v.object({ name: v.string({ min: 1, max: 60 }), timezone: v.string({ max: 60 }).optional() }), await readJson(req));
  const tz = body.timezone && isValidTimeZone(body.timezone) ? body.timezone : 'America/New_York';
  const id = await createHousehold(env.DB, { name: body.name, timezone: tz }, ctx.user.id);
  return json({ ok: true, id }, 201);
}

export async function updateHousehold(req, env, ctx) {
  requireRole(ctx, ['owner']);
  const body = validate(v.object({
    name: v.string({ min: 1, max: 60 }).optional(), timezone: v.string({ max: 60 }).optional(),
    holidays: v.string({ oneOf: ['auto', 'US', 'none'] }).optional(), // which public holidays to show on the calendar
  }), await readJson(req));
  if (body.timezone && !isValidTimeZone(body.timezone)) throw new HttpError(422, 'invalid', 'timezone is not a valid time zone', { field: 'timezone' });
  await run(env.DB, 'UPDATE households SET name = COALESCE(?, name), timezone = COALESCE(?, timezone) WHERE id = ?',
    body.name ?? null, body.timezone ?? null, ctx.household.id);
  if (body.holidays) await run(env.DB, 'UPDATE households SET holidays = ? WHERE id = ?', body.holidays === 'auto' ? null : body.holidays, ctx.household.id);
  await audit(env.DB, { householdId: ctx.household.id, userId: ctx.user.id, action: 'household.update', detail: body });
  return json({ ok: true });
}

// ---------- family profiles ----------
// A profile picture is either a small photo (data URL, resized on the device) or an emoji avatar.
const AVATAR_MAX = 120_000;
function cleanAvatar(x) {
  if (x === null || x === undefined || x === '') return null;
  const s = String(x);
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= AVATAR_MAX) return s;
  if (s.length <= 16 && !/^data:/.test(s) && !/[<>&"'\\]/.test(s)) return s;
  throw new HttpError(422, 'invalid', 'The picture must be a JPEG, PNG or WebP photo under about 80 KB, or an emoji.', { field: 'avatar' });
}

const memberSchema = v.object({
  name: v.string({ min: 1, max: 40 }),
  color: v.string({ pattern: COLOR_RE }),
  kind: v.string({ oneOf: ['adult', 'child'] }).default('adult'),
  sort: v.number({ int: true, min: 0, max: 999 }).optional(),
  avatar: v.string({ max: AVATAR_MAX }).nullable(),
  label: v.string({ max: 30 }).nullable(),
});

export async function createMember(req, env, ctx) {
  requireRole(ctx, ['owner', 'adult']);
  const body = validate(memberSchema, await readJson(req));
  const db = env.DB;
  const count = await one(db, 'SELECT COUNT(*) AS n FROM members WHERE household_id = ? AND deleted_at IS NULL', ctx.household.id);
  if (count.n >= 20) throw new HttpError(422, 'limit', 'A household can have up to 20 family members.');
  const seq = await nextSeq(db, ctx.household.id);
  const id = uid('m_');
  const t = now();
  await run(db, 'INSERT INTO members (id, household_id, name, color, kind, sort, version, seq, created_at, updated_at, avatar, label) VALUES (?,?,?,?,?,?,1,?,?,?,?,?)',
    id, ctx.household.id, body.name, body.color, body.kind, body.sort ?? count.n, seq, t, t, cleanAvatar(body.avatar), cleanLabel(body.label));
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'member.create', refType: 'member', refId: id });
  return json({ member: memberOut(await one(db, 'SELECT * FROM members WHERE id = ?', id)) }, 201);
}

export async function updateMember(req, env, ctx, { id }) {
  requireRole(ctx, ['owner', 'adult']);
  const body = await readJson(req);
  const patch = validate(v.object({
    avatar: v.string({ max: AVATAR_MAX }).nullable(),
    label: v.string({ max: 30 }).nullable(),
    name: v.string({ min: 1, max: 40 }).optional(),
    color: v.string({ pattern: COLOR_RE }).optional(),
    kind: v.string({ oneOf: ['adult', 'child'] }).optional(),
    sort: v.number({ int: true, min: 0, max: 999 }).optional(),
    version: v.number({ int: true, min: 1 }),
  }), body);
  const db = env.DB;
  const cur = await one(db, 'SELECT * FROM members WHERE id = ? AND household_id = ? AND deleted_at IS NULL', id, ctx.household.id);
  if (!cur) throw new HttpError(404, 'not_found', 'Family member not found.');
  if (cur.version !== patch.version) throw new HttpError(409, 'conflict', 'Someone else changed this profile. Here is the latest version.', { current: memberOut(cur) });
  const seq = await nextSeq(db, ctx.household.id);
  const avatar = 'avatar' in body ? cleanAvatar(patch.avatar) : cur.avatar;
  const label = 'label' in body ? cleanLabel(patch.label) : cur.label;
  await run(db, 'UPDATE members SET name = ?, color = ?, kind = ?, sort = ?, avatar = ?, label = ?, version = version + 1, seq = ?, updated_at = ? WHERE id = ?',
    patch.name ?? cur.name, patch.color ?? cur.color, patch.kind ?? cur.kind, patch.sort ?? cur.sort, avatar, label, seq, now(), id);
  return json({ member: memberOut(await one(db, 'SELECT * FROM members WHERE id = ?', id)) });
}

export async function deleteMember(req, env, ctx, { id }) {
  requireRole(ctx, ['owner', 'adult']);
  const db = env.DB;
  const cur = await one(db, 'SELECT * FROM members WHERE id = ? AND household_id = ? AND deleted_at IS NULL', id, ctx.household.id);
  if (!cur) throw new HttpError(404, 'not_found', 'Family member not found.');
  const remaining = await one(db, 'SELECT COUNT(*) AS n FROM members WHERE household_id = ? AND deleted_at IS NULL', ctx.household.id);
  if (remaining.n <= 1) throw new HttpError(422, 'last_member', 'A household needs at least one family member.');
  const seq = await nextSeq(db, ctx.household.id);
  await run(db, 'UPDATE members SET deleted_at = ?, seq = ?, version = version + 1 WHERE id = ?', now(), seq, id);
  await run(db, 'UPDATE memberships SET member_id = NULL WHERE member_id = ?', id);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'member.delete', refType: 'member', refId: id });
  return json({ ok: true });
}

// ---------- invitations ----------
async function findInvite(db, token) {
  const id = await sha256(token);
  const inv = await one(db, `SELECT i.*, h.name AS household_name, g.name AS group_name, g.deleted_at AS group_deleted FROM invites i
     JOIN households h ON h.id = i.household_id LEFT JOIN family_groups g ON g.id = i.group_id WHERE i.id = ?`, id);
  if (!inv) throw new HttpError(404, 'invite_invalid', 'This invitation link is not valid.');
  if (inv.group_id && (!inv.group_name || inv.group_deleted)) throw new HttpError(410, 'invite_invalid', 'This group link no longer works because the group was deleted.');
  if ((inv.max_uses || 1) > 1) {
    if (inv.uses >= inv.max_uses) throw new HttpError(410, 'invite_used', 'This group link has been used the maximum number of times. Ask for a new one.');
  } else if (inv.used_at) throw new HttpError(410, 'invite_used', 'This invitation has already been used.');
  if (inv.expires_at < now()) throw new HttpError(410, 'invite_expired', 'This invitation has expired. Ask for a new one.');
  return inv;
}

async function acceptInvite(db, inv, userId, { label = null, env = null, waitUntil = null } = {}) {
  const exists = await one(db, 'SELECT 1 FROM memberships WHERE household_id = ? AND user_id = ?', inv.household_id, userId);
  if (!exists && !inv.member_id) {
    // No profile picked for this invitation: give them their own, with their name.
    const u = await one(db, 'SELECT name FROM users WHERE id = ?', userId);
    inv = { ...inv, member_id: await createProfileFor(db, inv.household_id, { name: u ? u.name : 'New member', label, kind: inv.role === 'child' ? 'child' : 'adult' }) };
  } else if (!exists && label) {
    await run(db, 'UPDATE members SET label = COALESCE(label, ?), seq = ? WHERE id = ?', cleanLabel(label), await nextSeq(db, inv.household_id), inv.member_id);
  }
  if (!exists) {
    // The owner chose a profile for this invitation: it becomes this person's (one login per profile).
    if (inv.member_id) await run(db, 'UPDATE memberships SET member_id = NULL WHERE household_id = ? AND member_id = ?', inv.household_id, inv.member_id);
    await run(db, 'INSERT INTO memberships (household_id, user_id, role, member_id, created_at) VALUES (?,?,?,?,?)',
      inv.household_id, userId, inv.role, inv.member_id, now());
  }
  let joinedGroup = false;
  if (inv.group_id) {
    // Group link: their profile joins the group (also works for people already in the household).
    const m = await one(db, 'SELECT member_id FROM memberships WHERE household_id = ? AND user_id = ?', inv.household_id, userId);
    if (m && m.member_id) {
      const g = await one(db, 'SELECT member_ids FROM family_groups WHERE id = ?', inv.group_id);
      joinedGroup = !JSON.parse((g && g.member_ids) || '[]').includes(m.member_id);
      await addToGroup(db, inv.household_id, inv.group_id, m.member_id);
    }
  }
  // Let the rest of the family know someone new joined (the family, or a group).
  if (env && (!exists || joinedGroup)) {
    try {
      const u = await one(db, 'SELECT name FROM users WHERE id = ?', userId);
      const others = (await all(db, 'SELECT user_id FROM memberships WHERE household_id = ? AND user_id != ?', inv.household_id, userId)).map((r) => r.user_id);
      const who = (u && u.name) || 'Someone';
      const where = inv.group_id && inv.group_name ? `“${inv.group_name}”` : (inv.household_name || 'the family');
      await notifyActivity({ env, waitUntil, household: { id: inv.household_id }, user: { id: userId } }, {
        userIds: others, title: `${who} joined ${where}`,
        body: !exists ? `${who} now has Family Flow and can see the family calendar.` : `${who} was added to ${where}.`,
        refType: 'people', refId: userId,
      });
    } catch (e) { console.error('join notification failed', e); }
  }
  if ((inv.max_uses || 1) > 1) await run(db, 'UPDATE invites SET uses = uses + 1, used_at = ?, used_by = ? WHERE id = ? AND uses < max_uses', now(), userId, inv.id);
  else await run(db, 'UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL', now(), userId, inv.id);
  await run(db, 'UPDATE users SET current_household_id = ? WHERE id = ?', inv.household_id, userId);
  await audit(db, { householdId: inv.household_id, userId, action: 'invite.accept' });
}

export async function createInvite(req, env, ctx) {
  const body = validate(v.object({
    role: v.string({ oneOf: ['adult', 'child'] }).default('adult'),
    memberId: v.string({ max: 60 }).optional(),
    groupId: v.string({ max: 60 }).optional(),
  }), await readJson(req));
  // Group links can be made by any adult (they manage groups); one-person invitations by owners.
  requireRole(ctx, body.groupId ? ['owner', 'adult'] : ['owner']);
  const db = env.DB;
  if (body.groupId) {
    const g = await one(db, 'SELECT id, name FROM family_groups WHERE id = ? AND household_id = ? AND deleted_at IS NULL', body.groupId, ctx.household.id);
    if (!g) throw new HttpError(422, 'invalid', 'That group no longer exists.', { field: 'groupId' });
    await rateLimit(db, `invite:${ctx.household.id}`, 30, 86400);
    const token = randomToken(24);
    // Shareable in a group chat: up to 30 people, 14 days.
    await run(db, 'INSERT INTO invites (id, household_id, role, member_id, created_by, created_at, expires_at, group_id, max_uses, uses) VALUES (?,?,?,?,?,?,?,?,?,0)',
      await sha256(token), ctx.household.id, 'adult', null, ctx.user.id, now(), now() + 14 * 86400000, g.id, 30);
    await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'invite.create', detail: { group: g.id } });
    return json({ token, url: `${new URL(req.url).origin}/#/join/${token}`, expiresInDays: 14, maxUses: 30, groupName: g.name }, 201);
  }
  if (body.memberId && !(await one(db, 'SELECT 1 FROM members WHERE id = ? AND household_id = ? AND deleted_at IS NULL', body.memberId, ctx.household.id))) {
    throw new HttpError(422, 'invalid', 'memberId does not belong to this household', { field: 'memberId' });
  }
  await rateLimit(db, `invite:${ctx.household.id}`, 30, 86400);
  const token = randomToken(24);
  await run(db, 'INSERT INTO invites (id, household_id, role, member_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
    await sha256(token), ctx.household.id, body.role, body.memberId ?? null, ctx.user.id, now(), now() + 7 * 86400000);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'invite.create', detail: { role: body.role } });
  const url = `${new URL(req.url).origin}/#/join/${token}`;
  return json({ token, url, expiresInDays: 7 }, 201);
}

export async function inviteInfo(req, env, ctx, { token }) {
  await rateLimit(env.DB, `inviteinfo:${ip(req)}`, 60, 3600);
  const inv = await findInvite(env.DB, token);
  return json({ householdName: inv.household_name, role: inv.role, groupName: inv.group_id ? inv.group_name : null });
}

export async function joinWithInvite(req, env, ctx, { token }) {
  const inv = await findInvite(env.DB, token);
  await acceptInvite(env.DB, inv, ctx.user.id, { env, waitUntil: ctx.waitUntil });
  return json({ ok: true, householdId: inv.household_id });
}

export async function listPeople(req, env, ctx) {
  requireRole(ctx, ['owner', 'adult', 'child']);
  const people = await all(env.DB,
    'SELECT u.id, u.name, u.email, m.role, m.member_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? ORDER BY m.created_at', ctx.household.id);
  return json({ people: people.map((p) => ({ ...p, email: ctx.role !== 'child' || p.id === ctx.user.id ? p.email : undefined })) });
}

async function checkProfile(db, ctx, memberId) {
  if (!(await one(db, 'SELECT 1 FROM members WHERE id = ? AND household_id = ? AND deleted_at IS NULL', memberId, ctx.household.id))) {
    throw new HttpError(422, 'invalid', 'That family profile no longer exists.', { field: 'memberId' });
  }
}

// "This is me": anyone can choose which family profile is them (or create one with their name).
export async function linkMyProfile(req, env, ctx) {
  const body = validate(v.object({ memberId: v.string({ max: 60 }).nullable(), createNamed: v.string({ min: 1, max: 40 }).optional() }), await readJson(req));
  const db = env.DB;
  let memberId = body.memberId ?? null;
  if (body.createNamed) {
    const count = await one(db, 'SELECT COUNT(*) AS n FROM members WHERE household_id = ? AND deleted_at IS NULL', ctx.household.id);
    if (count.n >= 20) throw new HttpError(422, 'limit', 'A household can have up to 20 family members.');
    memberId = await createProfileFor(db, ctx.household.id, { name: body.createNamed, kind: ctx.role === 'child' ? 'child' : 'adult' });
  } else if (memberId) {
    await checkProfile(db, ctx, memberId);
    const taken = await one(db, 'SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? AND m.member_id = ? AND m.user_id != ?', ctx.household.id, memberId, ctx.user.id);
    if (taken && ctx.role !== 'owner') throw new HttpError(409, 'taken', `That profile is already ${taken.name}’s. Ask the household owner to change it.`);
    if (taken) await run(db, 'UPDATE memberships SET member_id = NULL WHERE household_id = ? AND member_id = ? AND user_id != ?', ctx.household.id, memberId, ctx.user.id);
  }
  await run(db, 'UPDATE memberships SET member_id = ? WHERE household_id = ? AND user_id = ?', memberId, ctx.household.id, ctx.user.id);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'person.link_profile', detail: { memberId } });
  return json({ ok: true, memberId });
}

export async function updatePerson(req, env, ctx, { userId }) {
  requireRole(ctx, ['owner']);
  const body = validate(v.object({
    role: v.string({ oneOf: ['owner', 'adult', 'child'] }).optional(),
    memberId: v.string({ max: 60 }).nullable(),
  }), await readJson(req));
  const db = env.DB;
  const target = await one(db, 'SELECT * FROM memberships WHERE household_id = ? AND user_id = ?', ctx.household.id, userId);
  if (!target) throw new HttpError(404, 'not_found', 'Person not found in this household.');
  if (body.role && body.role !== 'owner' && target.role === 'owner') {
    const owners = await one(db, "SELECT COUNT(*) AS n FROM memberships WHERE household_id = ? AND role = 'owner'", ctx.household.id);
    if (owners.n <= 1) throw new HttpError(422, 'last_owner', 'The household needs at least one owner.');
  }
  if (body.memberId) {
    await checkProfile(db, ctx, body.memberId);
    // One login per profile: whoever had it is unlinked.
    await run(db, 'UPDATE memberships SET member_id = NULL WHERE household_id = ? AND member_id = ? AND user_id != ?', ctx.household.id, body.memberId, userId);
  }
  await run(db, 'UPDATE memberships SET role = COALESCE(?, role), member_id = CASE WHEN ? THEN ? ELSE member_id END WHERE household_id = ? AND user_id = ?',
    body.role ?? null, body.memberId !== undefined ? 1 : 0, body.memberId ?? null, ctx.household.id, userId);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'person.update', refType: 'user', refId: userId, detail: body });
  return json({ ok: true });
}

export async function removePerson(req, env, ctx, { userId }) {
  const db = env.DB;
  if (userId !== ctx.user.id) requireRole(ctx, ['owner']);
  const target = await one(db, 'SELECT * FROM memberships WHERE household_id = ? AND user_id = ?', ctx.household.id, userId);
  if (!target) throw new HttpError(404, 'not_found', 'Person not found in this household.');
  if (target.role === 'owner') {
    const owners = await one(db, "SELECT COUNT(*) AS n FROM memberships WHERE household_id = ? AND role = 'owner'", ctx.household.id);
    if (owners.n <= 1) throw new HttpError(422, 'last_owner', 'The last owner cannot leave. Delete the household instead, or make someone else an owner first.');
  }
  await run(db, 'DELETE FROM memberships WHERE household_id = ? AND user_id = ?', ctx.household.id, userId);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'person.remove', refType: 'user', refId: userId });
  return json({ ok: true });
}

// ---------- export / delete ----------
export async function exportHousehold(req, env, ctx) {
  requireRole(ctx, ['owner', 'adult']);
  const db = env.DB;
  const hh = ctx.household.id;
  const data = {
    exportedAt: new Date().toISOString(),
    household: await one(db, 'SELECT id, name, timezone, created_at FROM households WHERE id = ?', hh),
    members: await all(db, 'SELECT * FROM members WHERE household_id = ? AND deleted_at IS NULL', hh),
    events: (await all(db, 'SELECT * FROM events WHERE household_id = ? AND deleted_at IS NULL', hh)).filter((r) => eventVisible(r, ctx)),
    lists: (await all(db, 'SELECT * FROM lists WHERE household_id = ? AND deleted_at IS NULL', hh)).filter((r) => listVisible(r, ctx)),
    tasks: await all(db, 'SELECT * FROM tasks WHERE household_id = ? AND deleted_at IS NULL', hh),
    groups: await all(db, 'SELECT id, name, member_ids FROM family_groups WHERE household_id = ? AND deleted_at IS NULL', hh),
    places: await all(db, 'SELECT * FROM places WHERE household_id = ?', hh),
  };
  const listIds = new Set(data.lists.map((l) => l.id));
  data.tasks = data.tasks.filter((t) => listIds.has(t.list_id));
  await audit(db, { householdId: hh, userId: ctx.user.id, action: 'household.export' });
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="family-flow-export-${data.exportedAt.slice(0, 10)}.json"`,
      'cache-control': 'no-store',
    },
  });
}

export async function deleteHousehold(req, env, ctx) {
  requireRole(ctx, ['owner']);
  const body = validate(v.object({ confirm: v.string({ max: 100 }) }), await readJson(req));
  if (body.confirm !== ctx.household.name) throw new HttpError(422, 'confirm', 'Type the household name exactly to confirm deletion.');
  const db = env.DB;
  const hh = ctx.household.id;
  for (const t of ['scheduled_notifications', 'notifications', 'proposals', 'events', 'calendar_sources', 'oauth_states', 'tasks', 'lists', 'places', 'members', 'invites', 'memberships']) {
    await run(db, `DELETE FROM ${t} WHERE household_id = ?`, hh);
  }
  await run(db, 'DELETE FROM conversations WHERE household_id = ?', hh);
  await run(db, 'DELETE FROM usage WHERE household_id = ?', hh);
  await run(db, 'DELETE FROM households WHERE id = ?', hh);
  await run(db, 'UPDATE users SET current_household_id = NULL WHERE current_household_id = ?', hh);
  await audit(db, { householdId: hh, userId: ctx.user.id, action: 'household.delete' });
  return json({ ok: true });
}

export async function deleteAccount(req, env, ctx) {
  const body = validate(v.object({ password: v.string({ min: 1, max: 200, trim: false }) }), await readJson(req));
  const db = env.DB;
  const user = await one(db, 'SELECT * FROM users WHERE id = ?', ctx.user.id);
  if (!(await verifyPassword(body.password, user))) throw new HttpError(401, 'bad_password', 'Password is incorrect.');
  const owned = await all(db, "SELECT household_id FROM memberships WHERE user_id = ? AND role = 'owner'", ctx.user.id);
  for (const o of owned) {
    const others = await one(db, "SELECT COUNT(*) AS n FROM memberships WHERE household_id = ? AND role = 'owner' AND user_id != ?", o.household_id, ctx.user.id);
    if (others.n === 0) {
      throw new HttpError(422, 'sole_owner', 'You are the only owner of a household. Make someone else an owner or delete the household first.');
    }
  }
  await run(db, 'DELETE FROM memberships WHERE user_id = ?', ctx.user.id);
  await run(db, 'DELETE FROM users WHERE id = ?', ctx.user.id); // cascades sessions + push subscriptions
  await audit(db, { userId: ctx.user.id, action: 'user.delete' });
  return json({ ok: true }, 200, { 'set-cookie': clearCookie(req) });
}

export async function changePassword(req, env, ctx) {
  const body = validate(v.object({
    current: v.string({ min: 1, max: 200, trim: false }),
    next: v.string({ min: 8, max: 200, trim: false }),
  }), await readJson(req));
  const db = env.DB;
  const user = await one(db, 'SELECT * FROM users WHERE id = ?', ctx.user.id);
  if (!(await verifyPassword(body.current, user))) throw new HttpError(401, 'bad_password', 'Current password is incorrect.');
  const pw = await hashPassword(body.next);
  await run(db, 'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?', pw.hash, pw.salt, pw.iter, ctx.user.id);
  await run(db, 'DELETE FROM sessions WHERE user_id = ? AND id != ?', ctx.user.id, ctx.sessionId);
  await audit(db, { userId: ctx.user.id, action: 'user.password' });
  return json({ ok: true });
}

// ---------- password reset links (no email service needed: the owner sends the link by text/WhatsApp) ----------
const RESET_HOURS = 48;
export async function createResetLink(req, env, ctx, params) {
  const db = env.DB;
  const userId = params.userId;
  const target = await one(db, 'SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? AND m.user_id = ?', ctx.household.id, userId);
  if (!target) throw new HttpError(404, 'not_found', 'That person isn’t in this household.');
  // Owners can reset anyone here; other adults only children's logins.
  if (ctx.role !== 'owner' && !(ctx.role === 'adult' && target.role === 'child')) throw new HttpError(403, 'forbidden', 'Only the household owner can send a password reset link.');
  if (target.id === ctx.user.id) throw new HttpError(422, 'invalid', 'To change your own password use Account → Change password.');
  await rateLimit(db, `reset:${ctx.user.id}`, 10, 3600);
  const token = randomToken(24);
  const t = now();
  await run(db, 'UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', t, target.id); // older links stop working
  await run(db, 'INSERT INTO password_resets (id, user_id, household_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)',
    await sha256(token), target.id, ctx.household.id, ctx.user.id, t, t + RESET_HOURS * 3600000);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'user.reset_link', refType: 'user', refId: target.id });
  const origin = new URL(req.url).origin;
  return json({ url: `${origin}/#/reset/${token}`, name: target.name, email: target.email, hours: RESET_HOURS }, 201);
}

async function findReset(db, token) {
  const r = await one(db, 'SELECT r.*, u.name, u.email FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.id = ?', await sha256(String(token || '')));
  if (!r || r.used_at) throw new HttpError(410, 'reset_invalid', 'This reset link has already been used or replaced. Ask for a new one.');
  if (r.expires_at < now()) throw new HttpError(410, 'reset_expired', 'This reset link has expired. Ask for a new one.');
  return r;
}
export async function resetInfo(req, env, ctx, params) {
  await rateLimit(env.DB, `resetinfo:${ip(req)}`, 30, 900);
  const r = await findReset(env.DB, params.token);
  return json({ name: r.name, email: r.email });
}
export async function resetPassword(req, env, ctx, params) {
  const db = env.DB;
  await rateLimit(db, `resetpw:${ip(req)}`, 20, 900);
  const body = validate(v.object({ password: v.string({ min: 8, max: 200, trim: false }) }), await readJson(req));
  const r = await findReset(db, params.token);
  const pw = await hashPassword(body.password);
  await run(db, 'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?', pw.hash, pw.salt, pw.iter, r.user_id);
  await run(db, 'UPDATE password_resets SET used_at = ? WHERE id = ?', now(), r.id);
  await run(db, 'DELETE FROM sessions WHERE user_id = ?', r.user_id); // sign out everywhere else
  await audit(db, { userId: r.user_id, action: 'user.password_reset' });
  const token = await createSession(db, r.user_id, req.headers.get('user-agent'));
  return json({ ok: true, email: r.email }, 200, { 'set-cookie': sessionCookie(token, req) });
}
