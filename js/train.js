// ── T6: Train alerts + station crowding ──────────────
// Handles two LTA endpoints:
//   /TrainServiceAlerts — global service disruptions, polled every 2 min
//   /PCDRealTime        — per-line station crowding, fetched lazily per line
//
// Design notes:
// - Alerts polling is global (one call covers the entire rail network)
// - Crowding is per-line; cached for 10 min since LTA updates that often
// - Our stations.json uses line codes SKL/PGL; LTA uses SLRT/PLRT.
//   mapStationsLineToLtaLine() translates.

import * as api from './api.js';
import { $id, esc } from './dom.js';
import { log } from './log.js';

// ── Dev: crowding override for testing ───────────────
// Append ?crowdtest=l|m|h to force every station's crowd level to a fixed
// value regardless of what LTA returns. Useful for verifying the visual
// rendering path at low/moderate/high when real data doesn't cooperate.
// Also shows a small pink "CROWD TEST" badge at the bottom of the viewport
// so you can't forget it's on.
const crowdOverride = (() => {
  try {
    const p = new URLSearchParams(location.search).get('crowdtest');
    if (!p) return null;
    const v = p.toLowerCase();
    if (['l','m','h','na'].includes(v)) {
      // Render a persistent visual indicator so this can't be forgotten
      const badge = document.createElement('div');
      badge.textContent = `CROWD TEST: ${v}`;
      badge.style.cssText =
        'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);' +
        'background:#d946ef;color:#fff;padding:4px 10px;border-radius:10px;' +
        'font:600 10px/1 var(--mono,monospace);z-index:9999;' +
        'box-shadow:0 2px 8px rgba(0,0,0,0.4);letter-spacing:0.5px;' +
        'pointer-events:auto;cursor:pointer';
      badge.title = 'Tap to clear override and reload';
      badge.onclick = () => {
        const u = new URL(location.href);
        u.searchParams.delete('crowdtest');
        location.href = u.toString();
      };
      // Attach once DOM is ready
      if (document.body) document.body.appendChild(badge);
      else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(badge));
      log.warn('train', `crowd override active: ${v}`);
      return v;
    }
  } catch (_) {}
  return null;
})();

// ── Line code mapping ────────────────────────────────
// Our stations.json uses {NSL, EWL, NEL, CCL, DTL, TEL, BPL, SKL, PGL}
// LTA /PCDRealTime expects   {NSL, EWL, NEL, CCL, DTL, TEL, BPL, SLRT, PLRT,
//                             plus CEL, CGL for Circle/Changi extensions}
const STATIONS_TO_LTA = {
  NSL: 'NSL', EWL: 'EWL', NEL: 'NEL', CCL: 'CCL', DTL: 'DTL', TEL: 'TEL',
  BPL: 'BPL', SKL: 'SLRT', PGL: 'PLRT',
};

// All lines we'll query for crowding. LTA treats CEL (Circle Line Extension
// / Marina Bay Branch) and CGL (Changi Airport) separately, so we include
// them even though our station data groups them under CCL and EWL.
const ALL_LINES = ['NSL','EWL','NEL','CCL','DTL','TEL','BPL','SLRT','PLRT','CEL','CGL'];

// ── Train service alerts ─────────────────────────────
let alertsState = {
  status: null,           // 1 = normal, 2 = disruption (per LTA docs)
  affectedSegments: [],
  messages: [],
  lastFetched: 0,
  dismissed: false,       // user dismissed this specific alert session
};
const ALERTS_POLL_MS = 2 * 60 * 1000; // 2 min
let alertsTimer = null;

export async function fetchTrainAlerts() {
  const r = await api.getTrainServiceAlerts();
  if (!r.ok) {
    log.warn('train', 'alerts fetch failed', r.error);
    return null;
  }
  // LTA v6.7 response shape: { value: { Status, AffectedSegments[], Message[] } }
  // But older/legacy callers return { value: [{ ... }] }. Normalise both.
  const payload = r.data.value;
  const v = Array.isArray(payload) ? payload[0] : payload;
  if (!v) return { status: 1, affectedSegments: [], messages: [] };
  alertsState.status = v.Status;
  alertsState.affectedSegments = v.AffectedSegments || [];
  alertsState.messages = v.Message || [];
  alertsState.lastFetched = Date.now();
  return alertsState;
}

export function startAlertsPolling() {
  if (alertsTimer) return;
  const tick = async () => {
    try {
      await fetchTrainAlerts();
      renderAlertsBanner();
    } catch (err) {
      log.warn('train', 'poll error', err);
    }
  };
  tick(); // immediate first fetch
  alertsTimer = setInterval(tick, ALERTS_POLL_MS);
  // Respect visibility — pause when tab hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(alertsTimer); alertsTimer = null;
    } else if (!alertsTimer) {
      tick();
      alertsTimer = setInterval(tick, ALERTS_POLL_MS);
    }
  });
}

function renderAlertsBanner() {
  const banner = $id('train-alerts-banner');
  if (!banner) return;
  const active = alertsState.status === 2 &&
                 (alertsState.affectedSegments.length > 0 || alertsState.messages.length > 0);
  if (!active || alertsState.dismissed) {
    banner.classList.remove('visible');
    return;
  }

  // Summarise: list affected lines + one-line status, details behind expand
  const lines = [...new Set(alertsState.affectedSegments.map(s => s.Line).filter(Boolean))];
  const linesText = lines.length
    ? lines.map(l => `<span class="alert-line-chip mrt-${l.toLowerCase()}">${esc(l)}</span>`).join('')
    : '<span class="alert-line-chip">Network</span>';

  const segsHtml = alertsState.affectedSegments.map(seg => {
    const parts = [];
    if (seg.Line) parts.push(`<strong>${esc(seg.Line)}</strong>`);
    if (seg.Direction) parts.push(esc(seg.Direction));
    const header = parts.join(' · ');
    const stations = seg.Stations ? esc(seg.Stations) : '';
    const freePublicBus = seg.FreePublicBus ? `<div class="alert-seg-sub">Free regular bus: ${esc(seg.FreePublicBus)}</div>` : '';
    const freeMrtShuttle = seg.FreeMrtShuttle ? `<div class="alert-seg-sub">Free MRT shuttle: ${esc(seg.FreeMrtShuttle)}</div>` : '';
    const shuttleDir = seg.MrtShuttleDirection ? `<div class="alert-seg-sub">Shuttle direction: ${esc(seg.MrtShuttleDirection)}</div>` : '';
    return `<div class="alert-seg">
      <div class="alert-seg-head">${header}</div>
      ${stations ? `<div class="alert-seg-stations">${stations}</div>` : ''}
      ${freePublicBus}${freeMrtShuttle}${shuttleDir}
    </div>`;
  }).join('');

  const msgsHtml = alertsState.messages.map(m =>
    `<div class="alert-msg">${esc(m.Content || '')}${m.CreatedDate ? `<span class="alert-msg-time"> · ${esc(m.CreatedDate)}</span>` : ''}</div>`
  ).join('');

  banner.innerHTML = `
    <div class="alert-head" role="button" tabindex="0" aria-expanded="false" aria-controls="alert-detail">
      <div class="alert-head-left">
        <span class="alert-icon" aria-hidden="true">⚠</span>
        <span class="alert-title">Train service disruption</span>
        <span class="alert-lines">${linesText}</span>
      </div>
      <button class="alert-dismiss" aria-label="Dismiss train alert">✕</button>
      <span class="alert-chevron" aria-hidden="true">▾</span>
    </div>
    <div class="alert-detail" id="alert-detail">
      ${segsHtml}
      ${msgsHtml}
      <div class="alert-footer">Last checked ${new Date(alertsState.lastFetched).toLocaleTimeString('en-SG')}</div>
    </div>`;
  banner.classList.add('visible');

  banner.querySelector('.alert-head').onclick = (e) => {
    if (e.target.closest('.alert-dismiss')) return;
    const d = banner.querySelector('.alert-detail');
    const h = banner.querySelector('.alert-head');
    const open = d.classList.toggle('open');
    h.setAttribute('aria-expanded', open ? 'true' : 'false');
    banner.querySelector('.alert-chevron').classList.toggle('open', open);
  };
  banner.querySelector('.alert-head').onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      banner.querySelector('.alert-head').click();
    }
  };
  banner.querySelector('.alert-dismiss').onclick = (e) => {
    e.stopPropagation();
    alertsState.dismissed = true;
    banner.classList.remove('visible');
  };
}

// ── Station crowding ─────────────────────────────────
// Cache per line with 10-min TTL. Stations.Value array contains per-station
// entries: { Station, StartTime, EndTime, CrowdLevel } where CrowdLevel is
// "l" / "m" / "h" (or "na" when data unavailable).
const CROWDING_TTL_MS = 10 * 60 * 1000;
const crowdingCache = new Map(); // station -> { level, fetchedAt }
const crowdingInflight = new Map(); // ltaLine -> Promise
const crowdingFetchedLines = new Set(); // lines we've successfully loaded at least once

async function fetchCrowdingForLine(ltaLine) {
  if (crowdingInflight.has(ltaLine)) return crowdingInflight.get(ltaLine);
  const p = (async () => {
    const r = await api.getStationCrowding(ltaLine);
    if (!r.ok) {
      log.warn('crowding', `failed for ${ltaLine}`, r.error);
      return;
    }
    const entries = r.data.value || [];
    const now = Date.now();
    for (const e of entries) {
      // LTA returns station codes; they already match our codes (NS24 etc)
      if (!e.Station) continue;
      crowdingCache.set(e.Station, {
        level: (e.CrowdLevel || 'na').toLowerCase(),
        fetchedAt: now,
      });
    }
    crowdingFetchedLines.add(ltaLine);
  })();
  crowdingInflight.set(ltaLine, p);
  try { await p; } finally { crowdingInflight.delete(ltaLine); }
  return p;
}

// Ensure we have fresh crowding data for whatever lines are present in the
// given station rows. Caller passes array of stations (shape from stationsNear).
// Returns immediately if all relevant lines are fresh.
export async function ensureCrowdingFor(stationRows) {
  const neededLines = new Set();
  const now = Date.now();
  for (const st of stationRows) {
    for (const line of st.lines) {
      const ltaLine = STATIONS_TO_LTA[line] || line;
      // If we have a sample entry that's fresh, skip
      if (crowdingFetchedLines.has(ltaLine)) {
        // check one cached entry's age as proxy for line freshness
        let stale = true;
        for (const code of st.codes) {
          const c = crowdingCache.get(code);
          if (c && now - c.fetchedAt < CROWDING_TTL_MS) { stale = false; break; }
        }
        if (!stale) continue;
      }
      neededLines.add(ltaLine);
    }
  }
  if (!neededLines.size) return;
  await Promise.allSettled([...neededLines].map(fetchCrowdingForLine));
}

// Lookup a crowd level for a specific station code. Returns null if unknown.
// Returns 'l' | 'm' | 'h' | 'na' otherwise.
// Honours the ?crowdtest= URL override for visual testing.
export function crowdLevel(stationCode) {
  if (crowdOverride) return crowdOverride;
  const e = crowdingCache.get(stationCode);
  if (!e) return null;
  if (Date.now() - e.fetchedAt > CROWDING_TTL_MS * 2) return null; // hard expiry
  return e.level;
}

// UI helper: aria label for a crowding dot
export function crowdAriaLabel(level) {
  if (!level || level === 'na') return 'crowding unknown';
  if (level === 'l') return 'low crowding';
  if (level === 'm') return 'moderate crowding';
  if (level === 'h') return 'high crowding';
  return 'crowding ' + level;
}
