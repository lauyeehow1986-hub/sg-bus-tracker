// ── Typed API layer ──────────────────────────────────
// Every LTA call goes through here. Returns { ok: true, data } or
// { ok: false, error: TypedError }. Retries transient failures.
import { PROXY, PROXY_BASE } from './state.js';

export class TypedError extends Error {
  constructor(kind, message, status = null, retryable = false) {
    super(message);
    this.name = 'TypedError';
    this.kind = kind;   // 'network' | 'auth' | 'quota' | 'timeout' | 'notfound' | 'server' | 'unknown'
    this.status = status;
    this.retryable = retryable;
  }
}

function classify(err, status) {
  if (err && err.name === 'AbortError') return new TypedError('timeout', 'Request timed out', null, true);
  if (err instanceof TypeError) return new TypedError('network', err.message || 'Network error', null, true);
  if (status === 401) return new TypedError('auth', 'Unauthorized', 401, false);
  if (status === 404) return new TypedError('notfound', 'Not found', 404, false);
  if (status === 429) return new TypedError('quota', 'Rate limited', 429, true);
  if (status >= 500)  return new TypedError('server', `Server ${status}`, status, true);
  if (status && status >= 400) return new TypedError('unknown', `HTTP ${status}`, status, false);
  return new TypedError('unknown', (err && err.message) || 'Unknown error', status, false);
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// Core call: attempt request, retry retryables up to twice with backoff.
async function call(path, { query = '', timeoutMs = 12000 } = {}) {
  const url = `${PROXY}${path}${query ? '?' + query : ''}`;
  const attempts = [0, 500, 2000]; // ms to wait before each attempt
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i] > 0) await new Promise(r => setTimeout(r, attempts[i]));
    try {
      const res = await fetchWithTimeout(url, {}, timeoutMs);
      if (!res.ok) {
        const err = classify(null, res.status);
        if (!err.retryable || i === attempts.length - 1) return { ok: false, error: err };
        lastErr = err;
        continue;
      }
      const data = await res.json();
      if (data && data.error) {
        // Proxy returns { error: ... } for LTA errors
        return { ok: false, error: new TypedError('server', data.error, null, false) };
      }
      return { ok: true, data };
    } catch (e) {
      const err = classify(e);
      if (!err.retryable || i === attempts.length - 1) return { ok: false, error: err };
      lastErr = err;
    }
  }
  return { ok: false, error: lastErr || new TypedError('unknown', 'All retries failed') };
}

// ─── Public API ──────────────────────────────────────
export function getBusStops(skip = 0) {
  return call('/BusStops', { query: `$skip=${skip}` });
}
export function getBusArrival(code) {
  return call('/v3/BusArrival', { query: `BusStopCode=${encodeURIComponent(code)}` });
}
export function getBusRoutes(svcNo, skip = 0) {
  // LTA DataMall /BusRoutes does NOT honour ServiceNo as a filter — it only
  // supports $skip. We keep the param for backwards compat but don't use it;
  // callers must filter client-side after fetching the full dataset.
  return call('/BusRoutes', { query: `$skip=${skip}` });
}
export function getBusServices(skip = 0) {
  return call('/BusServices', { query: `$skip=${skip}` });
}

// ── T6: Train endpoints ──────────────────────────────
// Train Service Alerts: disruptions + shuttle bus info. Updates ad-hoc.
// Returns { Status, AffectedSegments[], Message[] } per LTA API v6.7.
export function getTrainServiceAlerts() {
  return call('/TrainServiceAlerts');
}
// Station Crowd Density Real Time for a given train line.
// Line codes: CCL, CEL, CGL, DTL, EWL, NEL, NSL, BPL, SLRT, PLRT, TEL
// Updates every 10 minutes. Returns per-station crowd level: l/m/h.
export function getStationCrowding(trainLine) {
  return call('/PCDRealTime', { query: `TrainLine=${encodeURIComponent(trainLine)}` });
}

// Proxy-management endpoints (these bypass the retry/typed path — they're
// infrastructure checks, not data calls).
export async function proxyKeycheck(base = PROXY_BASE, signal) {
  const res = await fetch(`${base}/keycheck`, { signal });
  if (!res.ok) throw new TypedError('server', `HTTP ${res.status}`, res.status);
  return res.json();
}

export async function setApiKey(key) {
  const res = await fetch(`${PROXY_BASE}/setkey?key=${encodeURIComponent(key)}`);
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e;
  }
  return res.json();
}
