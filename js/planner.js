// ── Journey planner ──────────────────────────────────
import { state } from './state.js';
import * as api from './api.js';
import { $id, esc } from './dom.js';
import { findStops } from './stops.js';
import { fetchRouteData, showRoute, getStopToServices } from './route.js';
import { svcColor } from './svc.js';
import { mrtHintForJourney } from './mrtHint.js';
import { loadStations } from './stations.js';

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

function estimateTravelMins(stops, distKm) {
  const byStops = stops * 2;
  const byDist = (parseFloat(distKm) / 20) * 60;
  return Math.round(Math.max(byStops, byDist));
}

// ── T4.1: Transfer-based route discovery ─────────────
// Strategy:
//   For each service S1 at origin (leg 1 candidate) whose route does NOT
//   reach destination, walk its forward stops. At each such stop X, find
//   services that (a) serve X and (b) have destination forward of X in their
//   route. Each matching (S1, X, S2) is a viable 1-transfer journey.
// Cost model:
//   total_mins ≈ leg1_stops * 2  +  transfer_wait(10)  +  leg2_stops * 2
// Caps:
//   - Skip X within the first 2 stops from origin (not enough leg 1 gain)
//   - Skip X beyond 60 stops into leg 1 (absurd journeys)
//   - Return top 5 options by total_mins
//
// Returns an array of {
//   s1: { svcNo, dir, transferIdx, stopsLeg1, distLeg1 },
//   s2: { svcNo, dir, destIdx, transferIdx, stopsLeg2, distLeg2 },
//   transferStop: { code, stop },  // stop object with Description, RoadName
//   totalMins: number,
// }
async function findTransferOptions(servicesAtOriginList, originCode, destCode, knownDirectServices) {
  const stopToServices = await getStopToServices();
  const options = [];
  const directSet = new Set(knownDirectServices);
  const TRANSFER_WAIT_MIN = 10;       // assumed wait for the connecting bus
  const MAX_LEG1_STOPS = 60;
  const MIN_LEG1_STOPS = 2;

  // Limit concurrent route fetches; these are cached so the real cost is only
  // on first-ever session, but good hygiene.
  for (const s1 of servicesAtOriginList) {
    if (directSet.has(s1)) continue; // already have it as a direct option

    let s1Routes;
    try { s1Routes = await fetchRouteData(s1); } catch (_) { continue; }
    if (!s1Routes || !s1Routes.length) continue;

    const s1Dirs = [...new Set(s1Routes.map(r => r.Direction))];
    for (const dir of s1Dirs) {
      const s1Sorted = s1Routes.filter(r => r.Direction === dir).sort((a, b) => a.StopSequence - b.StopSequence);
      const s1OriginIdx = s1Sorted.findIndex(r => r.BusStopCode === originCode);
      if (s1OriginIdx === -1) continue;
      // If this direction reaches destination directly, the direct search
      // already found it; skip.
      if (s1Sorted.some(r => r.BusStopCode === destCode)) continue;

      // Walk forward stops as transfer candidates
      const maxIdx = Math.min(s1Sorted.length, s1OriginIdx + 1 + MAX_LEG1_STOPS);
      for (let i = s1OriginIdx + 1 + MIN_LEG1_STOPS; i < maxIdx; i++) {
        const transferCode = s1Sorted[i].BusStopCode;
        const servicesAtTransfer = stopToServices.get(transferCode);
        if (!servicesAtTransfer) continue;

        // For each candidate leg-2 service: need it to reach destCode forward of transferCode
        for (const s2 of servicesAtTransfer) {
          if (s2 === s1) continue; // staying on the same service isn't a transfer
          const s2Routes = await fetchRouteData(s2).catch(() => null);
          if (!s2Routes || !s2Routes.length) continue;
          const s2Dirs = [...new Set(s2Routes.map(r => r.Direction))];
          for (const d2 of s2Dirs) {
            const s2Sorted = s2Routes.filter(r => r.Direction === d2).sort((a, b) => a.StopSequence - b.StopSequence);
            const s2TransferIdx = s2Sorted.findIndex(r => r.BusStopCode === transferCode);
            const s2DestIdx = s2Sorted.findIndex(r => r.BusStopCode === destCode);
            if (s2TransferIdx === -1 || s2DestIdx === -1) continue;
            if (s2DestIdx <= s2TransferIdx) continue;

            const stopsLeg1 = i - s1OriginIdx;
            const stopsLeg2 = s2DestIdx - s2TransferIdx;
            const distLeg1 = Math.max(0, (s1Sorted[i].Distance || 0) - (s1Sorted[s1OriginIdx].Distance || 0));
            const distLeg2 = Math.max(0, (s2Sorted[s2DestIdx].Distance || 0) - (s2Sorted[s2TransferIdx].Distance || 0));
            const totalMins = estimateTravelMins(stopsLeg1, distLeg1.toFixed(1)) +
                              TRANSFER_WAIT_MIN +
                              estimateTravelMins(stopsLeg2, distLeg2.toFixed(1));

            options.push({
              s1: { svcNo: s1, dir, transferIdx: i, stopsLeg1, distLeg1: distLeg1.toFixed(1) },
              s2: { svcNo: s2, dir: d2, transferIdx: s2TransferIdx, destIdx: s2DestIdx, stopsLeg2, distLeg2: distLeg2.toFixed(1) },
              transferCode,
              totalMins,
            });
            break; // best direction found for this s2; don't add a second
          }
        }
      }
    }
  }

  // De-dupe: keep only the best (fastest) option per (s1, s2) pair
  const byPair = new Map();
  for (const opt of options) {
    const key = `${opt.s1.svcNo}|${opt.s2.svcNo}`;
    const existing = byPair.get(key);
    if (!existing || opt.totalMins < existing.totalMins) byPair.set(key, opt);
  }
  const deduped = [...byPair.values()];
  deduped.sort((a, b) => a.totalMins - b.totalMins);
  return deduped.slice(0, 5);
}

function transferCardHtml(opt, stopLookup, etaMap) {
  const t1 = fmt(etaMap[opt.s1.svcNo] && etaMap[opt.s1.svcNo].NextBus && etaMap[opt.s1.svcNo].NextBus.EstimatedArrival);
  const s1Esc = esc(opt.s1.svcNo);
  const s2Esc = esc(opt.s2.svcNo);
  const transferStop = stopLookup(opt.transferCode);
  const transferName = transferStop ? transferStop.Description : opt.transferCode;

  const aria = `Transfer route: Bus ${opt.s1.svcNo}, ${opt.s1.stopsLeg1} stops, transfer at ${transferName}, then bus ${opt.s2.svcNo}, ${opt.s2.stopsLeg2} stops. Total about ${opt.totalMins} minutes.`;

  return `
    <div class="plan-result-card plan-transfer-card" role="listitem" aria-label="${esc(aria)}">
      <div class="plan-transfer-leg">
        <div class="plan-transfer-leg-label">LEG 1</div>
        <div class="plan-svc-badge ${svcColor(opt.s1.svcNo)}">${s1Esc}</div>
        <div class="plan-result-info">
          <div style="font-size:13px;font-weight:600">${opt.s1.stopsLeg1} stop${opt.s1.stopsLeg1 !== 1 ? 's' : ''} · ${opt.s1.distLeg1} km</div>
          <div class="plan-result-stops">to ${esc(transferName)}</div>
        </div>
        ${t1.ok ? `<div class="plan-eta-wrap">
          <div class="plan-eta-time ${t1.cls}" data-eta="${esc(etaMap[opt.s1.svcNo].NextBus.EstimatedArrival)}">${esc(t1.display)}</div>
          <div class="plan-eta-label">Next bus</div>
        </div>` : '<div style="font-size:11px;color:var(--muted);font-family:var(--mono)">No ETA</div>'}
      </div>
      <div class="plan-transfer-at">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>
        </svg>
        TRANSFER AT ${esc(opt.transferCode)} — ${esc(transferName)}
      </div>
      <div class="plan-transfer-leg">
        <div class="plan-transfer-leg-label">LEG 2</div>
        <div class="plan-svc-badge ${svcColor(opt.s2.svcNo)}">${s2Esc}</div>
        <div class="plan-result-info">
          <div style="font-size:13px;font-weight:600">${opt.s2.stopsLeg2} stop${opt.s2.stopsLeg2 !== 1 ? 's' : ''} · ${opt.s2.distLeg2} km</div>
          <div class="plan-result-stops">to destination</div>
        </div>
      </div>
      <div class="plan-transfer-summary">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        ~${opt.totalMins} min total (including ~10 min transfer wait)
      </div>
      <div class="plan-transfer-actions">
        <button class="plan-view-btn" data-route-svc="${s1Esc}" aria-label="View route for ${s1Esc}">🗺 ${s1Esc}</button>
        <button class="plan-view-btn" data-route-svc="${s2Esc}" aria-label="View route for ${s2Esc}">🗺 ${s2Esc}</button>
      </div>
    </div>`;
}

// T7: Render the MRT hint panel. Compact: summary line with total time,
// then step-by-step walk→train→walk description. Ends with a caveat that
// this is an estimate, not a routing answer.
function renderMrtHint(hint) {
  const oSt = hint.originWalk.station;
  const dSt = hint.destWalk.station;

  const stepParts = [];
  stepParts.push(
    `Walk <strong>${hint.originWalk.min}&nbsp;min</strong> to ` +
    oSt.codes.map((c, i) =>
      `<span class="mrt-code mrt-${(oSt.lines[i] || oSt.lines[0] || '').toLowerCase()}">${esc(c)}</span>`
    ).join('') +
    ` ${esc(oSt.name)}`
  );
  for (const leg of hint.trainPath.legs) {
    const lineCls = `mrt-${(leg.line || '').toLowerCase()}`;
    stepParts.push(
      `take <span class="mrt-code ${lineCls}">${esc(leg.line.replace(/L$/, ''))}</span> ` +
      `<strong>${leg.hops}</strong>&nbsp;stop${leg.hops !== 1 ? 's' : ''} to ${esc(leg.toName || leg.toCode)}`
    );
  }
  stepParts.push(
    `walk <strong>${hint.destWalk.min}&nbsp;min</strong> to destination`
  );

  const transferNote = hint.trainPath.transfers > 0
    ? `<div class="mrt-hint-note">Transfer at ${esc(hint.trainPath.transferStationName)}</div>`
    : '';

  return `
    <div class="mrt-hint" role="region" aria-label="MRT suggestion">
      <div class="mrt-hint-head">
        <span class="mrt-hint-icon" aria-hidden="true">🚇</span>
        <span class="mrt-hint-title">Consider MRT</span>
        <span class="mrt-hint-total">~${hint.totalMin} min total</span>
      </div>
      <div class="mrt-hint-steps">${stepParts.join(' → ')}</div>
      ${transferNote}
      <div class="mrt-hint-caveat">Estimate only. For live train timings, check Google Maps.</div>
    </div>`;
}

export function togglePlanPanel() {
  const panel = $id('plan-panel');
  if (panel.style.display === 'none') openPlanPanel();
  else closePlanPanel();
}

function openPlanPanel() {
  if (!state.currentStop) return;
  const panel = $id('plan-panel');
  panel.style.display = 'block';
  $id('planOriginName').textContent = state.currentStop.Description;
  $id('planOriginCode').textContent = state.currentStop.BusStopCode + (state.currentStop.RoadName ? ' · ' + state.currentStop.RoadName : '');
  $id('planDestInput').value = '';
  $id('planSuggestions').innerHTML = '';
  $id('planResults').innerHTML = '';
  $id('planGoBtn').style.display = 'none';
  state.planDestStop = null;
  $id('planBtn').classList.add('active');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => $id('planDestInput').focus(), 300);
}

export function closePlanPanel() {
  $id('plan-panel').style.display = 'none';
  const planBtn = $id('planBtn');
  planBtn.classList.remove('active');
  state.planDestStop = null;
  // A11y: return focus to the trigger
  planBtn.focus();
}

export function handlePlanSearch(val) {
  clearTimeout(state.planSearchTimeout);
  state.planHighlight = -1;
  $id('planGoBtn').style.display = 'none';
  state.planDestStop = null;
  const q = val.trim();
  const input = $id('planDestInput');
  const combo = input.closest('[role="combobox"]');
  if (!q) {
    $id('planSuggestions').innerHTML = '';
    if (combo) combo.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-activedescendant', '');
    return;
  }
  state.planSearchTimeout = setTimeout(() => {
    if (!state.busStopsLoaded) return;
    // T16: findStops now returns { items, totalMatches, truncated }
    const searchResult = findStops(q);
    const results = searchResult.items;
    const el = $id('planSuggestions');
    if (!results.length) {
      el.innerHTML = '';
      if (combo) combo.setAttribute('aria-expanded', 'false');
      return;
    }
    let html = results.map((s, i) => `
      <div class="plan-sug-item" id="plan-sug-${i}" role="option" aria-selected="false"
           data-code="${esc(s.BusStopCode)}">
        <span class="stop-code">${esc(s.BusStopCode)}</span>
        <div>
          <div style="font-size:13px">${esc(s.Description)}</div>
          <div style="font-size:11px;color:var(--muted)">${esc(s.RoadName)}</div>
        </div>
      </div>`).join('');
    if (searchResult.truncated) {
      html += `
        <div class="suggestion-truncated" role="note" aria-live="polite">
          Showing ${results.length} of ${searchResult.totalMatches} matches.
          Type more to refine.
        </div>`;
    }
    el.innerHTML = html;
    el.onclick = (ev) => {
      const item = ev.target.closest('.plan-sug-item');
      if (!item) return;
      const stop = results.find(s => s.BusStopCode === item.dataset.code);
      if (stop) selectPlanDest(stop);
    };
    if (combo) combo.setAttribute('aria-expanded', 'true');
  }, 180);
}

export function handlePlanKey(e) {
  const items = document.querySelectorAll('#planSuggestions .plan-sug-item');
  const input = $id('planDestInput');
  if (!items.length) return;
  const update = () => items.forEach((el, i) => {
    const active = i === state.planHighlight;
    el.style.background = active ? 'var(--surface)' : '';
    el.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) {
      el.scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', el.id);
    }
  });
  if (e.key === 'ArrowDown') { e.preventDefault(); state.planHighlight = Math.min(state.planHighlight + 1, items.length - 1); update(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); state.planHighlight = Math.max(state.planHighlight - 1, 0); update(); }
  else if (e.key === 'Enter' && state.planHighlight >= 0) { items[state.planHighlight].click(); }
  else if (e.key === 'Escape') {
    $id('planSuggestions').innerHTML = '';
    const combo = input.closest('[role="combobox"]');
    if (combo) combo.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-activedescendant', '');
  }
}

function selectPlanDest(stop) {
  state.planDestStop = stop;
  $id('planDestInput').value = `${stop.BusStopCode} — ${stop.Description}`;
  $id('planSuggestions').innerHTML = '';
  $id('planGoBtn').style.display = 'block';
  $id('planDestInput').blur();
  runPlanSearch();
}

export async function runPlanSearch() {
  if (!state.planDestStop || !state.currentStop) return;
  if (state.planDestStop.BusStopCode === state.currentStop.BusStopCode) {
    $id('planResults').innerHTML = '<div class="plan-no-result">Origin and destination are the same stop.</div>';
    return;
  }

  const resultsEl = $id('planResults');
  resultsEl.innerHTML = `<div class="plan-loading"><div class="loader"></div> Finding routes…</div>`;

  try {
    const originArrR = await api.getBusArrival(state.currentStop.BusStopCode);
    if (!originArrR.ok) throw originArrR.error;
    const servicesAtOrigin = (originArrR.data.Services || []).map(s => s.ServiceNo);

    if (!servicesAtOrigin.length) {
      resultsEl.innerHTML = '<div class="plan-no-result">No buses currently operating at this stop.</div>';
      return;
    }

    resultsEl.innerHTML = `<div class="plan-loading"><div class="loader"></div> Checking ${servicesAtOrigin.length} services…</div>`;

    const directOptions = [];
    const CONCURRENCY = 5;

    for (let i = 0; i < servicesAtOrigin.length; i += CONCURRENCY) {
      const chunk = servicesAtOrigin.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (svcNo) => {
        try {
          const routes = await fetchRouteData(svcNo);
          const dirs = [...new Set(routes.map(r => r.Direction))];
          for (const dir of dirs) {
            const sorted = routes.filter(r => r.Direction === dir).sort((a, b) => a.StopSequence - b.StopSequence);
            const originIdx = sorted.findIndex(r => r.BusStopCode === state.currentStop.BusStopCode);
            const destIdx   = sorted.findIndex(r => r.BusStopCode === state.planDestStop.BusStopCode);
            if (originIdx !== -1 && destIdx !== -1 && destIdx > originIdx) {
              const stopsBetween = destIdx - originIdx;
              const distKm = (sorted[destIdx].Distance - sorted[originIdx].Distance).toFixed(1);
              directOptions.push({ svcNo, dir, originIdx, destIdx, stopsBetween, distKm, sorted });
            }
          }
        } catch (_) {}
      }));
    }

    // Fresh ETAs
    const etaMap = {};
    try {
      const aR = await api.getBusArrival(state.currentStop.BusStopCode);
      if (aR.ok) (aR.data.Services || []).forEach(s => { etaMap[s.ServiceNo] = s; });
    } catch (_) {}

    const destBlockHead = `
      <div class="plan-dest-header">
        <div class="plan-leg-label">TO</div>
        <div class="plan-leg-stop">${esc(state.planDestStop.Description)}</div>
        <div class="plan-leg-code">${esc(state.planDestStop.BusStopCode)}${state.planDestStop.RoadName ? ' · ' + esc(state.planDestStop.RoadName) : ''}</div>
      </div>`;

    // T7: MRT hint — show if both ends are near stations and we can route a train path.
    // Computed once, injected into every result branch below.
    let mrtHintHtml = '';
    try {
      const stations = await loadStations();
      const hint = mrtHintForJourney(state.currentStop, state.planDestStop, stations);
      if (hint) mrtHintHtml = renderMrtHint(hint);
    } catch (err) {
      console.warn('[planner] mrt hint failed:', err);
    }
    const destBlockWithHint = destBlockHead + mrtHintHtml;

    if (!directOptions.length) {
      // T4.1: No direct bus — search for 1-transfer options before giving up.
      resultsEl.innerHTML = destBlockWithHint +
        `<div class="plan-loading"><div class="loader"></div> No direct bus — checking transfers…</div>`;

      let transferOpts = [];
      try {
        transferOpts = await findTransferOptions(
          servicesAtOrigin,
          state.currentStop.BusStopCode,
          state.planDestStop.BusStopCode,
          [] // no direct services to exclude — they would have matched above
        );
      } catch (err) {
        console.warn('[planner] transfer search failed:', err);
      }

      if (!transferOpts.length) {
        resultsEl.innerHTML = destBlockWithHint + `
          <div class="plan-no-result">
            No direct bus or 1-transfer route found between these stops.<br>
            <small style="color:var(--muted)">The destination may require multiple transfers or a different origin stop.</small>
          </div>`;
        return;
      }

      // Build stop lookup for transfer-point display names
      const stopMap = new Map();
      for (const s of state.busStops) stopMap.set(s.BusStopCode, s);
      const stopLookup = (code) => stopMap.get(code);

      let htmlStr = destBlockWithHint +
        `<div class="plan-transfer-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>
          </svg>
          1-TRANSFER ROUTES · showing ${transferOpts.length} best option${transferOpts.length !== 1 ? 's' : ''}
        </div>`;
      for (const opt of transferOpts) {
        htmlStr += transferCardHtml(opt, stopLookup, etaMap);
      }

      resultsEl.innerHTML = htmlStr;
      resultsEl.setAttribute('role', 'list');
      resultsEl.onclick = (ev) => {
        const el = ev.target.closest('[data-route-svc]');
        if (!el) return;
        showRoute(el.dataset.routeSvc, ev);
      };
      resultsEl.onkeydown = (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const el = ev.target.closest('[data-route-svc]');
        if (!el) return;
        ev.preventDefault();
        showRoute(el.dataset.routeSvc, ev);
      };
      return;
    }

    directOptions.sort((a, b) => {
      const etaA = etaMap[a.svcNo] && etaMap[a.svcNo].NextBus && etaMap[a.svcNo].NextBus.EstimatedArrival;
      const etaB = etaMap[b.svcNo] && etaMap[b.svcNo].NextBus && etaMap[b.svcNo].NextBus.EstimatedArrival;
      const tA = etaA ? new Date(etaA) : new Date(9999, 0);
      const tB = etaB ? new Date(etaB) : new Date(9999, 0);
      return tA - tB;
    });

    let htmlStr = destBlockWithHint;

    directOptions.forEach(opt => {
      const svc = etaMap[opt.svcNo];
      const t1 = fmt(svc && svc.NextBus && svc.NextBus.EstimatedArrival);
      const t2 = fmt(svc && svc.NextBus2 && svc.NextBus2.EstimatedArrival);
      const t3 = fmt(svc && svc.NextBus3 && svc.NextBus3.EstimatedArrival);
      const hasEta = t1.ok || t2.ok || t3.ok;
      const svcEsc = esc(opt.svcNo);
      const ariaLbl = `Bus ${opt.svcNo}, ${opt.stopsBetween} stops, ${opt.distKm} kilometres, ${t1.ok ? 'arriving ' + t1.display : 'no ETA'}`;

      htmlStr += `
        <div class="plan-result-card" role="listitem" aria-label="${esc(ariaLbl)}">
          <div class="plan-result-top" data-route-svc="${svcEsc}" role="button" tabindex="0" aria-label="View route for ${svcEsc}">
            <div class="plan-svc-badge ${svcColor(opt.svcNo)}">${svcEsc}</div>
            <div class="plan-result-info">
              <div style="font-size:13px;font-weight:600">${opt.stopsBetween} stop${opt.stopsBetween !== 1 ? 's' : ''} · ${opt.distKm} km</div>
              <div class="plan-result-stops">Dir ${opt.dir} · Stop #${opt.sorted[opt.originIdx].StopSequence} → #${opt.sorted[opt.destIdx].StopSequence}</div>
              <div class="plan-travel-time">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                ~${estimateTravelMins(opt.stopsBetween, opt.distKm)} min ride
              </div>
            </div>
            ${t1.ok ? `<div class="plan-eta-wrap">
              <div class="plan-eta-time ${t1.cls}" data-eta="${esc(svc && svc.NextBus && svc.NextBus.EstimatedArrival || '')}">${esc(t1.display)}</div>
              <div class="plan-eta-label">Next bus</div>
            </div>` : '<div style="font-size:11px;color:var(--muted);font-family:var(--mono)">No ETA</div>'}
          </div>
          ${hasEta ? `<div class="plan-eta-row">
            ${t1.ok ? `<div class="plan-eta-pill"><span class="plan-eta-pill-time ${t1.cls}" data-eta="${esc(svc && svc.NextBus && svc.NextBus.EstimatedArrival || '')}">${esc(t1.display)}</span><span class="plan-eta-pill-label">Now</span></div>` : ''}
            ${t2.ok ? `<div class="plan-eta-pill"><span class="plan-eta-pill-time ${t2.cls}" data-eta="${esc(svc && svc.NextBus2 && svc.NextBus2.EstimatedArrival || '')}">${esc(t2.display)}</span><span class="plan-eta-pill-label">Next</span></div>` : ''}
            ${t3.ok ? `<div class="plan-eta-pill"><span class="plan-eta-pill-time ${t3.cls}" data-eta="${esc(svc && svc.NextBus3 && svc.NextBus3.EstimatedArrival || '')}">${esc(t3.display)}</span><span class="plan-eta-pill-label">After</span></div>` : ''}
            <button class="plan-view-btn" data-route-svc="${svcEsc}" aria-label="View route for ${svcEsc} on map">🗺 View on map</button>
          </div>` : ''}
        </div>`;
    });

    // T8: placeholder for alternative transfer options. Filled in by an
    // async search that runs after the direct options are visible, so the
    // user doesn't have to wait for the transfer scan before seeing any
    // result. If the search finds nothing competitive, the placeholder is
    // simply removed.
    htmlStr += `<div id="plan-alt-section" class="plan-alt-loading" aria-live="polite">
      <div class="loader loader-small" aria-hidden="true"></div>
      <span>Checking for faster transfer options…</span>
    </div>`;

    resultsEl.innerHTML = htmlStr;
    resultsEl.setAttribute('role', 'list');
    resultsEl.onclick = (ev) => {
      const el = ev.target.closest('[data-route-svc]');
      if (!el) return;
      showRoute(el.dataset.routeSvc, ev);
    };
    resultsEl.onkeydown = (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const el = ev.target.closest('[data-route-svc]');
      if (!el) return;
      ev.preventDefault();
      showRoute(el.dataset.routeSvc, ev);
    };

    // T8: now that direct options are visible, search for competitive
    // transfer alternatives in the background. Capture identifiers so we
    // can abort rendering if the user has navigated away by then.
    const searchOrigin = state.currentStop.BusStopCode;
    const searchDest = state.planDestStop.BusStopCode;
    const directSvcList = directOptions.map(o => o.svcNo);
    const fastestDirectMins = directOptions.reduce((min, o) => {
      const m = estimateTravelMins(o.stopsBetween, o.distKm);
      return Math.min(min, m);
    }, Infinity);

    (async () => {
      let altTransferOpts = [];
      try {
        altTransferOpts = await findTransferOptions(
          servicesAtOrigin, searchOrigin, searchDest, directSvcList
        );
      } catch (err) {
        console.warn('[planner] alt transfer search failed:', err);
      }

      // If user has navigated away or re-planned, abandon the render.
      const section = $id('plan-alt-section');
      if (!section) return;
      if (state.currentStop.BusStopCode !== searchOrigin ||
          state.planDestStop?.BusStopCode !== searchDest) return;

      // Filter to competitive options (within +8 min of fastest direct, max 3)
      const competitiveTransfers = altTransferOpts
        .filter(o => o.totalMins <= fastestDirectMins + 8)
        .slice(0, 3);

      if (!competitiveTransfers.length) {
        section.remove(); // no worthwhile alternatives; quietly disappear
        return;
      }

      const stopMap = new Map();
      for (const s of state.busStops) stopMap.set(s.BusStopCode, s);
      const stopLookup = (code) => stopMap.get(code);

      let altHtml = `<div class="plan-alt-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>
        </svg>
        ALSO CONSIDER · ${competitiveTransfers.length} transfer option${competitiveTransfers.length !== 1 ? 's' : ''}
      </div>`;
      for (const opt of competitiveTransfers) {
        altHtml += transferCardHtml(opt, stopLookup, etaMap);
      }
      section.outerHTML = altHtml;
    })();

  } catch (err) {
    resultsEl.innerHTML = `<div class="plan-no-result">Error: ${esc(err.message || String(err))}</div>`;
  }
}
