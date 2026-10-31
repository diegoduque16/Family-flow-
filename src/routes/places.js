// Address / place autocomplete: saved places first, then Geoapify, falling back to Photon (OSM).
import { HttpError, json, readJson, validate, v, uid, now } from '../lib/util.js';
import { one, all, run, useQuota, rateLimit } from '../lib/db.js';

export async function rememberPlace(db, householdId, p) {
  if (!p.address) return;
  await run(db,
    `INSERT INTO places (id, household_id, name, address, lat, lon, favorite, use_count, last_used_at, created_at)
     VALUES (?,?,?,?,?,?,0,1,?,?)
     ON CONFLICT(household_id, address) DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at,
       name = CASE WHEN excluded.name != '' THEN excluded.name ELSE places.name END,
       lat = COALESCE(excluded.lat, places.lat), lon = COALESCE(excluded.lon, places.lon)`,
    uid('p_'), householdId, p.name || '', p.address, p.lat ?? null, p.lon ?? null, now(), now());
}

function placeOut(r) {
  return { id: r.id, name: r.name, address: r.address, lat: r.lat, lon: r.lon, favorite: !!r.favorite, source: 'saved' };
}

async function cached(env, key, ttl, fn) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const req = new Request(`https://cache.familyflow.internal/${encodeURIComponent(key)}`);
  if (cache) {
    const hit = await cache.match(req);
    if (hit) return hit.json();
  }
  const data = await fn();
  if (cache && data) {
    await cache.put(req, new Response(JSON.stringify(data), { headers: { 'cache-control': `max-age=${ttl}`, 'content-type': 'application/json' } }));
  }
  return data;
}

// Accept either the bare key or a pasted example URL containing "apiKey=...".
export function geoapifyKey(raw) {
  const s = String(raw || '').trim();
  const m = /[?&]apiKey=([A-Za-z0-9]+)/.exec(s);
  return m ? m[1] : s;
}

export async function geoapify(env, q, near, fetchImpl = fetch, timeoutMs = 5000) {
  if (!env.GEOAPIFY_API_KEY) throw new Error('GEOAPIFY_API_KEY not configured');
  const u = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
  u.searchParams.set('text', q);
  u.searchParams.set('filter', 'countrycode:us');
  u.searchParams.set('limit', '6');
  u.searchParams.set('format', 'json');
  u.searchParams.set('lang', 'en');
  if (near) u.searchParams.set('bias', `proximity:${near.lon},${near.lat}`);
  u.searchParams.set('apiKey', geoapifyKey(env.GEOAPIFY_API_KEY));
  const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Geoapify HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({
    name: r.name && r.name !== r.address_line1 ? r.name : (r.result_type === 'amenity' || r.result_type === 'building' ? r.address_line1 : ''),
    address: r.formatted,
    lat: r.lat, lon: r.lon,
    timezone: r.timezone && r.timezone.name,
    source: 'geoapify',
  }));
}

export async function photon(q, near, fetchImpl = fetch) {
  const u = new URL('https://photon.komoot.io/api/');
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '10');
  u.searchParams.set('lang', 'en');
  if (near) { u.searchParams.set('lat', near.lat); u.searchParams.set('lon', near.lon); }
  const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(3000), headers: { 'user-agent': 'FamilyFlow/1.0' } });
  if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
  const data = await res.json();
  return (data.features || [])
    .filter((f) => (f.properties.countrycode || '').toUpperCase() === 'US')
    .slice(0, 6)
    .map((f) => {
      const p = f.properties;
      const street = [p.housenumber, p.street].filter(Boolean).join(' ');
      const line2 = [p.city || p.town || p.village || p.county, [p.state, p.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      const address = [street || (p.name && !p.street ? '' : ''), line2].filter(Boolean).join(', ') || p.name;
      return { name: p.name && p.name !== street ? p.name : '', address: street ? `${street}, ${line2}` : (p.name ? `${p.name}, ${line2}` : line2), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], source: 'photon' };
    });
}

export async function searchPlaces(env, ctx, q, near, fetchImpl = fetch) {
  const db = env.DB;
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const saved = (await all(db,
    `SELECT * FROM places WHERE household_id = ? AND (name LIKE ? OR address LIKE ?)
     ORDER BY favorite DESC, use_count DESC, last_used_at DESC LIMIT 4`, ctx.household.id, like, like)).map(placeOut);
  let remote = [];
  let provider = null;
  const errors = [];
  if (q.length >= 3) {
    await useQuota(db, ctx.household.id, 'geocode', env);
    const key = `${q.toLowerCase()}|${near ? `${near.lat.toFixed(1)},${near.lon.toFixed(1)}` : ''}`;
    try {
      remote = await cached(env, `geo:${key}`, 86400, () => geoapify(env, q, near, fetchImpl));
      provider = 'geoapify';
    } catch (e) {
      errors.push(String(e.message || e));
      try {
        remote = await cached(env, `photon:${key}`, 86400, () => photon(q, near, fetchImpl));
        provider = 'photon';
      } catch (e2) {
        errors.push(String(e2.message || e2));
      }
    }
  }
  const seen = new Set(saved.map((s) => s.address.toLowerCase()));
  const results = [...saved, ...remote.filter((r) => r.address && !seen.has(r.address.toLowerCase()))].slice(0, 8);
  return { results, provider, degraded: q.length >= 3 && !provider, errors: errors.length ? errors : undefined };
}

export async function placesSearch(req, env, ctx) {
  if (!ctx.household) throw new HttpError(409, 'no_household', 'Create or join a household first.');
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  if (q.length < 2) return json({ results: [], provider: null });
  await rateLimit(env.DB, `places:${ctx.user.id}`, 120, 60);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const near = Number.isFinite(lat) && Number.isFinite(lon) && url.searchParams.get('lat') ? { lat, lon } : null;
  const out = await searchPlaces(env, ctx, q, near, env.__fetch || fetch);
  delete out.errors;
  return json(out);
}

export async function savedPlaces(req, env, ctx) {
  const rows = await all(env.DB, 'SELECT * FROM places WHERE household_id = ? ORDER BY favorite DESC, use_count DESC LIMIT 50', ctx.household.id);
  return json({ places: rows.map(placeOut) });
}

export async function savePlace(req, env, ctx) {
  const body = validate(v.object({
    name: v.string({ max: 200 }).default(''),
    address: v.string({ min: 1, max: 300 }),
    lat: v.number({ min: -90, max: 90 }).optional(),
    lon: v.number({ min: -180, max: 180 }).optional(),
    favorite: v.boolean().default(true),
  }), await readJson(req));
  await rememberPlace(env.DB, ctx.household.id, body);
  await run(env.DB, 'UPDATE places SET favorite = ?, name = CASE WHEN ? != \'\' THEN ? ELSE name END WHERE household_id = ? AND address = ?',
    body.favorite ? 1 : 0, body.name, body.name, ctx.household.id, body.address);
  const row = await one(env.DB, 'SELECT * FROM places WHERE household_id = ? AND address = ?', ctx.household.id, body.address);
  return json({ place: placeOut(row) });
}

export async function deletePlace(req, env, ctx, { id }) {
  await run(env.DB, 'DELETE FROM places WHERE id = ? AND household_id = ?', id, ctx.household.id);
  return json({ ok: true });
}
