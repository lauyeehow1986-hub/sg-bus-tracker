// ── First/last bus timing helpers ────────────────────
// LTA BusRoutes returns HHMM strings per stop per service:
//   WD_FirstBus, WD_LastBus, SAT_FirstBus, SAT_LastBus, SUN_FirstBus, SUN_LastBus
// Values like "0500" mean 5:00am; "2400" is midnight; "0030" is 12:30am next
// day (common for last-bus times that spill past midnight).

// Day-of-week → timing key prefix. Sunday and public holidays both use SUN.
// We don't detect PHs (requires a calendar feed); users should know their
// local PH schedule.
export function timingDayKey(date = new Date()) {
  const dow = date.getDay(); // 0 = Sunday, 6 = Saturday
  if (dow === 0) return 'SUN';
  if (dow === 6) return 'SAT';
  return 'WD';
}

// "0500" → "5:00am"; "1315" → "1:15pm"; "2400" → "12am"; "0030" → "12:30am"
export function formatHHMM(hhmm) {
  if (!hhmm || typeof hhmm !== 'string' || hhmm.length !== 4) return '—';
  let h = parseInt(hhmm.slice(0, 2), 10);
  const m = parseInt(hhmm.slice(2, 4), 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return '—';
  // Handle 24xx spillover (e.g. "2400" = midnight, "2530" = 1:30am next day)
  let nextDay = false;
  if (h >= 24) { h -= 24; nextDay = true; }
  else if (h < 4) { nextDay = true; } // pre-4am is treated as "late night service"
  const period = h < 12 ? 'am' : 'pm';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  const mStr = m === 0 ? '' : ':' + String(m).padStart(2, '0');
  const suffix = nextDay ? ' (next day)' : '';
  return `${h12}${mStr}${period}${suffix}`;
}

// Short form without the "(next day)" suffix — for tight UI (e.g. arrivals panel)
export function formatHHMMShort(hhmm) {
  return formatHHMM(hhmm).replace(' (next day)', '⁺');
}

// Given a route row (from /BusRoutes), extract { first, last } for today's
// day-of-week. Returns null if both values are missing/blank.
export function firstLastForDay(row, date) {
  const key = timingDayKey(date);
  const first = row[`${key}_FirstBus`];
  const last  = row[`${key}_LastBus`];
  if (!first && !last) return null;
  return { first: first || null, last: last || null, day: key };
}

// Is "now" after the last bus for this stop-service-direction?
// Used to dim services whose last bus has passed.
// Returns null when data is missing (don't render anything).
export function lastBusPassed(row, now = new Date()) {
  const fl = firstLastForDay(row, now);
  if (!fl || !fl.last) return null;
  // Parse last bus as today's HH:MM (treating 24xx as next-day HH-24)
  let h = parseInt(fl.last.slice(0, 2), 10);
  const m = parseInt(fl.last.slice(2, 4), 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const last = new Date(now);
  if (h >= 24) { last.setDate(last.getDate() + 1); h -= 24; }
  // Handle cases like "0030" which mean 12:30am next day when now is 9pm
  last.setHours(h, m, 0, 0);
  if (last.getTime() < now.getTime() - 12 * 3600 * 1000) {
    // Last bus was > 12h ago relative to parsed time — it's actually next day
    last.setDate(last.getDate() + 1);
  }
  return now > last;
}
