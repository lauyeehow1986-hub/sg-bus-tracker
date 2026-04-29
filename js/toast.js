// ── Toast + context-aware error mapper ───────────────
import { $id } from './dom.js';

let toastTimer = null;

export function showToast(msg, type = '', action = null, durationMs = 2800) {
  const el = $id('toast');
  if (!el) return;
  el.className = '';
  el.textContent = '';

  const span = document.createElement('span');
  span.className = 'toast-msg';
  span.textContent = msg;
  el.appendChild(span);

  if (action && action.label && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      try { action.onClick(); } catch (_) {}
      el.className = '';
    });
    el.appendChild(btn);
  }

  void el.offsetWidth; // force reflow so transition plays
  el.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  const dur = action ? Math.max(durationMs, 6000) : durationMs;
  toastTimer = setTimeout(() => { el.className = ''; }, dur);
}

// Translate any error into { msg, type, action? }
export function errorFor(err, context) {
  if (context === 'geolocation') {
    const code = err && err.code;
    const isInsecure =
      location.protocol === 'http:' &&
      !['localhost', '127.0.0.1'].includes(location.hostname);
    if (code === 1 && isInsecure) {
      const loopback = `http://127.0.0.1:${location.port || '8080'}${location.pathname}`;
      return {
        msg: 'Location needs a secure origin — open via 127.0.0.1',
        type: 'error',
        action: { label: 'Open 127.0.0.1', onClick: () => { window.location.href = loopback; } }
      };
    }
    if (code === 1) return { msg: 'Location permission denied — enable in Chrome site settings', type: 'error' };
    if (code === 2) return { msg: 'Location unavailable — is GPS on?', type: 'error' };
    if (code === 3) return { msg: 'Location timed out — try again in an open area', type: 'error' };
    return { msg: 'Could not get location', type: 'error' };
  }

  const status = err && err.status;
  if (status === 401) return { msg: 'API key rejected — update it in ⚙ API Key', type: 'error' };
  if (status === 429) return { msg: 'LTA rate limit hit — try again in a minute', type: 'error' };
  if (status === 404) return { msg: 'Not found on LTA', type: 'error' };
  if (status >= 500)  return { msg: `LTA server error (${status}) — retry shortly`, type: 'error' };

  if (err instanceof TypeError || (err && /network|failed to fetch/i.test(err.message || ''))) {
    if (!navigator.onLine) return { msg: 'Offline — showing cached data where possible', type: 'error' };
    return { msg: 'Could not reach proxy — is proxy.py still running?', type: 'error' };
  }

  if (err && err.name === 'AbortError') return { msg: 'Request timed out', type: 'error' };

  const detail = (err && (err.message || err.toString())) || 'Unknown error';
  return { msg: detail.length > 80 ? detail.slice(0, 77) + '…' : detail, type: 'error' };
}

export function toastError(err, context) {
  const e = errorFor(err, context);
  showToast(e.msg, e.type, e.action);
}
