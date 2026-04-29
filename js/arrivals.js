// ── Arrivals: fetch, render, countdown, refresh ──────
import { state } from './state.js';
import * as api from './api.js';
import { $id, esc } from './dom.js';
import { errorFor, toastError } from './toast.js';
import { haptic } from './pwa.js';
import { cacheArrivals, loadCachedArrivals, relativeTime } from './cache.js';
import { svcColor, operatorName } from './svc.js';
import { firstLastForService, fetchRouteData } from './route.js';
import { firstLastForDay, formatHHMMShort, lastBusPassed, timingDayKey } from './timing.js';

let onShowRoute = () => {};
export function initArrivals(showRouteHandler) { onShowRoute = showRouteHandler; }

export async function fetchArrivals(code) {
  const container = $id('arrivals');
  container.style.display = 'block';

  // Pre-render from cache if available — instant paint while network runs
  const cached = loadCachedArrivals(code);
  if (cached) {
    state.arrivalData = cached.services;
    renderArrivals(cached.services, { staleAt: cached.ts });
    startCountdown();
  } else {
    container.innerHTML = `
      <div class="skeleton skeleton-card" aria-hidden="true"></div>
      <div class="skeleton skeleton-card" aria-hidden="true"></div>
      <div class="skeleton skeleton-card" aria-hidden="true"></div>
      <div class="sr-only">Loading arrivals</div>`;
  }

  const r = await api.getBusArrival(code);
  if (!r.ok) {
    // If we rendered cached data, keep it with a prominent stale banner.
    // Otherwise show the error.
    if (cached) {
      renderArrivals(cached.services, { staleAt: cached.ts, failed: true, errKind: r.error.kind });
      return;
    }
    const info = errorFor(r.error, 'api');
    container.innerHTML = `<div class="no-service"><div class="emoji" aria-hidden="true">⚠️</div>${esc(info.msg)}</div>`;
    return;
  }
  state.arrivalData = r.data.Services || [];
  cacheArrivals(code, state.arrivalData);
  renderArrivals(state.arrivalData);
  $id('lastUpdated').textContent = '↺ ' + new Date().toLocaleTimeString('en-SG');
  setupAutoRefresh();
  startCountdown();

  // T5.1: Warm up per-service route cache so first/last timings can render.
  // Only fetches services we don't already have; each fetchRouteData is
  // essentially a filter over the cached full dataset, so this is cheap.
  // Re-render once when any service newly populates, to surface timings.
  warmUpTimings(code, state.arrivalData);
}

// Lazily populate route cache for services visible in the current arrivals,
// then re-render to show first/last times for stops that just got data.
async function warmUpTimings(stopCode, services) {
  const missing = services
    .map(s => s.ServiceNo)
    .filter(sv => !state.routeCache[sv]);
  if (!missing.length) return;
  // Fire in parallel but don't block; re-render after all settle
  await Promise.allSettled(missing.map(sv => fetchRouteData(sv)));
  // Only re-render if this stop is still the current one (user may have moved)
  if (state.currentStop && state.currentStop.BusStopCode === stopCode &&
      state.arrivalData && state.arrivalData.length) {
    renderArrivals(state.arrivalData);
  }
}

export function refreshArrivals() {
  if (!state.currentStop) return;
  const btn = $id('refreshBtn');
  btn.classList.add('spinning');
  fetchArrivals(state.currentStop.BusStopCode)
    .finally(() => setTimeout(() => btn.classList.remove('spinning'), 600));
  haptic(10);
}

// T1.3: only poll while visible AND online
export function setupAutoRefresh() {
  clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = null;
  if (!state.currentStop) return;
  if (document.hidden || !navigator.onLine) return;
  state.autoRefreshTimer = setInterval(() => {
    if (state.currentStop && !document.hidden && navigator.onLine) {
      fetchArrivals(state.currentStop.BusStopCode);
    }
  }, 30000);
}

export function stopAutoRefresh() {
  clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = null;
}

function fmt(iso) {
  if (!iso) return { display: '—', cls: 'far', ok: false, secs: null };
  const secs = Math.round((new Date(iso) - Date.now()) / 1000);
  const mins = Math.round(secs / 60);
  if (secs <= 0)  return { display: 'Arr', cls: 'arriving', ok: true, secs: 0 };
  if (mins === 1) return { display: '1 min', cls: 'arriving', ok: true, secs };
  if (mins <= 3)  return { display: `${mins} min`, cls: 'soon', ok: true, secs };
  if (mins <= 10) return { display: `${mins} min`, cls: 'coming', ok: true, secs };
  return { display: `${mins} min`, cls: 'far', ok: true, secs };
}

function arrPill(t, label, iso) {
  if (!t.ok) return '';
  const etaAttr = iso ? ` data-eta="${esc(iso)}"` : '';
  return `<div class="arrival-pill">
    <span class="arrival-time ticking ${t.cls}"${etaAttr}>${esc(t.display)}</span>
    <span class="arrival-label">${esc(label)}</span>
  </div>`;
}

function detailBlock(label, bus, t) {
  if (!bus || !bus.EstimatedArrival) return '';
  const type = bus.Type === 'DD' ? 'dd' : bus.Type === 'BD' ? 'ben' : 'sd';
  const typeLbl = bus.Type === 'DD' ? 'Double Deck' : bus.Type === 'BD' ? 'Bendy' : 'Single';
  const wab = bus.Feature === 'WAB' ? '<span class="tag tag-wab">♿ WAB</span>' : '';
  const load = bus.Load === 'SEA' ? 'seats' : bus.Load === 'SDA' ? 'standing' : 'limited';
  const loadLbl = bus.Load === 'SEA' ? 'Seats Avail' : bus.Load === 'SDA' ? 'Standing' : 'Ltd Seats';
  return `<div class="detail-bus">
    <div class="detail-bus-label">${esc(label)}</div>
    <div class="detail-bus-time ${t.cls}">${esc(t.display)}</div>
    <div class="detail-tags"><span class="tag tag-${type}">${typeLbl}</span><span class="tag tag-seats-${load}">${loadLbl}</span>${wab}</div>
  </div>`;
}

function svcBadgeAria(svcNo) {
  const op = operatorName(svcNo);
  return op ? `Bus ${svcNo}, operated by ${op}` : `Bus ${svcNo}`;
}

function renderArrivals(services, opts = {}) {
  const c = $id('arrivals');
  const staleBanner = opts.staleAt
    ? `<div class="stale-banner ${opts.failed ? 'stale-failed' : ''}" role="status">
         <span class="stale-dot" aria-hidden="true"></span>
         ${opts.failed ? 'Offline' : 'Cached'} · last updated ${esc(relativeTime(opts.staleAt))}
       </div>`
    : '';

  if (!services.length) {
    c.innerHTML = staleBanner + '<div class="no-service"><div class="emoji" aria-hidden="true">🚌</div>No buses at this stop right now.</div>';
    return;
  }

  const cards = services.map((svc, i) => {
    const iso1 = svc.NextBus  && svc.NextBus.EstimatedArrival;
    const iso2 = svc.NextBus2 && svc.NextBus2.EstimatedArrival;
    const iso3 = svc.NextBus3 && svc.NextBus3.EstimatedArrival;
    const t1 = fmt(iso1), t2 = fmt(iso2), t3 = fmt(iso3);
    const svcNoEsc = esc(svc.ServiceNo);
    const noData = !t1.ok && !t2.ok && !t3.ok;
    const row = state.currentStop ? firstLastForService(state.currentStop.BusStopCode, svc.ServiceNo) : null;
    const fl = row ? firstLastForDay(row) : null;
    const passed = row ? lastBusPassed(row) : null;
    const timingHtml = fl
      ? `<div class="arrival-timing ${passed ? 'last-passed' : ''}"
              aria-label="${esc(fl.day)} first bus ${fl.first ? formatHHMMShort(fl.first) : 'unknown'}, last bus ${fl.last ? formatHHMMShort(fl.last) : 'unknown'}${passed ? ', last bus has passed' : ''}">
          <span class="arrival-timing-label">${esc(fl.day)}</span>
          ${fl.first ? `first <strong>${esc(formatHHMMShort(fl.first))}</strong>` : ''}
          ${fl.first && fl.last ? ' · ' : ''}
          ${fl.last ? `last <strong>${esc(formatHHMMShort(fl.last))}</strong>` : ''}
          ${passed ? ' <span class="timing-warn">· last bus passed</span>' : ''}
         </div>`
      : '';

    return `
    <div class="bus-service-card fade-in ${passed ? 'service-after-last' : ''}" style="animation-delay:${i * 40}ms">
      <div class="card-header" data-toggle="d${i}" data-chev="c${i}" role="button" tabindex="0" aria-expanded="false" aria-controls="d${i}">
        <div class="service-badge ${svcColor(svc.ServiceNo)}" aria-label="${esc(svcBadgeAria(svc.ServiceNo))}" title="${esc(svcBadgeAria(svc.ServiceNo))}">${svcNoEsc}</div>
        <div class="card-arrivals">
          ${arrPill(t1, 'Now', iso1)}${t1.ok && t2.ok ? '<span class="arrival-sep">·</span>' : ''}
          ${arrPill(t2, 'Next', iso2)}${t2.ok && t3.ok ? '<span class="arrival-sep">·</span>' : ''}
          ${arrPill(t3, 'After', iso3)}
          ${noData ? '<span style="color:var(--muted);font-size:12px;font-family:var(--mono)">No data</span>' : ''}
        </div>
        <span class="card-chevron" id="c${i}" aria-hidden="true">▾</span>
      </div>
      <div class="card-detail" id="d${i}">
        <div class="detail-row">
          ${detailBlock('Current', svc.NextBus, t1)}
          ${detailBlock('Next', svc.NextBus2, t2)}
          ${detailBlock('After', svc.NextBus3, t3)}
        </div>
        ${timingHtml}
        <button class="route-btn" data-route-svc="${svcNoEsc}" aria-label="View route for service ${svcNoEsc}">🗺 View route for ${svcNoEsc}</button>
      </div>
    </div>`;
  }).join('');
  c.innerHTML = staleBanner + cards;

  // Event delegation: card toggles + route buttons
  c.onclick = (e) => {
    const header = e.target.closest('.card-header');
    if (header) {
      const id = header.dataset.toggle;
      const chev = header.dataset.chev;
      const d = document.getElementById(id);
      const ch = document.getElementById(chev);
      if (d) d.classList.toggle('open');
      if (ch) ch.classList.toggle('open');
      header.setAttribute('aria-expanded', d && d.classList.contains('open') ? 'true' : 'false');
      return;
    }
    const routeBtn = e.target.closest('[data-route-svc]');
    if (routeBtn) {
      e.stopPropagation();
      onShowRoute(routeBtn.dataset.routeSvc, e);
    }
  };
  // Keyboard: Enter/Space on card headers
  c.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const header = e.target.closest('.card-header');
    if (!header) return;
    e.preventDefault();
    header.click();
  };
}

// Live countdown ticker
function startCountdown() {
  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(tickCountdown, 1000);
}

function tickCountdown() {
  document.querySelectorAll('[data-eta]').forEach(el => {
    const iso = el.dataset.eta;
    const t = fmt(iso);
    const secs = t.secs;
    if (secs !== null && secs >= 0 && secs < 600) {
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      el.textContent = secs < 60 ? `${secs}s` : `${m}:${String(s).padStart(2, '0')}`;
      el.className = `arrival-time ticking ${t.cls}`;
    } else if (t.ok) {
      el.textContent = t.display;
      el.className = `arrival-time ${t.cls}`;
    }
  });
}

export function stopCountdown() { clearInterval(state.countdownTimer); state.countdownTimer = null; }

// Re-render the current arrivals view without hitting the network.
// Called after /BusServices preloads so badges pick up operator colours.
export function rerenderCurrentArrivals() {
  if (state.arrivalData && state.arrivalData.length) {
    renderArrivals(state.arrivalData);
  }
}
