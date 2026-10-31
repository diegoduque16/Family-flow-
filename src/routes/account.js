// Sign-up, sign-in, households, family profiles, invitations, data export / deletion.
import { HttpError, json, readJson, validate, v, uid, now, randomToken, sha256, EMAIL_RE, COLOR_RE, isValidTimeZone } from '../lib/util.js';
import { one, all, run, nextSeq, audit, rateLimit } from '../lib/db.js';
import { hashPassword, verifyPassword, createSession, sessionCookie, clearCookie, requireRole } from '../lib/auth.js';

export const DEFAULT_MEMBERS = [
  { name: 'Mom', color: '#E76F51', kind: 'adult' },
  { name: 'Dad', color: '#2A9D8F', kind: 'adult' },
  { name: 'Kiddo 1', color: '#E9A23B', kind: 'child' },
  { name: 'Kiddo 2', color: '#7C6CF2', kind: 'child' },
];
const DEFAULT_LISTS = [
  { name: 'To-do', kind: 'todo' },
  { name: 'Groceries', kind: 'shopping' },
  { name: 'Shopping', kind: 'shopping' },
];

const ip = (req) => req.headers.get('cf-connecting-ip') || 'local';

export function memberOut(r) {
  return { id: r.id, name: r.name, color: r.color, kind: r.kind, sort: r.sort, version: r.version, seq: r.seq, deleted: !!r.deleted_at };
}

async function createHousehold(db, { name, timezone }, userId) {
  const id = uid('hh_');
  const t = now();
  await run(db, 'INSERT INTO households (id, name, timezone, ics_token, seq, created_at) VALUES (?,?,?,?,0,?)', id, name, timezone, randomToken(24), t);
  let sort = 0;
  const memberIds = [];
  for (const m of DEFAULT_MEMBERS) {
    const seq = await nextSeq(db, id);
    const mid = uid('m_');
    memberIds.push(mid);
    await run(db, 'INSERT INTO members (id, household_id, name, color, kind, sort, version, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)',
      mid, id, m.name, m.color, m.kind, sort++, seq, t, t);
  }
  sort = 0;
  for (const l of DEFAULT_LISTS) {
    const seq = await nextSeq(db, id);
    await run(db, 'INSERT INTO lists (id, household_id, name, kind, sort, version, seq, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)',
      uid('l_'), id, l.name, l.kind, sort++, seq, t, t);
  }
  await run(db, 'INSERT INTO memberships (household_id, user_id, role, member_id, created_at) VALUES (?,?,?,?,?)', id, userId, 'owner', memberIds[0], t);
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
});

export async function signup(req, env) {
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
  if (invite) await acceptInvite(db, invite, userId);
  else await createHousehold(db, { name: body.householdName, timezone: tz }, userId);
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
    households,
    features: {
      assistant: !!env.ANTHROPIC_API_KEY,
      voice: !!env.AI,
      places: !!env.GEOAPIFY_API_KEY,
    },
  });
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
  const body = validate(v.object({ name: v.string({ min: 1, max: 60 }).optional(), timezone: v.string({ max: 60 }).optional() }), await readJson(req));
  if (body.timezone && !isValidTimeZone(body.timezone)) throw new HttpError(422, 'invalid', 'timezone is not a valid time zone', { field: 'timezone' });
  await run(env.DB, 'UPDATE households SET name = COALESCE(?, name), timezone = COALESCE(?, timezone) WHERE id = ?',
    body.name ?? null, body.timezone ?? null, ctx.household.id);
  await audit(env.DB, { householdId: ctx.household.id, userId: ctx.user.id, action: 'household.update', detail: body });
  return json({ ok: true });
}

// ---------- family profiles ----------
const memberSchema = v.object({
  name: v.string({ min: 1, max: 40 }),
  color: v.string({ pattern: COLOR_RE }),
  kind: v.string({ oneOf: ['adult', 'child'] }).default('adult'),
  sort: v.number({ int: true, min: 0, max: 999 }).optional(),
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
  await run(db, 'INSERT INTO members (id, household_id, name, color, kind, sort, version, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)',
    id, ctx.household.id, body.name, body.color, body.kind, body.sort ?? count.n, seq, t, t);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'member.create', refType: 'member', refId: id });
  return json({ member: memberOut(await one(db, 'SELECT * FROM members WHERE id = ?', id)) }, 201);
}

export async function updateMember(req, env, ctx, { id }) {
  requireRole(ctx, ['owner', 'adult']);
  const body = await readJson(req);
  const patch = validate(v.object({
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
  await run(db, 'UPDATE members SET name = ?, color = ?, kind = ?, sort = ?, version = version + 1, seq = ?, updated_at = ? WHERE id = ?',
    patch.name ?? cur.name, patch.color ?? cur.color, patch.kind ?? cur.kind, patch.sort ?? cur.sort, seq, now(), id);
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
  const inv = await one(db, 'SELECT i.*, h.name AS household_name FROM invites i JOIN households h ON h.id = i.household_id WHERE i.id = ?', id);
  if (!inv) throw new HttpError(404, 'invite_invalid', 'This invitation link is not valid.');
  if (inv.used_at) throw new HttpError(410, 'invite_used', 'This invitation has already been used.');
  if (inv.expires_at < now()) throw new HttpError(410, 'invite_expired', 'This invitation has expired. Ask for a new one.');
  return inv;
}

async function acceptInvite(db, inv, userId) {
  const exists = await one(db, 'SELECT 1 FROM memberships WHERE household_id = ? AND user_id = ?', inv.household_id, userId);
  if (!exists) {
    await run(db, 'INSERT INTO memberships (household_id, user_id, role, member_id, created_at) VALUES (?,?,?,?,?)',
      inv.household_id, userId, inv.role, inv.member_id, now());
  }
  await run(db, 'UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL', now(), userId, inv.id);
  await run(db, 'UPDATE users SET current_household_id = ? WHERE id = ?', inv.household_id, userId);
  await audit(db, { householdId: inv.household_id, userId, action: 'invite.accept' });
}

export async function createInvite(req, env, ctx) {
  requireRole(ctx, ['owner']);
  const body = validate(v.object({
    role: v.string({ oneOf: ['adult', 'child'] }).default('adult'),
    memberId: v.string({ max: 60 }).optional(),
  }), await readJson(req));
  const db = env.DB;
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
  return json({ householdName: inv.household_name, role: inv.role });
}

export async function joinWithInvite(req, env, ctx, { token }) {
  const inv = await findInvite(env.DB, token);
  await acceptInvite(env.DB, inv, ctx.user.id);
  return json({ ok: true, householdId: inv.household_id });
}

export async function listPeople(req, env, ctx) {
  requireRole(ctx, ['owner', 'adult', 'child']);
  const people = await all(env.DB,
    'SELECT u.id, u.name, u.email, m.role, m.member_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? ORDER BY m.created_at', ctx.household.id);
  return json({ people: people.map((p) => ({ ...p, email: ctx.role === 'owner' || p.id === ctx.user.id ? p.email : undefined })) });
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
    events: await all(db, "SELECT * FROM events WHERE household_id = ? AND deleted_at IS NULL AND (visibility = 'shared' OR owner_user_id = ?)", hh, ctx.user.id),
    lists: await all(db, 'SELECT * FROM lists WHERE household_id = ? AND deleted_at IS NULL', hh),
    tasks: await all(db, 'SELECT * FROM tasks WHERE household_id = ? AND deleted_at IS NULL', hh),
    places: await all(db, 'SELECT * FROM places WHERE household_id = ?', hh),
  };
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
  for (const t of ['scheduled_notifications', 'notifications', 'proposals', 'events', 'calendar_sources', 'tasks', 'lists', 'places', 'members', 'invites', 'memberships']) {
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
