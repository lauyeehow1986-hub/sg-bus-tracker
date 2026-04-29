// ── Bus stops: load, cache, index ────────────────────
import { state, searchIndex } from './state.js';
import * as api from './api.js';
import { showToast, toastError } from './toast.js';

const STOPS_CACHE_KEY = 'sg_bus_stops_v2';
const STOPS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

export async function loadBusStops(onReady) {
  // Try cache first
  try {
    const cached = localStorage.getItem(STOPS_CACHE_KEY);
    if (cached) {
      const { ts, stops } = JSON.parse(cached);
      if (Date.now() - ts < STOPS_CACHE_TTL && Array.isArray(stops) && stops.length) {
        state.busStops = stops;
        state.busStopsLoaded = true;
        buildIndex();
        showToast(`${stops.length} stops loaded from cache ✓`, 'success');
        onReady && onReady();
        // Continue with fresh fetch in background after 2s
        setTimeout(() => refreshStopsInBackground(), 2000);
        return;
      }
    }
  } catch (_) {}

  // Cache miss or stale — fetch from LTA
  state.busStops = [];
  let skip = 0;
  showToast('Loading bus stops…');
  try {
    while (true) {
      const r = await api.getBusStops(skip);
      if (!r.ok) throw r.error;
      const batch = r.data.value || [];
      if (!batch.length) break;
      state.busStops = state.busStops.concat(batch);
      skip += 500;
      if (batch.length < 500) break;
    }
    state.busStopsLoaded = true;
    buildIndex();
    showToast(`${state.busStops.length} stops loaded ✓`, 'success');
    try {
      localStorage.setItem(STOPS_CACHE_KEY, JSON.stringify({ ts: Date.now(), stops: state.busStops }));
    } catch (e) {
      console.warn('[Stops] Cache write failed:', e.message);
    }
    onReady && onReady();
  } catch (e) {
    toastError(e, 'api');
    console.error(e);
  }
}

async function refreshStopsInBackground() {
  try {
    const fresh = [];
    let skip = 0;
    while (true) {
      const r = await api.getBusStops(skip);
      if (!r.ok) return; // silent failure is fine — cached data is already in use
      const batch = r.data.value || [];
      if (!batch.length) break;
      fresh.push(...batch);
      skip += 500;
      if (batch.length < 500) break;
    }
    if (fresh.length) {
      state.busStops = fresh;
      buildIndex();
      try {
        localStorage.setItem(STOPS_CACHE_KEY, JSON.stringify({ ts: Date.now(), stops: fresh }));
      } catch (_) {}
    }
  } catch (_) {}
}

// T2.4: Build O(1) lookup + precomputed lowercased views for fast search
export function buildIndex() {
  searchIndex.byCode = new Map();
  searchIndex.descLower = new Array(state.busStops.length);
  for (let i = 0; i < state.busStops.length; i++) {
    const s = state.busStops[i];
    searchIndex.byCode.set(s.BusStopCode, s);
    searchIndex.descLower[i] = {
      stop: s,
      desc: (s.Description || '').toLowerCase(),
      road: (s.RoadName || '').toLowerCase(),
    };
  }
}

// Fast filter used by search + planner
// T16: returns { items, totalMatches, truncated }.
// totalMatches is the true count of matching stops; items is the
// (possibly truncated) result list. Callers can show a "showing N of M"
// footer when truncated is true.
//
// Why not return a plain array: previously a hard cap of 7→30 silently
// dropped results for broad searches like "bedok" (matches ~100 stops
// across Bedok / Bedok North / Bedok Reservoir / etc.). The truncated
// flag now lets the UI tell the user when they need to refine.
export function findStops(query, limit = 100) {
  const q = query.trim();
  if (!q) return { items: [], totalMatches: 0, truncated: false };
  const isNum = /^\d+$/.test(q);
  if (isNum) {
    // Numeric search: stop code prefix match. Different ranking, no
    // substring path.
    const all = [];
    for (const s of state.busStops) {
      if (s.BusStopCode.startsWith(q)) all.push(s);
    }
    return {
      items: all.slice(0, limit),
      totalMatches: all.length,
      truncated: all.length > limit,
    };
  }
  const needle = q.toLowerCase();
  // Prefix-match first (boost to top), then substring match.
  // Linear scan over ~5500 stops is sub-millisecond.
  const prefix = [];
  const contains = [];
  for (const row of searchIndex.descLower) {
    if (row.desc.startsWith(needle)) prefix.push(row.stop);
    else if (row.desc.includes(needle) || row.road.includes(needle)) contains.push(row.stop);
  }
  const all = prefix.concat(contains);
  return {
    items: all.slice(0, limit),
    totalMatches: all.length,
    truncated: all.length > limit,
  };
}

export function stopByCode(code) {
  return searchIndex.byCode.get(code);
}
