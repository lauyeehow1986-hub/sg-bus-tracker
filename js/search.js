// ── Search (main top bar) ────────────────────────────
import { state } from './state.js';
import { findStops, stopByCode } from './stops.js';
import { $id, html, esc } from './dom.js';

let onSelect = () => {};
export function initSearch(selectHandler) { onSelect = selectHandler; }

export function handleSearch(val) {
  clearTimeout(state.searchTimeout);
  state.highlightIndex = -1;
  const q = val.trim();
  if (!q) { hideSuggestions(); return; }
  state.searchTimeout = setTimeout(() => doSearch(q), 180);
}

function doSearch(q) {
  if (!state.busStopsLoaded) return;
  showSuggestions(findStops(q), q);
}

export function handleKey(e) {
  const items = document.querySelectorAll('#suggestions .suggestion-item');
  const input = $id('searchInput');
  if (!items.length) {
    if (e.key === 'Enter') {
      const q = e.target.value.trim();
      if (/^\d{5}$/.test(q)) selectStopByCode(q);
    }
    return;
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); state.highlightIndex = Math.min(state.highlightIndex + 1, items.length - 1); updateHighlight(items, input); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); state.highlightIndex = Math.max(state.highlightIndex - 1, 0); updateHighlight(items, input); }
  else if (e.key === 'Enter') { e.preventDefault(); if (state.highlightIndex >= 0) items[state.highlightIndex].click(); }
  else if (e.key === 'Escape') { hideSuggestions(); input.setAttribute('aria-activedescendant', ''); }
}

function updateHighlight(items, input) {
  items.forEach((el, i) => {
    const active = i === state.highlightIndex;
    el.style.background = active ? 'var(--surface2)' : '';
    el.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) {
      el.scrollIntoView({ block: 'nearest' });
      if (input) input.setAttribute('aria-activedescendant', el.id);
    }
  });
}

function highlightMatch(text, q) {
  if (/^\d+$/.test(q)) return esc(text);
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  // Build the string with escaping; the <mark> tags are trusted (static HTML).
  return esc(text).replace(re, '<mark style="background:rgba(0,212,170,0.25);color:var(--accent);border-radius:2px">$1</mark>');
}

function showSuggestions(searchResult, q) {
  const el = $id('suggestions');
  const input = $id('searchInput');
  const combo = input.closest('[role="combobox"]');
  // T16: searchResult is { items, totalMatches, truncated }
  const results = searchResult.items;
  if (!results.length) {
    el.style.display = 'none';
    if (combo) combo.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-activedescendant', '');
    return;
  }
  // We build HTML manually here with escaping. The match highlight is the one
  // place we deliberately emit a known-safe <mark> tag around user-escaped text.
  let htmlStr = results.map((s, i) => `
    <div class="suggestion-item" id="sug-${i}" role="option" aria-selected="false"
         data-code="${esc(s.BusStopCode)}">
      <span class="stop-code">${esc(s.BusStopCode)}</span>
      <div>
        <div class="stop-name-sug">${highlightMatch(s.Description, q)}</div>
        <div class="stop-road">${esc(s.RoadName)}</div>
      </div>
    </div>`).join('');
  // T16: tell the user when results are truncated so they can refine
  if (searchResult.truncated) {
    htmlStr += `
      <div class="suggestion-truncated" role="note" aria-live="polite">
        Showing ${results.length} of ${searchResult.totalMatches} matches.
        Type more to refine.
      </div>`;
  }
  el.innerHTML = htmlStr;
  // Event delegation: one listener, no inline onclick
  el.onclick = (e) => {
    const item = e.target.closest('.suggestion-item');
    if (!item) return;
    const code = item.getAttribute('data-code');
    const stop = stopByCode(code);
    if (stop) selectStop(stop);
  };
  el.style.display = 'block';
  if (combo) combo.setAttribute('aria-expanded', 'true');
}

export function hideSuggestions() {
  const el = $id('suggestions');
  el.style.display = 'none';
  const input = $id('searchInput');
  if (input) {
    const combo = input.closest('[role="combobox"]');
    if (combo) combo.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-activedescendant', '');
  }
}

export function selectStop(stop) {
  $id('searchInput').value = '';
  hideSuggestions();
  onSelect(stop);
}

export function selectStopByCode(code) {
  const stop = stopByCode(code);
  if (stop) selectStop(stop);
}
