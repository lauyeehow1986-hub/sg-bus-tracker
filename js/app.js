// ── App entry point ───────────────────────────────────
// Imports modules, wires cross-module callbacks, binds event listeners on
// static HTML elements, runs the proxy check, and starts the SW/PWA bits.
import { state, PROXY_BASE, setProxyBase } from './state.js';
import { $id } from './dom.js';
import { showToast, toastError, errorFor } from './toast.js';
import * as api from './api.js';
import { loadBusStops } from './stops.js';
import {
  initSearch, handleSearch, handleKey, hideSuggestions, selectStopByCode,
} from './search.js';
import {
  initArrivals, fetchArrivals, refreshArrivals, setupAutoRefresh, rerenderCurrentArrivals,
} from './arrivals.js';
import {
  showRoute, toggleMap, closeRoutePanel, preloadBusServices,
} from './route.js';
import {
  togglePlanPanel, closePlanPanel, handlePlanSearch, handlePlanKey, runPlanSearch,
} from './planner.js';
import {
  initFavs, toggleFavourite, updateFavBtn, renderFavourites, closeAllRename,
} from './favs.js';
import {
  registerSW, initInstallPrompt, initOnlineStatus, initVisibilityHandlers,
  initPullToRefresh, initPwa, clearTileCache, updateSW, updateCacheStats,
  maybeShowInstallBanner,
} from './pwa.js';
import { cacheLastKnownCoords, loadLastKnownCoords, relativeTime } from './cache.js';
import { log, enableProxyLog } from './log.js';
import { loadStations } from './stations.js';
import { startAlertsPolling } from './train.js';

// ── Cross-module wiring ───────────────────────────────
// search + favs both ask the app "please select this stop" — app centralises
// the side effects (update header, load arrivals, update fav button, etc.)
function selectStop(stop) {
  state.currentStop = stop;
  showStopHeader(stop);
  fetchArrivals(stop.BusStopCode);
  updateFavBtn();
}
initSearch(selectStop);
initFavs(selectStop);

// arrivals exposes showRoute delegation to planner/route
initArrivals(showRoute);

// PWA pull-to-refresh + visibility need to know how to refresh
initPwa(() => {
  if (state.currentStop) fetchArrivals(state.currentStop.BusStopCode);
});

// ── Called once the bus stops dataset is ready ────────
// Kicks off /BusServices preload in the background so arrival badges pick up
// the correct operator colour (T3.4) once the service-to-operator map is
// known. Cheap — ~700 services in 1-2 paginated requests.
function onStopsReady() {
  preloadBusServices()
    .then(() => {
      // Re-colour any arrivals already on screen
      rerenderCurrentArrivals();
    })
    .catch(err => {
      console.warn('[app] BusServices preload failed:', err);
    });
}

// ── UI helpers ────────────────────────────────────────
function showStopHeader(stop) {
  const header = $id('stop-header');
  $id('displayCode').textContent = stop.BusStopCode;
  $id('displayName').textContent = stop.Description;
  $id('displayRoad').textContent = stop.RoadName || '';
  header.style.display = 'block';
  // Plan button only makes sense once a stop is selected
  $id('planBtn').style.display = 'inline-flex';
  setTimeout(() => header.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

function updateApiBtn(hasKey) {
  const btn = $id('apiToggleBtn');
  btn.className = hasKey ? 'api-btn set' : 'api-btn';
  btn.textContent = hasKey ? '✓ API Key' : '⚙ API Key';
}

// ── Proxy check (same-origin; falls back to loopback) ─
let proxyCheckTimer = null;
let proxyCheckAttempts = 0;
let inflight = false;

async function tryConnect(base) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const data = await api.proxyKeycheck(base, ctrl.signal);
    clearTimeout(t);
    return { base, data };
  } catch (_) { return null; }
}

async function checkProxy() {
  if (inflight) return;
  inflight = true;
  try {
    proxyCheckAttempts++;
    $id('proxyStatusText').textContent = `checking proxy… (${proxyCheckAttempts})`;

    let result = await tryConnect(PROXY_BASE);
    if (!result) {
      for (const alt of ['http://127.0.0.1:8080', 'http://localhost:8080']) {
        if (alt !== PROXY_BASE) {
          result = await tryConnect(alt);
          if (result) { setProxyBase(alt); break; }
        }
      }
    }

    if (result) {
      clearInterval(proxyCheckTimer);
      proxyCheckTimer = null;
      proxyCheckAttempts = 0;
      state.proxyOk = true;
      enableProxyLog();
      log.info('proxy', 'connected', { base: PROXY_BASE, hasKey: !!result.data.hasKey });

      $id('proxyStatusText').textContent = 'proxy running ✓';
      $id('proxyDot').className = 'proxy-dot ok';
      $id('proxyStatusMsg').textContent = `Connected: ${PROXY_BASE} ✓`;
      updateApiBtn(result.data.hasKey);

      if (result.data.hasKey) {
        $id('api-panel').style.display = 'none';
        $id('apiToggleBtn').setAttribute('aria-expanded', 'false');
        loadBusStops(onStopsReady);
        // T6: once we have a proxy + key, start polling train alerts
        startAlertsPolling();
      } else {
        $id('api-panel').style.display = 'block';
        $id('apiToggleBtn').setAttribute('aria-expanded', 'true');
        $id('apiKeyInput').focus();
        showToast('Proxy connected! Enter your LTA API key', 'success');
      }
    } else {
      state.proxyOk = false;
      $id('proxyDot').className = 'proxy-dot err';
      $id('proxyStatusMsg').textContent = 'proxy.py not running — start it in Termux, then open the URL it prints';
      if (proxyCheckAttempts >= 10) {
        clearInterval(proxyCheckTimer);
        proxyCheckTimer = null;
        $id('proxyStatusText').textContent = 'proxy offline ✗';
        showToast('Proxy not found — run: python proxy.py', 'error',
          { label: 'Retry', onClick: retryProxyCheck });
      }
    }
  } finally {
    inflight = false;
  }
}

function retryProxyCheck() {
  proxyCheckAttempts = 0;
  clearInterval(proxyCheckTimer);
  checkProxy();
  proxyCheckTimer = setInterval(checkProxy, 3000);
}

// ── API key save ──────────────────────────────────────
async function saveApiKey() {
  const val = $id('apiKeyInput').value.trim();
  if (!val || val.includes('•')) { showToast('Enter a valid API key', 'error'); return; }
  try {
    const data = await api.setApiKey(val);
    if (data.ok) {
      updateApiBtn(true);
      $id('api-panel').style.display = 'none';
      $id('apiToggleBtn').setAttribute('aria-expanded', 'false');
      showToast('API key saved!', 'success');
      loadBusStops(onStopsReady);
      startAlertsPolling();
      setTimeout(maybeShowInstallBanner, 2000);
    } else {
      showToast(data.message || 'Could not save key', 'error');
    }
  } catch (e) {
    toastError(e, 'api');
  }
}

// ── API panel show/hide ───────────────────────────────
function toggleApiPanel() {
  const p = $id('api-panel');
  if (p.style.display === 'none') showApiPanel();
  else closeApiPanel();
  setTimeout(updateCacheStats, 200);
}
function showApiPanel() {
  $id('api-panel').style.display = 'block';
  $id('apiToggleBtn').setAttribute('aria-expanded', 'true');
}
function closeApiPanel() {
  if (state.proxyOk && $id('apiToggleBtn').classList.contains('set')) {
    $id('api-panel').style.display = 'none';
    $id('apiToggleBtn').setAttribute('aria-expanded', 'false');
  }
}

// ── Geolocation: nearby stops ─────────────────────────
async function findNearby() {
  if (!state.busStopsLoaded) { showToast('Stops still loading…'); return; }
  const btn = $id('nearbyBtn');
  btn.classList.add('loading');

  let coords = null;
  let usedCache = false;

  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000, maximumAge: 30000 })
    );
    coords = { lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() };
    cacheLastKnownCoords(coords.lat, coords.lng);
  } catch (err) {
    // T3.2: fall back to last-known coords if available
    const cached = loadLastKnownCoords();
    if (cached && Date.now() - cached.ts < 24 * 60 * 60 * 1000) {
      coords = cached;
      usedCache = true;
      const info = errorFor(err, 'geolocation');
      showToast(`${info.msg} — using last known location (${relativeTime(cached.ts)})`, 'error',
        info.action, 5000);
    } else {
      toastError(err, 'geolocation');
      btn.classList.remove('loading');
      return;
    }
  }

  try {
    const { lat, lng } = coords;
    // T17: previously capped at 8 stops via .slice(0, 8). In dense
    // areas (Bedok, Tampines, the CBD), 600m radius can legitimately
    // contain 15-25 stops. The cap was arbitrary and silently dropped
    // stops the user might genuinely want. The 600m radius itself is
    // the real bound — stops beyond aren't really "nearby" in any
    // useful sense — so we just show everything within range.
    const withDist = state.busStops.map(s => {
      const dLat = (s.Latitude - lat) * Math.PI / 180;
      const dLng = (s.Longitude - lng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat * Math.PI / 180) * Math.cos(s.Latitude * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
      const d = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return { ...s, dist: d };
    }).filter(s => s.dist < 600).sort((a, b) => a.dist - b.dist);

    if (!withDist.length) { showToast('No stops within 600m', 'error'); return; }

    const el = $id('suggestions');
    const { esc } = await import('./dom.js');
    const cacheNote = usedCache
      ? `<span class="nearby-dist-badge" style="background:var(--warn);color:#fff">cached · ${esc(relativeTime(coords.ts))}</span>`
      : `<span class="nearby-dist-badge">${withDist.length} found</span>`;
    el.innerHTML = `<div class="nearby-results-label">
        <span>📍 Nearby stops</span>
        ${cacheNote}
      </div>` +
      withDist.map(s => `
        <div class="suggestion-item" role="option" aria-selected="false"
             data-code="${esc(s.BusStopCode)}">
          <span class="stop-code">${esc(s.BusStopCode)}</span>
          <div style="flex:1">
            <div class="stop-name-sug">${esc(s.Description)}</div>
            <div class="stop-road">${esc(s.RoadName)}</div>
          </div>
          <span class="stop-dist">${s.dist < 100 ? '<100m' : Math.round(s.dist / 10) * 10 + 'm'}</span>
        </div>`).join('');
    el.onclick = (ev) => {
      const item = ev.target.closest('.suggestion-item');
      if (!item) return;
      selectStopByCode(item.dataset.code);
    };
    el.style.display = 'block';
    $id('searchInput').value = '';
    $id('searchInput').focus();
  } finally {
    btn.classList.remove('loading');
  }
}

// ── Global click: close panels when clicking outside ──
document.addEventListener('click', e => {
  if (!e.target.closest('#suggestions') && !e.target.closest('#searchInput') && !e.target.closest('.nearby-btn')) {
    hideSuggestions();
  }
  if (!e.target.closest('#planSuggestions') && !e.target.closest('#planDestInput')) {
    $id('planSuggestions').innerHTML = '';
  }
  if (!e.target.closest('.fav-chip')) closeAllRename();
});

// T3.3: Escape closes whichever panel is open; focus returns to its trigger
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if ($id('plan-panel').style.display === 'block') {
    closePlanPanel();
    return;
  }
  if ($id('route-panel').style.display === 'block') {
    closeRoutePanel();
    // Return focus to the card that triggered it (if any) — fall back to #arrivals
    const focusTarget = document.querySelector('.card-header[aria-expanded="true"]') || $id('arrivals');
    if (focusTarget && focusTarget.focus) focusTarget.focus();
  }
});

// ── Bind event listeners on static HTML ───────────────
function bindStaticHandlers() {
  $id('apiToggleBtn').addEventListener('click', toggleApiPanel);
  $id('proxyRetryBtn').addEventListener('click', retryProxyCheck);
  $id('saveKeyBtn').addEventListener('click', saveApiKey);
  $id('closeKeyBtn').addEventListener('click', closeApiPanel);
  $id('clearTileBtn').addEventListener('click', clearTileCache);
  $id('updateSWBtn').addEventListener('click', updateSW);

  $id('searchInput').addEventListener('input', e => handleSearch(e.target.value));
  $id('searchInput').addEventListener('keydown', handleKey);
  $id('nearbyBtn').addEventListener('click', findNearby);

  $id('planBtn').addEventListener('click', togglePlanPanel);
  $id('favBtn').addEventListener('click', toggleFavourite);
  $id('refreshBtn').addEventListener('click', refreshArrivals);

  $id('closePlanBtn').addEventListener('click', closePlanPanel);
  $id('planDestInput').addEventListener('input', e => handlePlanSearch(e.target.value));
  $id('planDestInput').addEventListener('keydown', handlePlanKey);
  $id('planGoBtn').addEventListener('click', runPlanSearch);

  $id('closeRouteBtn').addEventListener('click', closeRoutePanel);
  $id('mapToggleBtn').addEventListener('click', toggleMap);
}

// ── Boot ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  bindStaticHandlers();
  renderFavourites();

  // Start PWA handlers after DOM is ready
  registerSW();
  initInstallPrompt();
  initOnlineStatus();
  initVisibilityHandlers();
  initPullToRefresh();

  // T5.2: load MRT/LRT station dataset in background for proximity badges
  loadStations().then(list => {
    log.info('stations', `loaded ${list.length} MRT/LRT stations`);
  });

  // Proxy check: first attempt immediately, then retry every 3s until connected
  retryProxyCheck();
});
