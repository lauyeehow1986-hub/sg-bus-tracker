// ── Route panel + map ────────────────────────────────
import { state } from './state.js';
import * as api from './api.js';
import { $id, esc } from './dom.js';
import { selectStopByCode } from './search.js';
import { svcColor } from './svc.js';
import { firstLastForDay, formatHHMM, timingDayKey } from './timing.js';
import { loadStations, stationsNear, lineClass, fmtDistance } from './stations.js';
import { crowdLevel, crowdAriaLabel, ensureCrowdingFor } from './train.js';
import { setActiveRoute, startLiveTracking, stopLiveTracking, setupAutoSwitch, disableAutoSwitch, addPositionListener, removePositionListener } from './liveLocation.js';
import { showToast } from './toast.js';
import { armAlarm, disarmAlarm, isArmed, isAnyArmed } from './alarm.js';

let leafletMap = null;
let mapInitialised = false;
let currentRouteDir = 1;
let mapOpen = false;

// T11 — user position marker on the route map.
// userMarker / accuracyCircle are Leaflet layers (or null when no fix yet).
// lastUserPosition is the most recent { lat, lng, accuracy } so we can
// re-add the marker after renderMap() wipes non-tile layers.
let userMarker = null;
let accuracyCircle = null;
let lastUserPosition = null;
let mapPositionListener = null; // the bound function we register/unregister
const MAP_MARKER_ACCURACY_CUTOFF_M = 500; // hide marker if accuracy worse

// ── Full /BusRoutes dataset cache ─────────────────────
// LTA DataMall's /BusRoutes endpoint does NOT accept a ServiceNo filter —
// it only supports $skip for pagination. Passing ServiceNo is silently
// ignored and the endpoint returns the first 500 rows of the GLOBAL route
// table, which contains a mix of every service's stops. The *correct* way
// to get a service's route is:
//   1. Page through ALL /BusRoutes rows (~26,000 rows in ~53 pages of 500)
//   2. Filter by ServiceNo client-side
// We cache the full dataset once per session; subsequent per-service lookups
// are instant and correct. The proxy's 5-min cache makes the initial fetch
// cheap too — only the first session pays the real LTA cost.
let allRoutesPromise = null;

export async function getAllRoutes() {
  if (allRoutesPromise) return allRoutesPromise;
  allRoutesPromise = (async () => {
    const all = [];
    let skip = 0;
    while (true) {
      const r = await api.getBusRoutes('', skip); // ServiceNo ignored by LTA; send empty
      if (!r.ok) throw r.error;
      const batch = r.data.value || [];
      if (!batch.length) break;
      all.push(...batch);
      skip += 500;
      if (batch.length < 500) break;
      // Safety cap: LTA has ~26k routes; if we see >50k, something is wrong
      if (all.length > 50000) break;
    }
    return all;
  })();
  // If the fetch fails, don't cache the rejection — let the next call retry
  allRoutesPromise.catch(() => { allRoutesPromise = null; });
  return allRoutesPromise;
}

// ── T4.1: Derived index for transfer-based planner ────
// BusStopCode → Set of ServiceNo that serve it (in any direction).
// Built once from the cached /BusRoutes dataset; cheap (~26k rows, <50ms).
let stopToServicesIndex = null;
let stopToServicesFromPromise = null;

export async function getStopToServices() {
  if (stopToServicesIndex && stopToServicesFromPromise === allRoutesPromise) {
    return stopToServicesIndex;
  }
  const all = await getAllRoutes();
  const idx = new Map();
  for (const row of all) {
    let set = idx.get(row.BusStopCode);
    if (!set) { set = new Set(); idx.set(row.BusStopCode, set); }
    set.add(row.ServiceNo);
  }
  stopToServicesIndex = idx;
  stopToServicesFromPromise = allRoutesPromise;
  return idx;
}

// ── T5.1: First/last bus lookup ──────────────────────
// Look up the first/last bus timings for a specific (stop, service) pair.
// Returns null if routes aren't cached yet — callers should handle silently.
// Uses the per-service filtered cache to avoid re-scanning the full dataset.
export function firstLastForService(stopCode, svcNo) {
  const cached = state.routeCache[svcNo];
  if (!cached) return null;
  // A service has 1 or 2 directions; the (stop, svc) pair may appear in both
  // (rare — e.g. loop services). Pick the direction where this stop appears
  // earliest (deterministic).
  let best = null;
  let bestSeq = Infinity;
  for (const row of cached) {
    if (row.BusStopCode === stopCode && row.StopSequence < bestSeq) {
      best = row;
      bestSeq = row.StopSequence;
    }
  }
  return best;
}

export async function fetchRouteData(svcNo) {
  if (state.routeCache[svcNo]) return state.routeCache[svcNo];
  const all = await getAllRoutes();
  const routes = all.filter(r => r.ServiceNo === svcNo);
  state.routeCache[svcNo] = routes;
  return routes;
}

// Load the full /BusServices dataset once. ~700 services (~2 pages of 500).
// Populates busServicesCache with { operator, origin, dest, cat } per
// (service, direction). Cheap and enables operator-coloured badges everywhere.
let allServicesPromise = null;
export function preloadBusServices() {
  if (allServicesPromise) return allServicesPromise;
  allServicesPromise = (async () => {
    const all = [];
    let skip = 0;
    while (true) {
      const r = await api.getBusServices(skip);
      if (!r.ok) throw r.error;
      const batch = r.data.value || [];
      if (!batch.length) break;
      all.push(...batch);
      skip += 500;
      if (batch.length < 500) break;
      if (all.length > 5000) break; // safety cap
    }
    for (const s of all) {
      if (!state.busServicesCache[s.ServiceNo]) state.busServicesCache[s.ServiceNo] = {};
      state.busServicesCache[s.ServiceNo][s.Direction] = {
        operator: s.Operator,
        origin: s.OriginCode,
        dest: s.DestinationCode,
        cat: s.Category,
      };
    }
    return all;
  })();
  allServicesPromise.catch(() => { allServicesPromise = null; });
  return allServicesPromise;
}

export async function fetchServiceDirections(svcNo) {
  if (state.busServicesCache[svcNo]) return state.busServicesCache[svcNo];
  // Trigger (or re-use) the full preload; then check the cache again.
  try { await preloadBusServices(); } catch (_) {}
  return state.busServicesCache[svcNo] || {};
}

export async function showRoute(svcNo, e) {
  if (e && e.stopPropagation) e.stopPropagation();
  if (state.currentRouteService === svcNo) { closeRoutePanel(); return; }
  state.currentRouteService = svcNo;

  const panel = $id('route-panel');
  const badge = $id('routeServiceBadge');
  badge.textContent = svcNo;
  badge.className = `service-badge ${svcColor(svcNo)}`;
  const list = $id('routeStopsList');
  // First-time fetch pulls the full ~26k-row /BusRoutes dataset (cached after).
  // Subsequent services are instant. Explain the wait on first use.
  const firstLoad = allRoutesPromise === null;
  list.innerHTML = firstLoad
    ? '<div class="loading-wrap"><div class="loader"></div> Loading route table (first-time only, ~15s)…</div>'
    : '<div class="loading-wrap"><div class="loader"></div> Loading route…</div>';
  $id('mapDirTabs').style.display = 'none';
  $id('mapToggleBtn').style.display = 'none';
  panel.style.display = 'block';
  closeMap();
  startLiveTracking(); // T9: begin geolocation watch
  setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);

  try {
    const routes = await fetchRouteData(svcNo);
    if (!routes.length) { list.innerHTML = '<div class="no-service">No route data found.</div>'; return; }

    state.currentRouteData = routes;
    const dirs = [...new Set(routes.map(r => r.Direction))].sort();
    currentRouteDir = dirs[0];

    const tabsEl = $id('mapDirTabs');
    if (dirs.length > 1) {
      tabsEl.style.display = 'flex';
      const stopMap = {};
      state.busStops.forEach(s => stopMap[s.BusStopCode] = s);
      const tabLabels = {};
      dirs.forEach(d => {
        const sorted = routes.filter(r => r.Direction === d).sort((a, b) => a.StopSequence - b.StopSequence);
        const lastStop = sorted[sorted.length - 1];
        const info = lastStop ? stopMap[lastStop.BusStopCode] : null;
        tabLabels[d] = info ? `→ ${info.Description}` : `Dir ${d}`;
      });
      tabsEl.innerHTML = dirs.map(d => `
        <button class="map-dir-tab ${d === currentRouteDir ? 'active' : ''}"
          role="tab" aria-selected="${d === currentRouteDir}"
          data-dir="${d}" title="${esc(tabLabels[d])}">${esc(tabLabels[d].substring(0, 22))}</button>`).join('');
      tabsEl.onclick = (ev) => {
        const btn = ev.target.closest('.map-dir-tab');
        if (!btn) return;
        // T10: explicit user choice — never override it after this
        disableAutoSwitch();
        switchDir(parseInt(btn.dataset.dir));
      };

      // T10: enable auto-direction-switch. Only meaningful for 2-direction
      // routes (dirs.length > 1 branch). Pass coordinate-enriched stops
      // for both directions so liveLocation can detect which way the user
      // is travelling. The switchCallback is called with the recommended
      // direction (1 or 2); we route it through switchDir which re-renders
      // and updates the active tab.
      if (dirs.length === 2) {
        const enrich = (d) => routes
          .filter(r => r.Direction === d)
          .sort((a, b) => a.StopSequence - b.StopSequence)
          .map(r => ({
            BusStopCode: r.BusStopCode,
            StopSequence: r.StopSequence,
            Latitude: stopMap[r.BusStopCode]?.Latitude,
            Longitude: stopMap[r.BusStopCode]?.Longitude,
          }));
        setupAutoSwitch({
          dir1Stops: enrich(dirs[0]),
          dir2Stops: enrich(dirs[1]),
          currentDirRef: () => currentRouteDir,
          switchCallback: (recommended) => {
            const previous = currentRouteDir;
            // Don't call disableAutoSwitch — this is the auto-switch itself
            switchDir(recommended);
            // Brief toast with undo so the user understands why the tab
            // changed and can revert if our guess was wrong.
            const recLabel = (tabLabels[recommended] || `Dir ${recommended}`).replace(/^→\s*/, '');
            showToast(
              `Switched to → ${recLabel} (auto)`,
              '',
              {
                label: 'Undo',
                onClick: () => {
                  disableAutoSwitch();
                  switchDir(previous);
                },
              },
              5000
            );
          },
        });
      }
    } else {
      tabsEl.style.display = 'none';
    }

    renderRouteList(routes, currentRouteDir);
    $id('mapToggleBtn').style.display = 'flex';
  } catch (err) {
    list.innerHTML = `<div class="no-service">Failed: ${esc(err.message || String(err))}</div>`;
  }
}

function renderRouteList(routes, dir) {
  const stopMap = {};
  state.busStops.forEach(s => stopMap[s.BusStopCode] = s);
  const curCode = state.currentStop && state.currentStop.BusStopCode;
  const sorted = routes.filter(r => r.Direction === dir).sort((a, b) => a.StopSequence - b.StopSequence);
  const list = $id('routeStopsList');
  if (!sorted.length) { list.innerHTML = '<div class="no-service">No stops for this direction.</div>'; return; }

  // T9: hand the direction's stops (with coordinates) to the live-location
  // module so it can highlight the user's current position.
  setActiveRoute(sorted.map(r => ({
    BusStopCode: r.BusStopCode,
    StopSequence: r.StopSequence,
    Latitude: stopMap[r.BusStopCode]?.Latitude,
    Longitude: stopMap[r.BusStopCode]?.Longitude,
  })));

  list.innerHTML = sorted.map(r => {
    const info = stopMap[r.BusStopCode];
    const isCur = r.BusStopCode === curCode;
    const fl = firstLastForDay(r);
    const timingLine = fl
      ? `<div class="route-stop-timing" aria-label="First bus ${formatHHMM(fl.first)}, last bus ${formatHHMM(fl.last)}">
          <span class="route-stop-timing-label">${esc(fl.day)}</span>
          ${fl.first ? `first ${esc(formatHHMM(fl.first))}` : ''}
          ${fl.first && fl.last ? ' · ' : ''}
          ${fl.last ? `last ${esc(formatHHMM(fl.last))}` : ''}
         </div>`
      : '';
    // T5.2: nearby MRT/LRT stations within 300m
    let mrtLine = '';
    if (info && typeof info.Latitude === 'number' && typeof info.Longitude === 'number') {
      const nearby = stationsNear(info.Latitude, info.Longitude);
      if (nearby.length) {
        const labelParts = nearby.slice(0, 2).map(st =>
          `${st.codes.join('/')} ${st.name} (${fmtDistance(st.distanceM)})`
        ).join(', ');
        const chips = nearby.slice(0, 3).map(st => {
          // Each code gets its own line-coloured pill (e.g. NS24 + NE6 + CC1 for Dhoby Ghaut)
          const codesHtml = st.codes.map((c, idx) => {
            const line = st.lines[idx] || st.lines[0];
            return `<span class="mrt-code ${lineClass(line)}">${esc(c)}</span>`;
          }).join('');
          // T6: Crowding dot — pick worst (highest) level across codes
          // (station is one physical building; if any platform is busy, it's busy).
          let worst = null;
          for (const c of st.codes) {
            const lv = crowdLevel(c);
            if (!lv || lv === 'na') continue;
            if (lv === 'h') { worst = 'h'; break; }
            if (lv === 'm' && worst !== 'h') worst = 'm';
            else if (lv === 'l' && !worst) worst = 'l';
          }
          const dot = worst
            ? `<span class="crowd-dot crowd-${worst}" aria-label="${esc(crowdAriaLabel(worst))}" title="${esc(crowdAriaLabel(worst))}"></span>`
            : '';
          return `<span class="mrt-chip" title="${esc(st.name)} — ${fmtDistance(st.distanceM)}">
                    ${codesHtml}
                    <span class="mrt-chip-name">${esc(st.name)}</span>
                    ${dot}
                    <span class="mrt-chip-dist">${esc(fmtDistance(st.distanceM))}</span>
                  </span>`;
        }).join('');
        mrtLine = `<div class="route-stop-mrt" aria-label="Nearby train stations: ${esc(labelParts)}">
          <span class="mrt-icon" aria-hidden="true">🚇</span>${chips}
        </div>`;
      }
    }
    // T18: alarm button — only shown if the stop has coordinates
    // (otherwise we can't compute distance to it).
    const hasCoords = info && typeof info.Latitude === 'number' && typeof info.Longitude === 'number';
    const armed = isArmed(r.BusStopCode);
    const alarmBtn = hasCoords
      ? `<button class="route-stop-alarm ${armed ? 'armed' : ''}"
                 data-alarm-code="${esc(r.BusStopCode)}"
                 aria-label="${armed ? 'Disarm alighting alarm' : 'Set alighting alarm'} for ${esc(info ? info.Description : r.BusStopCode)}"
                 title="${armed ? 'Disarm alarm' : 'Alert me approaching this stop'}"
                 tabindex="0"
                 type="button">${armed ? '🔔' : '🔕'}</button>`
      : '';
    return `<div class="route-stop-item ${isCur ? 'current-stop' : ''}" role="listitem" tabindex="0"
              data-code="${esc(r.BusStopCode)}"
              aria-label="${esc(info ? info.Description : r.BusStopCode)}, stop ${r.StopSequence}">
      <div class="route-stop-line"></div><div class="route-stop-dot"></div>
      <div class="route-stop-info">
        <div class="route-stop-name">${esc(info ? info.Description : r.BusStopCode)}</div>
        <div class="route-stop-code-small">${esc(r.BusStopCode)}${info ? ' · ' + esc(info.RoadName) : ''}</div>
        ${timingLine}
        ${mrtLine}
      </div>
      ${alarmBtn}
      <span class="route-stop-seq">#${r.StopSequence}</span>
    </div>`;
  }).join('');

  list.onclick = async (ev) => {
    // T18: alarm button takes precedence over stop selection
    const alarmBtn = ev.target.closest('.route-stop-alarm');
    if (alarmBtn) {
      ev.stopPropagation();
      const code = alarmBtn.dataset.alarmCode;
      if (isArmed(code)) {
        await disarmAlarm();
        showToast('Alarm disarmed', '', null, 2000);
      } else {
        const stopInfo = stopMap[code];
        if (stopInfo) {
          // T19: pass full ordered stop list (with coords) so alarm can
          // announce per-stop progress along the route. The destination
          // (stopInfo) must be inside this list — it is, since we're
          // arming for a stop in this direction's `sorted` array.
          const allStops = sorted.map(r => {
            const info = stopMap[r.BusStopCode];
            return {
              BusStopCode: r.BusStopCode,
              StopSequence: r.StopSequence,
              Description: info?.Description || r.BusStopCode,
              RoadName: info?.RoadName,
              Latitude: info?.Latitude,
              Longitude: info?.Longitude,
            };
          });
          await armAlarm({ ...stopInfo, StopSequence: sorted.find(r => r.BusStopCode === code)?.StopSequence }, allStops);
        }
      }
      // Re-render to update bell icons
      renderRouteList(state.currentRouteData, currentRouteDir);
      return;
    }
    const item = ev.target.closest('.route-stop-item');
    if (!item) return;
    selectStopByCode(item.dataset.code);
  };
  list.onkeydown = (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const item = ev.target.closest('.route-stop-item');
    if (!item) return;
    ev.preventDefault();
    selectStopByCode(item.dataset.code);
  };

  setTimeout(() => {
    const cur = list.querySelector('.current-stop');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }, 100);
  if (mapOpen) {
    const sorted2 = state.currentRouteData.filter(r => r.Direction === dir).sort((a, b) => a.StopSequence - b.StopSequence);
    renderMap(sorted2);
  }

  // T6: fetch crowding for any MRT stations on this route, then re-render so
  // dots appear. Capture the route+dir we rendered so we don't re-render
  // after the user has navigated away.
  //
  // Loop guard: if we just finished a re-render triggered by a crowding fetch,
  // the cache is now fresh for all stations we care about. The next call to
  // ensureCrowdingFor() will find every line fresh and return immediately —
  // but without this guard we'd still schedule another renderRouteList, and
  // so on ad infinitum, starving the main thread (which breaks the map tap).
  if (renderRouteList._skipCrowdFetch) {
    renderRouteList._skipCrowdFetch = false;
    return;
  }
  const renderedRoutes = routes;
  const renderedDir = dir;
  (async () => {
    const stationsSeen = [];
    const seen = new Set();
    for (const r of sorted) {
      const info = stopMap[r.BusStopCode];
      if (!info || typeof info.Latitude !== 'number') continue;
      for (const st of stationsNear(info.Latitude, info.Longitude)) {
        if (seen.has(st.name)) continue;
        seen.add(st.name);
        stationsSeen.push(st);
      }
    }
    if (!stationsSeen.length) return;
    // Snapshot cache state before the fetch so we can detect if anything new
    // actually landed. If the fetch was a no-op (everything was fresh), we
    // can skip the re-render entirely.
    const before = stationsSeen.map(s => s.codes.map(c => crowdLevel(c)).join(',')).join('|');
    await ensureCrowdingFor(stationsSeen);
    const after = stationsSeen.map(s => s.codes.map(c => crowdLevel(c)).join(',')).join('|');
    if (before === after) return; // nothing changed; don't re-render

    // Re-render only if the same route+direction is still visible
    if (state.currentRouteData === renderedRoutes && currentRouteDir === renderedDir &&
        $id('route-panel').style.display === 'block') {
      renderRouteList._skipCrowdFetch = true;
      renderRouteList(renderedRoutes, renderedDir);
    }
  })();
}

function switchDir(dir) {
  currentRouteDir = dir;
  const dirs = [...new Set(state.currentRouteData.map(r => r.Direction))].sort();
  document.querySelectorAll('.map-dir-tab').forEach((t, i) => {
    const active = dirs[i] === dir;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active);
  });
  renderRouteList(state.currentRouteData, dir);
}

export function toggleMap() {
  if (mapOpen) { closeMap(); return; }
  mapOpen = true;
  const container = $id('map-container');
  const btn = $id('mapToggleBtn');
  container.classList.add('open');
  btn.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/></svg> Hide map <span class="map-arrow" aria-hidden="true">▾</span>`;

  if (!mapInitialised) {
    leafletMap = L.map('route-map', { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(leafletMap);
    mapInitialised = true;
  }
  setTimeout(() => {
    if (!mapOpen) return; // user closed map before this timer fired
    leafletMap.invalidateSize();
    const sorted = state.currentRouteData.filter(r => r.Direction === currentRouteDir).sort((a, b) => a.StopSequence - b.StopSequence);
    renderMap(sorted);
    // T11: subscribe to live position updates so the map shows a user marker
    startMapUserMarker();
    setTimeout(() => container.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
  }, 420);
}

export function closeMap() {
  mapOpen = false;
  // T11: unsubscribe and remove user-marker layers before tearing down map UI
  stopMapUserMarker();
  const container = $id('map-container');
  const btn = $id('mapToggleBtn');
  if (container) container.classList.remove('open');
  if (btn) {
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/></svg> Show map <span class="map-arrow" aria-hidden="true">▾</span>`;
  }
}

function renderMap(stopsInOrder) {
  if (!leafletMap) return;
  leafletMap.eachLayer(layer => { if (!(layer instanceof L.TileLayer)) leafletMap.removeLayer(layer); });

  const stopMap = {};
  state.busStops.forEach(s => stopMap[s.BusStopCode] = s);
  const curCode = state.currentStop && state.currentStop.BusStopCode;
  const coords = [];
  let curMarker = null;

  const valid = stopsInOrder.filter(r => {
    const i = stopMap[r.BusStopCode];
    return i && i.Latitude && i.Longitude;
  });

  valid.forEach((r, idx) => {
    const info = stopMap[r.BusStopCode];
    const lat = parseFloat(info.Latitude);
    const lng = parseFloat(info.Longitude);
    coords.push([lat, lng]);

    const isCur = r.BusStopCode === curCode;
    const isEnd = idx === 0 || idx === valid.length - 1;
    const color = isCur ? '#00d4aa' : isEnd ? '#0099ff' : '#8899bb';
    const size = isCur ? 16 : isEnd ? 12 : 8;

    const icon = L.divIcon({
      className: '',
      html: `<div style="width:${size}px;height:${size}px;background:${color};border:2px solid ${isCur ? '#fff' : 'rgba(255,255,255,0.35)'};border-radius:50%;box-shadow:0 0 6px ${color}88;"></div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2]
    });

    const m = L.marker([lat, lng], { icon, zIndexOffset: isCur ? 1000 : isEnd ? 500 : 100 });
    // Popup content: use DOM creation instead of innerHTML to keep XSS-safe
    const popup = document.createElement('div');
    popup.innerHTML = `
      <div class="map-popup-code"></div>
      <div class="map-popup-name"></div>
      <div class="map-popup-road"></div>
      <button class="map-popup-btn" type="button">View arrivals →</button>`;
    popup.querySelector('.map-popup-code').textContent = r.BusStopCode;
    popup.querySelector('.map-popup-name').textContent = info.Description;
    popup.querySelector('.map-popup-road').textContent = `${info.RoadName} · #${r.StopSequence}`;
    popup.querySelector('.map-popup-btn').addEventListener('click', () => {
      selectStopByCode(r.BusStopCode);
      leafletMap.closePopup();
    });
    m.bindPopup(popup, { maxWidth: 220, minWidth: 180 });
    m.addTo(leafletMap);
    if (isCur) curMarker = m;
  });

  if (coords.length > 1) {
    L.polyline(coords, { color: '#0099ff', weight: 3, opacity: 0.65 }).addTo(leafletMap);
  }
  if (coords.length > 0) {
    leafletMap.fitBounds(coords, { padding: [20, 20] });
    if (curMarker) setTimeout(() => curMarker.openPopup(), 700);
  }

  // T11: renderMap wipes all non-tile layers (line 451's eachLayer call),
  // so any existing user marker has just been removed. Re-render it from
  // the cached position if we have one. The marker objects themselves are
  // gone — we treat them as discarded and rebuild fresh.
  userMarker = null;
  accuracyCircle = null;
  if (lastUserPosition) renderUserMarker(lastUserPosition);
}

// T11 — User position marker on map
// Creates or updates the user-marker + accuracy-circle layers from the
// given position. Hides them entirely if accuracy is too poor to be
// meaningful (>500m would imply a marker that's "somewhere in this
// neighbourhood", which is misleading rather than helpful).
function renderUserMarker(pos) {
  if (!leafletMap) return;
  const { lat, lng, accuracy } = pos;

  // If accuracy is too poor, remove any existing marker rather than
  // showing a misleading one
  if (accuracy && accuracy > MAP_MARKER_ACCURACY_CUTOFF_M) {
    if (userMarker) { leafletMap.removeLayer(userMarker); userMarker = null; }
    if (accuracyCircle) { leafletMap.removeLayer(accuracyCircle); accuracyCircle = null; }
    return;
  }

  // Accuracy circle: semi-transparent blue ring sized to GPS error
  if (accuracy && accuracy > 10) {
    if (accuracyCircle) {
      accuracyCircle.setLatLng([lat, lng]);
      accuracyCircle.setRadius(accuracy);
    } else {
      accuracyCircle = L.circle([lat, lng], {
        radius: accuracy,
        color: '#1e88e5',
        fillColor: '#1e88e5',
        fillOpacity: 0.10,
        weight: 1,
        interactive: false, // don't intercept taps
      }).addTo(leafletMap);
    }
  } else if (accuracyCircle) {
    leafletMap.removeLayer(accuracyCircle);
    accuracyCircle = null;
  }

  // The marker itself: solid blue dot with white border (Google Maps style)
  if (userMarker) {
    userMarker.setLatLng([lat, lng]);
  } else {
    const userIcon = L.divIcon({
      className: 'user-marker-wrap',
      html: '<div class="user-marker-dot" aria-hidden="true"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    userMarker = L.marker([lat, lng], {
      icon: userIcon,
      zIndexOffset: 2000, // above all stop markers
      keyboard: false,
      interactive: false,
    }).addTo(leafletMap);
  }
}

function startMapUserMarker() {
  if (mapPositionListener) return;
  lastUserPosition = null;
  mapPositionListener = (pos) => {
    lastUserPosition = pos;
    renderUserMarker(pos);
  };
  addPositionListener(mapPositionListener);
}

function stopMapUserMarker() {
  if (mapPositionListener) {
    removePositionListener(mapPositionListener);
    mapPositionListener = null;
  }
  if (userMarker && leafletMap) leafletMap.removeLayer(userMarker);
  if (accuracyCircle && leafletMap) leafletMap.removeLayer(accuracyCircle);
  userMarker = null;
  accuracyCircle = null;
  lastUserPosition = null;
}

export function closeRoutePanel() {
  $id('route-panel').style.display = 'none';
  closeMap();
  stopLiveTracking(); // T9: unsubscribe from geolocation watch
  disarmAlarm();      // T18: tear down any active alarm cleanly
  state.currentRouteService = null;
  state.currentRouteData = [];
}
