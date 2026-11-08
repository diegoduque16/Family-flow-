// Public holidays, calculated locally (no network). Used by the app (calendar display) and the server (setting + tests).
// Currently: United States — federal holidays (with "observed" days when they fall on a weekend) and popular observances.

const US_ZONES = new Set([
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'America/Juneau',
  'America/Sitka', 'America/Nome', 'America/Yakutat', 'America/Metlakatla', 'America/Adak', 'America/Boise', 'America/Detroit', 'America/Menominee',
  'America/Indianapolis', 'America/Louisville', 'Pacific/Honolulu', 'America/Puerto_Rico',
]);
export const isUsZone = (tz) => US_ZONES.has(tz) || /^America\/(Indiana|Kentucky|North_Dakota)\//.test(tz || '') || /^US\//.test(tz || '');

// Stored setting: 'US' | 'none' | null (null = automatic from the household time zone).
export function effectiveHolidays(setting, timezone) {
  if (setting === 'none') return null;
  if (setting === 'US') return 'US';
  return isUsZone(timezone) ? 'US' : null;
}

export const HOLIDAY_REGIONS = [{ id: 'US', name: 'United States' }];

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
const nthWeekday = (y, m, weekday, n) => { const first = dow(y, m, 1); return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7; };
const lastWeekday = (y, m, weekday) => { const days = new Date(Date.UTC(y, m, 0)).getUTCDate(); const last = dow(y, m, days); return days - ((last - weekday + 7) % 7); };
function easter(y) { // Anonymous Gregorian algorithm
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}
function shift(y, m, d, days) { const t = new Date(Date.UTC(y, m - 1, d + days)); return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }

// [{ date: 'YYYY-MM-DD', name, icon, federal }]
export function usHolidays(y) {
  const out = [];
  const fed = (m, d, name, icon, observe = false) => {
    out.push({ date: ymd(y, m, d), name, icon, federal: true });
    if (observe) { // weekend rule for federal holidays: Saturday -> Friday, Sunday -> Monday
      const w = dow(y, m, d);
      if (w === 6) out.push({ date: shift(y, m, d, -1), name: `${name} (observed)`, icon, federal: true, observed: true });
      if (w === 0) out.push({ date: shift(y, m, d, 1), name: `${name} (observed)`, icon, federal: true, observed: true });
    }
  };
  const obs = (m, d, name, icon) => out.push({ date: ymd(y, m, d), name, icon, federal: false });
  fed(1, 1, 'New Year’s Day', '🎆', true);
  fed(1, nthWeekday(y, 1, 1, 3), 'Martin Luther King Jr. Day', '🕊️');
  obs(2, 14, 'Valentine’s Day', '💝');
  fed(2, nthWeekday(y, 2, 1, 3), 'Presidents’ Day', '🇺🇸');
  obs(3, 17, 'St. Patrick’s Day', '☘️');
  const [em, ed] = easter(y);
  obs(em, ed, 'Easter Sunday', '🐣');
  obs(5, nthWeekday(y, 5, 0, 2), 'Mother’s Day', '💐');
  fed(5, lastWeekday(y, 5, 1), 'Memorial Day', '🇺🇸');
  obs(6, nthWeekday(y, 6, 0, 3), 'Father’s Day', '👔');
  if (y >= 2021) fed(6, 19, 'Juneteenth', '🎉', true);
  fed(7, 4, 'Independence Day', '🎆', true);
  fed(9, nthWeekday(y, 9, 1, 1), 'Labor Day', '🛠️');
  fed(10, nthWeekday(y, 10, 1, 2), 'Columbus Day / Indigenous Peoples’ Day', '🍂');
  obs(10, 31, 'Halloween', '🎃');
  fed(11, 11, 'Veterans Day', '🎖️', true);
  fed(11, nthWeekday(y, 11, 4, 4), 'Thanksgiving', '🦃');
  obs(12, 24, 'Christmas Eve', '🎄');
  fed(12, 25, 'Christmas Day', '🎄', true);
  obs(12, 31, 'New Year’s Eve', '🥂');
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Holidays between two dates [from, to) (YYYY-MM-DD) for a region id.
export function holidaysBetween(region, from, to) {
  if (region !== 'US') return [];
  const out = [];
  for (let y = Number(from.slice(0, 4)) - 1; y <= Number(to.slice(0, 4)); y++) {
    for (const hday of usHolidays(y)) if (hday.date >= from && hday.date < to) out.push(hday);
  }
  return out;
}
