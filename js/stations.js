// ── T5.2: MRT/LRT station proximity ──────────────────
// Loads a bundled stations.json dataset and provides haversine-based
// proximity queries against a bus stop's lat/lng.
//
// The bundled data/stations.json is a seed subset of ~50 major stations.
// For full coverage, users can regenerate it with scripts/build-stations.sh.

const PROXIMITY_THRESHOLD_M = 300;
const EARTH_RADIUS_M = 6371000;

let stationsCache = null;       // array of { code, name, line, lat, lng }
let stationsPromise = null;

export async function loadStations() {
  if (stationsCache) return stationsCache;
  if (stationsPromise) return stationsPromise;
  stationsPromise = (async () => {
    try {
      const res = await fetch('data/stations.json', { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const arr = (data.stations || []).map(([code, name, line, lat, lng]) => ({
        code, name, line, lat, lng,
      }));
      stationsCache = arr;
      return arr;
    } catch (err) {
      console.warn('[stations] load failed:', err);
      stationsCache = [];
      return [];
    }
  })();
  stationsPromise.catch(() => { stationsPromise = null; });
  return stationsPromise;
}

function haversineMetres(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) *
            Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Find all stations within PROXIMITY_THRESHOLD_M of (lat, lng).
// Returns [] if stations haven't loaded yet (call loadStations() first).
// Results are de-duplicated by station name and sorted by distance (nearest
// first). De-duplication means Dhoby Ghaut won't appear 3 times (NS24, NE6,
// CC1) — instead, one row showing all three codes.
export function stationsNear(lat, lng) {
  if (!stationsCache || !stationsCache.length) return [];
  const hits = [];
  for (const s of stationsCache) {
    const d = haversineMetres(lat, lng, s.lat, s.lng);
    if (d <= PROXIMITY_THRESHOLD_M) {
      hits.push({ ...s, distanceM: Math.round(d) });
    }
  }
  // De-dup by name — stations with interchange codes are the same physical
  // building. Keep the smallest distance per name; aggregate codes+lines
  // as parallel arrays (one entry per physical code).
  const byName = new Map();
  for (const h of hits) {
    const existing = byName.get(h.name);
    if (!existing) {
      byName.set(h.name, {
        name: h.name,
        lat: h.lat, lng: h.lng,
        distanceM: h.distanceM,
        codes: [h.code],
        lines: [h.line],
      });
    } else {
      existing.codes.push(h.code);
      existing.lines.push(h.line);
      if (h.distanceM < existing.distanceM) existing.distanceM = h.distanceM;
    }
  }
  const merged = [...byName.values()];
  merged.sort((a, b) => a.distanceM - b.distanceM);
  return merged;
}

// Line brand colours for badges (CSS classes)
export function lineClass(line) {
  const map = {
    NSL: 'mrt-nsl', EWL: 'mrt-ewl', NEL: 'mrt-nel',
    CCL: 'mrt-ccl', DTL: 'mrt-dtl', TEL: 'mrt-tel',
    BPL: 'mrt-lrt', SKL: 'mrt-lrt', PGL: 'mrt-lrt',
  };
  return map[line] || 'mrt-generic';
}

// Format a distance for display: "120m" or "0.3km"
export function fmtDistance(m) {
  if (m < 1000) return `${m}m`;
  return `${(m / 1000).toFixed(1)}km`;
}
