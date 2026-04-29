// ── T9: Live location tracking on route panel ─────────
// When a route panel is open, continuously watch the user's geolocation
// and highlight the nearest stop in the current direction. If the user has
// set a journey destination, also show a "stops remaining" pill.
//
// Design choices:
// - Subscribe only while route panel is open (zero cost otherwise)
// - enableHighAccuracy: false — we only need bus-stop-level precision
//   (~30m), and high-accuracy drains battery noticeably
// - Never highlight if GPS accuracy is worse than 200m — too risky
// - Never highlight if user is >100m from any stop on the route
// - Update the DOM via direct class/attribute manipulation, not re-render
//   — avoids entangling with the crowd-render loop guards in route.js
//
// Caveats (documented elsewhere):
// - Does not confirm user is actually on the bus; proximity could mean
//   waiting, walking past, or in a car
// - Underground / tunnel sections have no GPS; marker will stick at last
//   known position until signal resumes
// - Indoor GPS accuracy is often 100-500m; we degrade silently

import { state } from './state.js';
import { $id, esc } from './dom.js';
import { log } from './log.js';

// T12: refined thresholds. Bus stops in Singapore are typically 300-500m
// apart, so when the user is between two stops, they can be 150-250m
// from each. Previous 100m threshold meant the marker disappeared
// entirely between stops, even though the user was clearly on the route.
//
// New scheme:
//   ≤80m of nearest stop  → "At stop #N" (you're really there)
//   80m-250m              → "Near stop #N" (between stops, this is the
//                            closest reference)
//   250m-2km              → "Not on this route, closest stop #N is Xm"
//   >2km                  → silent
const AT_STOP_THRESHOLD_M    = 80;       // "at" — physically at the stop
const PROXIMITY_THRESHOLD_M  = 250;      // "near" — between adjacent stops
const ACCURACY_CUTOFF_M      = 200;      // skip if GPS accuracy is worse
const OFFROUTE_BANNER_MAX_M  = 2000;     // "closest stop Xm away" banner
const UPDATE_THROTTLE_MS     = 3000;     // at most one DOM update per 3s

// T10 — auto-switch direction tunables
const AUTOSW_MIN_INTERVAL_MS = 30000;   // need ≥30s between two readings
const AUTOSW_MIN_MOVE_M      = 50;      // need ≥50m of movement
const AUTOSW_ON_ROUTE_M      = 100;     // both readings must be within this
                                        // of *some* stop on the route

let watchId = null;
let lastUpdateAt = 0;
let currentStops = [];                  // [{code, seq, lat, lng}] for current dir
let destStopCode = null;                // user's chosen journey destination, if any
let scrolledOnce = false;               // auto-scroll to current stop only first time
let lastVisitedSeq = null;              // T13: highest seq the user has been at
                                        // (within AT_STOP_THRESHOLD). Used to show
                                        // the upcoming stop when between stops, not
                                        // the previous one.
let prevFix = null;                     // T14: { lat, lng, ts } previous post-throttle
                                        // GPS fix. Used to infer direction of travel
                                        // when boarding mid-route (no visited stop yet).
const PREV_FIX_MIN_MOVE_M = 30;         // need ≥30m of movement before trusting heading
                                        // (rules out GPS jitter)

// T10 — auto-switch state (per route-panel session)
let autoSwitch = {
  enabled: false,         // becomes false if user manually taps a tab
  done: false,            // one-shot per panel open
  dir1Stops: null,        // [{code, seq, lat, lng}] for direction 1
  dir2Stops: null,        // [{code, seq, lat, lng}] for direction 2
  currentDirRef: null,    // function returning current direction (1 or 2)
  switchCallback: null,   // called with the recommended direction
  firstFix: null,         // { lat, lng, ts } first GPS reading after panel opened
};

// T11 — position listeners (e.g. map user-marker)
// Registered listeners receive every (post-throttle) fix as
// { lat, lng, accuracy, ts }. We fire them BEFORE the accuracy gate
// so the map can show an uncertainty circle when GPS is poor.
const positionListeners = new Set();

export function addPositionListener(fn) {
  if (typeof fn === 'function') positionListeners.add(fn);
}

export function removePositionListener(fn) {
  positionListeners.delete(fn);
}

// ── Distance helpers ──────────────────────────────────
function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = (d) => d * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Public lifecycle ──────────────────────────────────
// Called by route.js every time renderRouteList runs with a direction.
// Re-sets the stop list to whatever's currently visible.
export function setActiveRoute(stopsInDir) {
  const newStops = stopsInDir
    .filter(s => typeof s.Latitude === 'number' && typeof s.Longitude === 'number')
    .map(s => ({
      code: s.BusStopCode,
      seq: s.StopSequence,
      lat: s.Latitude,
      lng: s.Longitude,
    }))
    .sort((a, b) => a.seq - b.seq);

  // Detect whether the stop set genuinely changed. The crowd-fetch
  // re-render (see route.js v9.1 guards) calls renderRouteList a second
  // time with identical stops — in that case we mustn't reset the
  // scroll-to-current flag, or the user's view gets yanked.
  const sig = newStops.map(s => s.code).join(',');
  const changed = sig !== setActiveRoute._sig;
  setActiveRoute._sig = sig;

  currentStops = newStops;
  if (changed) {
    scrolledOnce = false;
    lastVisitedSeq = null; // T13: stop list changed → forget visited history
    prevFix = null;        // T14: forget direction-of-travel history too
  }

  // Determine destination from planner state — if user came from the
  // planner, state.planDestStop has their intended final stop.
  destStopCode = state.planDestStop?.BusStopCode || null;

  // T13: reset the throttle clock. There's a race in showRoute() where
  // a GPS fix can arrive while currentStops is still empty (between
  // startLiveTracking and the awaited fetchRouteData → renderRouteList
  // chain). That fix's handlePosition() consumes the throttle budget
  // (sets lastUpdateAt = now), then early-returns because currentStops
  // is empty. The subsequent fresh fix from getCurrentPosition below
  // would then be blocked by the 3s throttle, and we'd wait up to 30s
  // for the next watch tick. By zeroing lastUpdateAt here, we guarantee
  // the next fix is processed immediately.
  lastUpdateAt = 0;

  // If a watch is already running, trigger a recompute with the last known
  // position by asking geolocation for a fresh single fix.
  if (watchId !== null && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => handlePosition(pos),
      () => { /* silent */ },
      { enableHighAccuracy: false, maximumAge: 30000, timeout: 8000 }
    );
  }
}

// ── T10: Auto-switch direction ────────────────────────
// Set up auto-switch for the current panel session. Called by route.js
// after fetching route data, with stops grouped by direction.
//
// `currentDirRef` is a getter so we always see the latest direction
// (in case the user has manually switched in between).
// `switchCallback` is invoked with the recommended direction (1 or 2).
//
// One-shot per panel session: switches at most once. Disabled if the
// user manually taps a tab (see disableAutoSwitch below).
export function setupAutoSwitch({ dir1Stops, dir2Stops, currentDirRef, switchCallback }) {
  // Only meaningful for two-direction routes
  if (!dir1Stops || !dir2Stops || !dir1Stops.length || !dir2Stops.length) {
    autoSwitch.enabled = false;
    return;
  }
  autoSwitch = {
    enabled: true,
    done: false,
    dir1Stops: normaliseStops(dir1Stops),
    dir2Stops: normaliseStops(dir2Stops),
    currentDirRef,
    switchCallback,
    firstFix: null,
  };
}

// Called from route.js when the user manually taps a direction tab.
// Permanently disables auto-switch for this panel session — we never
// override an explicit user choice.
export function disableAutoSwitch() {
  if (autoSwitch.enabled) {
    log.info('liveloc', 'auto-switch disabled by manual tab tap');
  }
  autoSwitch.enabled = false;
  autoSwitch.done = true;
  autoSwitch.firstFix = null;
}

function normaliseStops(stopsInDir) {
  return stopsInDir
    .filter(s => typeof s.Latitude === 'number' && typeof s.Longitude === 'number')
    .map(s => ({
      code: s.BusStopCode,
      seq: s.StopSequence,
      lat: s.Latitude,
      lng: s.Longitude,
    }))
    .sort((a, b) => a.seq - b.seq);
}

// Returns the closest stop (by haversine) to a position, in a given dir's
// stop list. Returns null if list is empty.
function nearestStopIn(stops, lat, lng) {
  let best = null;
  let bestD = Infinity;
  for (const s of stops) {
    const d = haversineM(lat, lng, s.lat, s.lng);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best ? { stop: best, dist: bestD } : null;
}

// Core algorithm. Called from handlePosition on every (post-throttle)
// position update. Returns silently in most cases — only acts when
// confidence is high enough.
function maybeAutoSwitch(lat, lng, ts) {
  if (!autoSwitch.enabled || autoSwitch.done) return;
  if (!autoSwitch.dir1Stops || !autoSwitch.dir2Stops) return;

  // Capture the first fix as our reference point.
  if (!autoSwitch.firstFix) {
    autoSwitch.firstFix = { lat, lng, ts };
    return;
  }

  const f = autoSwitch.firstFix;

  // Need to wait long enough between readings
  if (ts - f.ts < AUTOSW_MIN_INTERVAL_MS) return;

  // Need to have moved meaningfully (rules out GPS jitter while stationary)
  const moved = haversineM(f.lat, f.lng, lat, lng);
  if (moved < AUTOSW_MIN_MOVE_M) {
    // User is essentially stationary — refresh the firstFix periodically
    // so when they DO start moving, we measure from a recent baseline,
    // not from where they were 10 minutes ago.
    if (ts - f.ts > AUTOSW_MIN_INTERVAL_MS * 4) {
      autoSwitch.firstFix = { lat, lng, ts };
    }
    return;
  }

  // Both readings should be near *some* stop on the route — i.e. the user
  // is plausibly travelling along it, not just somewhere in town
  const start1 = nearestStopIn(autoSwitch.dir1Stops, f.lat, f.lng);
  const end1   = nearestStopIn(autoSwitch.dir1Stops, lat, lng);
  const start2 = nearestStopIn(autoSwitch.dir2Stops, f.lat, f.lng);
  const end2   = nearestStopIn(autoSwitch.dir2Stops, lat, lng);
  if (!start1 || !end1 || !start2 || !end2) return;

  const onRoute1 = start1.dist <= AUTOSW_ON_ROUTE_M && end1.dist <= AUTOSW_ON_ROUTE_M;
  const onRoute2 = start2.dist <= AUTOSW_ON_ROUTE_M && end2.dist <= AUTOSW_ON_ROUTE_M;
  if (!onRoute1 && !onRoute2) return; // not actually on this route

  // Sequence advancement per direction. Positive = moving forward through
  // the stop sequence in that direction.
  const adv1 = end1.stop.seq - start1.stop.seq;
  const adv2 = end2.stop.seq - start2.stop.seq;

  // Pick the direction with clearly more forward progress. "Clearly" means
  // the winner advanced ≥2 stops AND advanced more than the other direction.
  // (If both advance, the user is likely moving along an overlapping
  // section — only one direction will keep advancing as we get more fixes.)
  let recommendedDir = null;
  if (adv1 >= 2 && adv1 > adv2) recommendedDir = 1;
  else if (adv2 >= 2 && adv2 > adv1) recommendedDir = 2;
  else return; // not enough confidence to switch

  const currentDir = autoSwitch.currentDirRef ? autoSwitch.currentDirRef() : null;
  if (currentDir == null) return;
  if (currentDir === recommendedDir) {
    // Already on the right direction — mark done so we don't keep checking
    autoSwitch.done = true;
    log.info('liveloc', `auto-switch: already on dir ${currentDir}, no action`);
    return;
  }

  // Switch!
  autoSwitch.done = true;
  log.info('liveloc', `auto-switch: ${currentDir} → ${recommendedDir} (adv1=${adv1}, adv2=${adv2}, moved=${Math.round(moved)}m)`);
  try {
    autoSwitch.switchCallback(recommendedDir);
  } catch (err) {
    log.warn('liveloc', 'auto-switch callback error', err);
  }
}

export function startLiveTracking() {
  if (watchId !== null) return;
  if (!navigator.geolocation) {
    log.info('liveloc', 'geolocation unavailable');
    return;
  }
  scrolledOnce = false;
  watchId = navigator.geolocation.watchPosition(
    handlePosition,
    (err) => {
      // Permission denied, timeout, or unavailable. Don't nag — just stop.
      log.info('liveloc', 'watch error', err.code, err.message);
      stopLiveTracking();
    },
    { enableHighAccuracy: false, maximumAge: 10000, timeout: 15000 }
  );
  log.info('liveloc', 'watch started');
}

export function stopLiveTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    log.info('liveloc', 'watch stopped');
  }
  currentStops = [];
  destStopCode = null;
  lastUpdateAt = 0;
  lastVisitedSeq = null; // T13: clear visited history
  prevFix = null;        // T14: clear direction-of-travel history
  // T10: reset auto-switch state so a fresh panel-open starts clean
  autoSwitch = {
    enabled: false, done: false,
    dir1Stops: null, dir2Stops: null,
    currentDirRef: null, switchCallback: null,
    firstFix: null,
  };
  clearUI();
}

// ── Core update logic ─────────────────────────────────
function handlePosition(pos) {
  // Throttle so rapid GPS updates don't spam the DOM
  const now = Date.now();
  if (now - lastUpdateAt < UPDATE_THROTTLE_MS) return;
  lastUpdateAt = now;

  const { latitude, longitude, accuracy } = pos.coords;

  // T11: notify any registered position listeners (e.g. the map's user
  // marker) BEFORE the accuracy gate, so they can render an appropriately-
  // sized uncertainty circle even when GPS is poor. Listeners decide for
  // themselves whether to display.
  for (const fn of positionListeners) {
    try { fn({ lat: latitude, lng: longitude, accuracy: accuracy || null, ts: now }); }
    catch (err) { log.warn('liveloc', 'position listener threw', err); }
  }

  if (!currentStops.length) return;

  // If GPS accuracy is too poor, silently skip the route-list marker
  // logic. Don't mislead the user about which stop they're at.
  if (accuracy && accuracy > ACCURACY_CUTOFF_M) {
    clearUI();
    renderAccuracyNotice(accuracy);
    return;
  }

  // Find the closest stop in the current direction
  let nearest = null;
  let nearestDist = Infinity;
  for (const s of currentStops) {
    const d = haversineM(latitude, longitude, s.lat, s.lng);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = s;
    }
  }
  if (!nearest) return;

  // T13: forward-looking highlight logic.
  //
  // Once the user has been within AT_STOP_THRESHOLD of a stop, we record
  // its sequence as "visited". After that, when between stops, we
  // highlight the NEXT stop (visited + 1) instead of the geographically
  // closest one. This prevents the marker from showing a stop the bus
  // has already passed.
  //
  // lastVisitedSeq is monotonic per panel session — once it advances,
  // GPS jitter cannot make it go backward.
  let highlightStop = null;
  let highlightDist = nearestDist;
  let highlightMode = 'at';        // 'at' | 'approaching' | 'off'

  if (nearestDist <= AT_STOP_THRESHOLD_M) {
    // Physically at this stop. Update visited history (monotonically).
    if (lastVisitedSeq === null || nearest.seq > lastVisitedSeq) {
      lastVisitedSeq = nearest.seq;
    }
    highlightStop = nearest;
    highlightMode = 'at';
  } else if (lastVisitedSeq !== null) {
    // We've been at a stop earlier this session. Show the next one in
    // sequence. If we've drifted too far from it, fall back to off-route.
    const nextStop = currentStops.find(s => s.seq === lastVisitedSeq + 1);
    if (nextStop) {
      const distToNext = haversineM(latitude, longitude, nextStop.lat, nextStop.lng);
      if (distToNext <= PROXIMITY_THRESHOLD_M) {
        highlightStop = nextStop;
        highlightDist = distToNext;
        highlightMode = 'approaching';
      } else {
        // Drifted off the route after our last visited stop
        highlightMode = 'off';
      }
    } else {
      // No next stop — visitedSeq is the terminus. Stay highlighted
      // on the last visited stop until the user closes the panel or
      // direction switches.
      const visited = currentStops.find(s => s.seq === lastVisitedSeq);
      if (visited) {
        const distToVisited = haversineM(latitude, longitude, visited.lat, visited.lng);
        highlightStop = visited;
        highlightDist = distToVisited;
        highlightMode = distToVisited <= PROXIMITY_THRESHOLD_M ? 'at' : 'off';
      } else {
        highlightMode = 'off';
      }
    }
  } else {
    // T14: pre-history (no visited stop yet — user opened panel mid-route).
    //
    // If we have a previous fix and the user has actually moved, infer
    // direction of travel and pick the upcoming stop, not just the nearest.
    // This fixes the v10.6 bug where the marker stuck on a stop the bus
    // had already passed (shown in user screenshot at Bedok area).
    //
    // For each stop within PROXIMITY_THRESHOLD, compare distance from
    // the previous fix vs current fix. A stop is "ahead" if we're getting
    // closer to it; "behind" if getting farther. Among ahead stops, pick
    // the one with the lowest sequence number (we'll reach it first).
    let aheadStop = null;
    let aheadStopDist = Infinity;
    let aheadInferred = false;

    if (prevFix && haversineM(prevFix.lat, prevFix.lng, latitude, longitude) >= PREV_FIX_MIN_MOVE_M) {
      const candidates = [];
      for (const s of currentStops) {
        const distNow = haversineM(latitude, longitude, s.lat, s.lng);
        if (distNow > PROXIMITY_THRESHOLD_M) continue;
        const distPrev = haversineM(prevFix.lat, prevFix.lng, s.lat, s.lng);
        if (distNow < distPrev) {
          // Getting closer to this stop — it's ahead
          candidates.push({ stop: s, dist: distNow, delta: distPrev - distNow });
        }
      }
      if (candidates.length) {
        // Among ahead stops, prefer the one with the lowest sequence (so
        // the marker shows the next stop we'll reach, not a later one we
        // happen to also be approaching). Tie-break on closeness.
        candidates.sort((a, b) => {
          if (a.stop.seq !== b.stop.seq) return a.stop.seq - b.stop.seq;
          return a.dist - b.dist;
        });
        aheadStop = candidates[0].stop;
        aheadStopDist = candidates[0].dist;
        aheadInferred = true;
      }
    }

    if (aheadInferred) {
      highlightStop = aheadStop;
      highlightDist = aheadStopDist;
      highlightMode = aheadStopDist <= AT_STOP_THRESHOLD_M ? 'at' : 'approaching';
      // Seed lastVisitedSeq retroactively. We just identified that aheadStop
      // is upcoming — so the previous stop in sequence has been passed.
      // From here on, the forward-looking branch above takes over.
      if (aheadStop.seq > 1) {
        lastVisitedSeq = aheadStop.seq - 1;
      }
    } else {
      // Either no movement yet, or no stops are clearly "ahead". Fall back
      // to v10.6 nearest-stop behaviour. The marker may briefly show a
      // passed stop; this self-corrects once the bus moves enough for
      // direction inference to kick in.
      if (nearestDist <= PROXIMITY_THRESHOLD_M) {
        highlightStop = nearest;
        highlightMode = nearestDist <= AT_STOP_THRESHOLD_M ? 'at' : 'approaching';
      } else {
        highlightMode = 'off';
      }
    }
  }

  if (highlightMode === 'off') {
    if (nearestDist <= OFFROUTE_BANNER_MAX_M) {
      markOffRoute(nearest, nearestDist);
    } else {
      clearUI();
    }
  } else {
    markOnRoute(highlightStop, highlightDist, highlightMode);
  }

  // T13: diagnostic log so we can debug "marker didn't appear" reports.
  // Throttled by UPDATE_THROTTLE_MS already (this runs once per fix).
  log.info('liveloc',
    `fix acc=${accuracy ? Math.round(accuracy) : '?'}m ` +
    `nearest=#${nearest.seq}@${Math.round(nearestDist)}m ` +
    `mode=${highlightMode} ` +
    `visited=${lastVisitedSeq ?? '-'} ` +
    `highlight=${highlightStop ? '#' + highlightStop.seq : 'none'}`);

  // T10: also evaluate auto-switch direction. Runs independently of the
  // marker logic above — auto-switch needs both directions' stops, but
  // marker only needs the current direction's.
  maybeAutoSwitch(latitude, longitude, now);

  // T14: cache this fix for next-time direction inference. Only if we
  // moved enough — replacing prevFix every time with a near-identical
  // position would defeat the purpose (we'd never accumulate enough
  // distance to trigger the inference).
  if (!prevFix || haversineM(prevFix.lat, prevFix.lng, latitude, longitude) >= PREV_FIX_MIN_MOVE_M) {
    prevFix = { lat: latitude, lng: longitude, ts: now };
  }
}

// ── UI manipulation ───────────────────────────────────
// We don't re-render the route list (that would fight the crowd-render
// guards). We just toggle CSS classes + inject a small banner element.
function clearUI() {
  document.querySelectorAll('.route-stop-item.live-here').forEach(el => {
    el.classList.remove('live-here');
    const marker = el.querySelector('.live-here-marker');
    if (marker) marker.remove();
  });
  const banner = $id('live-loc-banner');
  if (banner) banner.remove();
}

function ensureBanner() {
  let banner = $id('live-loc-banner');
  if (banner) return banner;
  const panel = $id('route-panel');
  const list = $id('route-list');
  if (!panel || !list) return null;
  banner = document.createElement('div');
  banner.id = 'live-loc-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  list.parentElement.insertBefore(banner, list);
  return banner;
}

// T13: mode is 'at' (within AT_STOP_THRESHOLD) or 'approaching' (between
// stops, showing the upcoming one). Label and banner text both adapt.
function markOnRoute(stop, distM, mode = 'at') {
  // Find the target .route-stop-item via its stop code
  const item = document.querySelector(
    `.route-stop-item[data-code="${CSS.escape(stop.code)}"]`
  );
  // Clear any previous markers first (direction switch or user moving)
  document.querySelectorAll('.route-stop-item.live-here').forEach(el => {
    if (el !== item) {
      el.classList.remove('live-here');
      const old = el.querySelector('.live-here-marker');
      if (old) old.remove();
    }
  });
  if (!item) return;

  const labelText = mode === 'at'
    ? '📍 You are here'
    : `📍 Approaching (${Math.round(distM)}m)`;
  const ariaText = mode === 'at'
    ? 'You are here'
    : `Approaching this stop, ${Math.round(distM)} metres away`;

  if (!item.classList.contains('live-here')) {
    item.classList.add('live-here');
    const marker = document.createElement('div');
    marker.className = 'live-here-marker';
    marker.setAttribute('aria-label', ariaText);
    marker.textContent = labelText;
    const info = item.querySelector('.route-stop-info');
    if (info) info.appendChild(marker);
  } else {
    // Same item but state changed — update without recreating (avoids flicker)
    const marker = item.querySelector('.live-here-marker');
    if (marker) {
      if (marker.textContent !== labelText) marker.textContent = labelText;
      marker.setAttribute('aria-label', ariaText);
    }
  }

  // Scroll to it the first time only (don't yank the view on every update)
  if (!scrolledOnce) {
    item.scrollIntoView({ block: 'center', behavior: 'smooth' });
    scrolledOnce = true;
  }

  // Show the "stops until destination" banner if a destination is set
  renderStopsRemainingBanner(stop, distM, mode);
}

function renderStopsRemainingBanner(atStop, distM, mode = 'at') {
  const banner = ensureBanner();
  if (!banner) return;

  // T13: word choice reflects the actual mode
  // 'at' = within AT_STOP_THRESHOLD of the highlighted stop
  // 'approaching' = between stops, showing the upcoming one
  const proximityWord = mode === 'at' ? 'At' : 'Approaching';

  if (!destStopCode) {
    banner.className = 'live-loc-banner here';
    banner.innerHTML = `
      <span class="live-loc-icon" aria-hidden="true">📍</span>
      <span>${proximityWord} stop #${atStop.seq}</span>
      <span class="live-loc-dist">· ${Math.round(distM)}m away</span>
    `;
    return;
  }

  const destIdx = currentStops.findIndex(s => s.code === destStopCode);
  const atIdx = currentStops.findIndex(s => s.code === atStop.code);
  if (destIdx === -1 || atIdx === -1) {
    // Destination isn't on this direction; don't show a misleading count
    banner.className = 'live-loc-banner here';
    banner.innerHTML = `
      <span class="live-loc-icon" aria-hidden="true">📍</span>
      <span>${proximityWord} stop #${atStop.seq}</span>
    `;
    return;
  }

  if (atIdx >= destIdx) {
    banner.className = 'live-loc-banner arrived';
    banner.innerHTML = `
      <span class="live-loc-icon" aria-hidden="true">✓</span>
      <span>You've reached your destination</span>
    `;
    return;
  }

  const stopsLeft = destIdx - atIdx;
  // Rough: assume ~2 min per stop (LTA/SBS typical urban pacing)
  const minsLeft = Math.max(2, stopsLeft * 2);
  banner.className = 'live-loc-banner here';
  banner.innerHTML = `
    <span class="live-loc-icon" aria-hidden="true">📍</span>
    <span><strong>${stopsLeft}</strong> stop${stopsLeft !== 1 ? 's' : ''} to go</span>
    <span class="live-loc-dist">· ~${minsLeft} min</span>
  `;
}

function markOffRoute(closestStop, distM) {
  // Remove any prior on-route marker
  document.querySelectorAll('.route-stop-item.live-here').forEach(el => {
    el.classList.remove('live-here');
    const old = el.querySelector('.live-here-marker');
    if (old) old.remove();
  });
  const banner = ensureBanner();
  if (!banner) return;
  banner.className = 'live-loc-banner offroute';
  const distText = distM < 1000
    ? `${Math.round(distM)}m`
    : `${(distM / 1000).toFixed(1)}km`;
  banner.innerHTML = `
    <span class="live-loc-icon" aria-hidden="true">📍</span>
    <span>Not on this route · closest stop #${closestStop.seq} is ${distText} away</span>
  `;
}

function renderAccuracyNotice(accuracy) {
  const banner = ensureBanner();
  if (!banner) return;
  banner.className = 'live-loc-banner weak';
  banner.innerHTML = `
    <span class="live-loc-icon" aria-hidden="true">📡</span>
    <span>GPS signal weak (±${Math.round(accuracy)}m). Live tracking paused.</span>
  `;
}
