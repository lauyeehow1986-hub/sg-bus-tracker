// ── Favourites: chips, custom labels, long-press rename ──
import { state } from './state.js';
import { $id, esc } from './dom.js';
import { showToast } from './toast.js';
import { haptic, maybeShowInstallBanner } from './pwa.js';

let onSelect = () => {};
export function initFavs(selectHandler) { onSelect = selectHandler; }

export function toggleFavourite() {
  if (!state.currentStop) return;
  const idx = state.favourites.findIndex(f => f.BusStopCode === state.currentStop.BusStopCode);
  if (idx >= 0) { state.favourites.splice(idx, 1); showToast('Removed from favourites'); }
  else {
    // Store minimal shape — not the full raw stop record
    state.favourites.push({
      BusStopCode: state.currentStop.BusStopCode,
      Description: state.currentStop.Description,
      RoadName: state.currentStop.RoadName,
    });
    showToast('Added to favourites ★', 'success');
  }
  localStorage.setItem('sg_bus_favs', JSON.stringify(state.favourites));
  updateFavBtn();
  renderFavourites();
  haptic(12);
  // T3.5: user just got value — maybe now's a good time to pitch install
  setTimeout(maybeShowInstallBanner, 2500);
}

export function updateFavBtn() {
  if (!state.currentStop) return;
  const isFav = state.favourites.some(f => f.BusStopCode === state.currentStop.BusStopCode);
  const btn = $id('favBtn');
  btn.textContent = isFav ? '★' : '☆';
  btn.classList.toggle('active', isFav);
  btn.setAttribute('aria-pressed', isFav ? 'true' : 'false');
  btn.setAttribute('aria-label', isFav ? 'Remove from favourites' : 'Add to favourites');
}

export function renderFavourites() {
  const section = $id('favSection');
  if (!state.favourites.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  // T2.2: all user-controlled text (labels) goes through esc(). No raw innerHTML
  // interpolation of state.favLabels anywhere.
  $id('favChips').innerHTML = state.favourites.map(f => {
    const labelText = state.favLabels[f.BusStopCode] || (f.Description || '').substring(0, 12);
    return `
    <div class="fav-chip" style="position:relative" data-code="${esc(f.BusStopCode)}">
      <span class="fav-chip-label" title="${esc(f.Description)}">${esc(f.BusStopCode)}</span>
      <small style="color:var(--muted);font-size:10px;max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(labelText)}</small>
      <span class="fav-chip-x" style="color:var(--muted);font-size:14px;line-height:1;flex-shrink:0" role="button" aria-label="Remove ${esc(f.BusStopCode)}" tabindex="0">×</span>
      <div class="fav-chip-rename" id="rename-${esc(f.BusStopCode)}">
        <label class="sr-only" for="rename-input-${esc(f.BusStopCode)}">Custom name for ${esc(f.BusStopCode)}</label>
        <input type="text" id="rename-input-${esc(f.BusStopCode)}" placeholder="Custom name…"
               value="${esc(state.favLabels[f.BusStopCode] || '')}" maxlength="20">
        <div class="fav-chip-rename-btns">
          <button class="save-btn" type="button" data-action="save">Save</button>
          <button class="cancel-btn" type="button" data-action="cancel">Cancel</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // One delegated listener for the whole chip area — no inline handlers
  const chips = $id('favChips');
  chips.onclick = (e) => {
    // Don't bubble through the rename panel
    if (e.target.closest('.fav-chip-rename')) {
      const action = e.target.dataset.action;
      if (action === 'save' || action === 'cancel') {
        const chip = e.target.closest('.fav-chip');
        if (action === 'save') {
          const input = chip.querySelector('input');
          saveFavLabel(chip.dataset.code, input.value);
        }
        closeAllRename();
      }
      return;
    }
    if (e.target.classList.contains('fav-chip-x')) {
      e.stopPropagation();
      removeFav(e.target.closest('.fav-chip').dataset.code);
      return;
    }
    const chip = e.target.closest('.fav-chip');
    if (!chip) return;
    const fav = state.favourites.find(f => f.BusStopCode === chip.dataset.code);
    if (fav) onSelect(fav);
  };

  chips.onkeydown = (e) => {
    if (e.target.classList.contains('fav-chip-x') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      removeFav(e.target.closest('.fav-chip').dataset.code);
      return;
    }
    const input = e.target.closest('.fav-chip-rename input');
    if (input) {
      if (e.key === 'Enter') {
        const chip = input.closest('.fav-chip');
        saveFavLabel(chip.dataset.code, input.value);
        closeAllRename();
      } else if (e.key === 'Escape') {
        closeAllRename();
      }
    }
  };

  // Long-press to rename (touch) — delegated
  let holdTimer = null;
  let holdCode = null;
  chips.ontouchstart = (e) => {
    const chip = e.target.closest('.fav-chip');
    if (!chip) return;
    if (e.target.closest('.fav-chip-rename')) return; // inside rename panel
    holdCode = chip.dataset.code;
    holdTimer = setTimeout(() => {
      if (holdCode) openRename(holdCode);
    }, 600);
  };
  const clearHold = () => { clearTimeout(holdTimer); holdTimer = null; holdCode = null; };
  chips.ontouchend = clearHold;
  chips.ontouchmove = clearHold;
  chips.ontouchcancel = clearHold;
}

function saveFavLabel(code, label) {
  if (label.trim()) state.favLabels[code] = label.trim();
  else delete state.favLabels[code];
  localStorage.setItem('sg_bus_fav_labels', JSON.stringify(state.favLabels));
  renderFavourites();
}

export function openRename(code) {
  document.querySelectorAll('.fav-chip-rename.open').forEach(el => el.classList.remove('open'));
  const panel = $id('rename-' + code);
  if (panel) {
    panel.classList.add('open');
    const inp = panel.querySelector('input');
    if (inp) inp.focus();
    state.openRenameChip = code;
  }
}

export function closeAllRename() {
  document.querySelectorAll('.fav-chip-rename.open').forEach(el => el.classList.remove('open'));
  state.openRenameChip = null;
}

function removeFav(code) {
  state.favourites = state.favourites.filter(f => f.BusStopCode !== code);
  localStorage.setItem('sg_bus_favs', JSON.stringify(state.favourites));
  if (state.currentStop && state.currentStop.BusStopCode === code) updateFavBtn();
  renderFavourites();
}
