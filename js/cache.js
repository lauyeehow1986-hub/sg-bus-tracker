// ── Small KV cache ───────────────────────────────────
// Namespaced per-stop storage for offline fallback.
// Stays on localStorage for now; T2.3 roadmap item will move to IDB.

const NS = 'sg_bus_cache_v1';

// Write with quota-exceeded fallback: evict oldest entry and retry once.
function writeKey(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    // QuotaExceededError — evict the oldest cache entry we own and retry.
    try {
      let oldestKey = null;
      let oldestTs = Infinity;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(NS + ':')) {
          try {
            const v = JSON.parse(localStorage.getItem(k));
            if (v && typeof v.ts === 'number' && v.ts < oldestTs) {
              oldestTs = v.ts;
              oldestKey = k;
            }
          } catch (_) {}
        }
      }
      if (oldestKey) localStorage.removeItem(oldestKey);
      localStorage.setItem(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }
}

export function cacheArrivals(code, services) {
  const key = `${NS}:arr:${code}`;
  writeKey(key, JSON.stringify({ ts: Date.now(), services }));
}

export function loadCachedArrivals(code) {
  const key = `${NS}:arr:${code}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v.ts !== 'number' || !Array.isArray(v.services)) return null;
    return v;
  } catch (_) { return null; }
}

export function cacheLastKnownCoords(lat, lng) {
  writeKey(`${NS}:coords`, JSON.stringify({ ts: Date.now(), lat, lng }));
}

export function loadLastKnownCoords() {
  try {
    const raw = localStorage.getItem(`${NS}:coords`);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v.ts !== 'number') return null;
    return v;
  } catch (_) { return null; }
}

export function relativeTime(ts) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
