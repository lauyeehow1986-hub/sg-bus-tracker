// ── Shared state ──────────────────────────────────────
// Minimal mutable state shared between modules. Mutations go through setters
// where non-trivial; primitive containers are exposed directly because the
// overhead of accessors for hot paths (arrivalData, etc.) is not worth it.

// Proxy base URL. The page is served BY the proxy, so same-origin avoids
// Chrome's Private Network Access preflight for LAN-IP pages.
export let PROXY_BASE = (location.protocol.startsWith('http'))
  ? location.origin
  : 'http://127.0.0.1:8080';
export let PROXY = PROXY_BASE + '/lta';

export function setProxyBase(base) {
  PROXY_BASE = base;
  PROXY = base + '/lta';
}

// Core app state
export const state = {
  busStops: [],
  busStopsLoaded: false,
  currentStop: null,
  arrivalData: [],
  highlightIndex: -1,
  planHighlight: -1,
  planDestStop: null,
  currentRouteService: null,
  currentRouteData: [],
  routeCache: {},
  busServicesCache: {},
  proxyOk: false,
  autoRefreshTimer: null,
  countdownTimer: null,
  searchTimeout: null,
  planSearchTimeout: null,
  openRenameChip: null,
  favHoldTimer: null,
  lastHiddenAt: 0,
  favourites: JSON.parse(localStorage.getItem('sg_bus_favs') || '[]'),
  favLabels: JSON.parse(localStorage.getItem('sg_bus_fav_labels') || '{}'),
};

// Search index (built once after stops load) — see stops.js
export const searchIndex = {
  byCode: new Map(),          // BusStopCode → stop
  descLower: [],              // [{ stop, desc, road }] pre-lowercased
};
