// ── PWA: SW + install + offline + pull-to-refresh + haptic ──
import { state } from './state.js';
import { $id } from './dom.js';
import { showToast } from './toast.js';

let swRegistration = null;
let deferredInstallPrompt = null;

// Refresher callback wired by app.js so pwa.js doesn't depend on arrivals.js
let refreshCurrentStop = () => {};
export function initPwa(refreshFn) { refreshCurrentStop = refreshFn; }

// ── Haptic helper ─────────────────────────────────────
// Respects prefers-reduced-motion; silently no-ops where vibrate isn't supported.
export function haptic(ms) {
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch (_) {}
}

// ── SW registration ───────────────────────────────────
export function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  // Belt-and-braces: proactively evict known-stale caches on every boot.
  // This protects against the common PWA footgun where an old SW keeps serving
  // stale code until the user hard-reloads twice.
  if (window.caches) {
    caches.keys().then(keys => {
      for (const k of keys) {
        if (k === 'sg-bus-v10-11' || k === 'sg-bus-v10-10' || k === 'sg-bus-v10-9' || k === 'sg-bus-v10-8' || k === 'sg-bus-v10-7' || k === 'sg-bus-v10-6' || k === 'sg-bus-v10-5' || k === 'sg-bus-v10-4' || k === 'sg-bus-v10-3' || k === 'sg-bus-v10-2' || k === 'sg-bus-v10-1' || k === 'sg-bus-v10' || k === 'sg-bus-v9' || k === 'sg-bus-v8-2' || k === 'sg-bus-v8' || k === 'sg-bus-v7' || k === 'sg-bus-v6' || k === 'sg-bus-v5' || k === 'sg-bus-v4' || k === 'sg-bus-v3' || k === 'sg-bus-v2' || k === 'sg-bus-v1') {
          console.log('[PWA] Evicting stale cache:', k);
          caches.delete(k);
        }
      }
    });
  }

  window.addEventListener('load', async () => {
    try {
      swRegistration = await navigator.serviceWorker.register('sw.js', { scope: '/' });
      console.log('[PWA] SW registered, scope:', swRegistration.scope);

      swRegistration.addEventListener('updatefound', () => {
        const newWorker = swRegistration.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('Update available — refresh to apply', 'success');
          }
        });
      });

      // Auto-reload the page once when a new SW takes control, so we never
      // end up in a state where the user is running a hybrid of old+new code.
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        console.log('[PWA] New SW took control — reloading');
        window.location.reload();
      });

      updateCacheStats();
    } catch (err) {
      console.warn('[PWA] SW registration failed:', err);
    }
  });
}

// ── Install prompt ────────────────────────────────────
// T3.5: The banner is annoying if shown too early. Gate on engagement:
//   - User has a saved API key (i.e. proxy is set up)
//   - User has favourited at least one stop (i.e. they got value)
// Dismissals persist per-device for 14 days, then may re-show.

const DISMISS_KEY = 'pwa_install_dismissed_at';
const DISMISS_DAYS = 14;

function isDismissedRecently() {
  const ts = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
  if (!ts) return false;
  const days = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  return days < DISMISS_DAYS;
}

function hasEngagement() {
  const hasKey = $id('apiToggleBtn').classList.contains('set');
  let favCount = 0;
  try { favCount = JSON.parse(localStorage.getItem('sg_bus_favs') || '[]').length; } catch (_) {}
  return hasKey && favCount >= 1;
}

function isIOS() {
  return /iP(hone|ad|od)/i.test(navigator.userAgent) && !window.MSStream;
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}

// Re-check engagement at points where it might just have become true
export function maybeShowInstallBanner() {
  if (isStandalone()) return;
  if (isDismissedRecently()) return;
  if (!hasEngagement()) return;
  const banner = $id('install-banner');

  // iOS path: no beforeinstallprompt — show manual instructions instead
  if (isIOS() && !deferredInstallPrompt) {
    const text = banner.querySelector('.install-text');
    if (text) {
      text.innerHTML = `<strong>Add to Home Screen</strong>
        <span>Tap Share, then "Add to Home Screen"</span>`;
    }
    const installBtn = $id('installBtn');
    if (installBtn) {
      installBtn.textContent = 'Got it';
      installBtn.addEventListener('click', dismissInstall, { once: true });
    }
  }

  banner.classList.add('visible');
}

export function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    // Don't show immediately — wait for engagement check to pass.
    setTimeout(maybeShowInstallBanner, 1500);
  });

  window.addEventListener('appinstalled', () => {
    $id('install-banner').classList.remove('visible');
    deferredInstallPrompt = null;
    showToast('App installed ✓', 'success');
  });

  $id('installBtn').addEventListener('click', triggerInstall);
  $id('installDismiss').addEventListener('click', dismissInstall);

  // iOS: no beforeinstallprompt, so attempt a check after a delay
  if (isIOS()) {
    setTimeout(maybeShowInstallBanner, 5000);
  }
}

async function triggerInstall() {
  if (!deferredInstallPrompt) {
    // iOS / no prompt support: the banner already shows manual instructions
    $id('install-banner').classList.remove('visible');
    return;
  }
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') {
    $id('install-banner').classList.remove('visible');
  }
  deferredInstallPrompt = null;
}

function dismissInstall() {
  $id('install-banner').classList.remove('visible');
  localStorage.setItem(DISMISS_KEY, String(Date.now()));
}

// ── Online / Offline ──────────────────────────────────
export function initOnlineStatus() {
  function update() {
    const bar = $id('offline-bar');
    if (!navigator.onLine) {
      bar.classList.add('visible');
      document.querySelector('header').style.marginTop = '26px';
    } else {
      bar.classList.remove('visible');
      document.querySelector('header').style.marginTop = '';
    }
  }
  window.addEventListener('online', () => { update(); refreshCurrentStop(); });
  window.addEventListener('offline', update);
  update();
}

// ── Visibility-aware polling ──────────────────────────
export function initVisibilityHandlers() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.lastHiddenAt = Date.now();
      clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    } else {
      if (state.currentStop && navigator.onLine && Date.now() - state.lastHiddenAt > 60_000) {
        refreshCurrentStop();
      }
    }
  });
}

// ── Pull-to-refresh ───────────────────────────────────
export function initPullToRefresh() {
  const THRESHOLD = 70;
  const MAX_PULL = 110;
  let startY = 0;
  let pulling = false;
  let refreshing = false;
  const ind = $id('ptr-indicator');

  function reset() {
    ind.classList.remove('pulling', 'ready');
    ind.style.transform = '';
    ind.style.opacity = '';
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  window.addEventListener('touchstart', (e) => {
    if (refreshing) return;
    if (!state.currentStop) return;
    if (window.scrollY > 0) return;
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!pulling || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { reset(); return; }
    const pulled = Math.min(MAX_PULL, dy * 0.5);
    ind.classList.add('pulling');
    const ready = pulled >= THRESHOLD;
    if (ready) ind.classList.add('ready');
    else ind.classList.remove('ready');
    if (!reduceMotion) {
      ind.style.transform = `translateX(-50%) translateY(${-60 + pulled}px) scale(${0.8 + pulled / 400})`;
    }
  }, { passive: true });

  window.addEventListener('touchend', () => {
    if (!pulling || refreshing) return;
    pulling = false;
    const wasReady = ind.classList.contains('ready');
    if (wasReady && state.currentStop) {
      refreshing = true;
      ind.className = 'refreshing';
      ind.style.transform = '';
      haptic(12);
      Promise.resolve(refreshCurrentStop())
        .finally(() => {
          setTimeout(() => { refreshing = false; reset(); }, 450);
        });
    } else {
      reset();
    }
  }, { passive: true });

  window.addEventListener('touchcancel', () => { pulling = false; reset(); }, { passive: true });
}

// ── Cache stats ───────────────────────────────────────
export async function updateCacheStats() {
  if (!swRegistration || !navigator.serviceWorker.controller) return;
  try {
    const channel = new MessageChannel();
    const result = await new Promise(resolve => {
      channel.port1.onmessage = e => resolve(e.data);
      navigator.serviceWorker.controller.postMessage('getCacheStats', [channel.port2]);
    });
    $id('cacheShellCount').textContent = result.shell + ' files';
    $id('cacheTileCount').textContent  = result.tiles + ' tiles';
    $id('cacheStatus').style.display = 'flex';
  } catch (_) {}
}

export async function clearTileCache() {
  if (!navigator.serviceWorker.controller) return;
  const channel = new MessageChannel();
  await new Promise(resolve => {
    channel.port1.onmessage = () => resolve();
    navigator.serviceWorker.controller.postMessage('clearTileCache', [channel.port2]);
  });
  showToast('Tile cache cleared', 'success');
  updateCacheStats();
}

export function updateSW() {
  if (!swRegistration) { showToast('Service worker not active', 'error'); return; }
  swRegistration.update().then(() => showToast('Checked for updates ✓', 'success'));
}
