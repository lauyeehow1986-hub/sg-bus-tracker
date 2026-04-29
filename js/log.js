// ── Structured client logging ────────────────────────
// A tiny ring buffer of recent log entries + a proxy-side tail endpoint.
// Replaces scattered console.log/warn/error. Keeps the last 500 entries in
// memory; each entry is { ts, level, tag, msg, data }. The buffer survives
// across navigations only within a single page session.
//
// To view the log live:
//   http://127.0.0.1:8080/logs   (Server-Sent Events; pipe to any browser tab)
//
// Console output is preserved so existing devtools debugging is unaffected.

const MAX = 500;
const ring = [];
let proxyPostEnabled = false; // enabled once the proxy is confirmed reachable
let proxyPostFailures = 0;    // disable posting after repeated failures

function push(level, tag, msg, data) {
  const entry = {
    ts: Date.now(),
    level, tag,
    msg: typeof msg === 'string' ? msg : JSON.stringify(msg),
    data: data === undefined ? null : safeSerialize(data),
  };
  ring.push(entry);
  if (ring.length > MAX) ring.shift();

  // Mirror to console for live dev sessions
  const fn = level === 'error' ? console.error
           : level === 'warn'  ? console.warn
           : console.log;
  fn(`[${tag}]`, msg, ...(data !== undefined ? [data] : []));

  // Optionally POST to proxy /log endpoint (fire and forget)
  if (proxyPostEnabled && proxyPostFailures < 3) {
    fetch('/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
      keepalive: true,
    }).catch(() => { proxyPostFailures++; });
  }
}

function safeSerialize(v) {
  try {
    if (v === null || typeof v !== 'object') return v;
    return JSON.parse(JSON.stringify(v, (_k, val) => {
      if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
      return val;
    }));
  } catch (_) { return String(v); }
}

export const log = {
  debug: (tag, msg, data) => push('debug', tag, msg, data),
  info:  (tag, msg, data) => push('info',  tag, msg, data),
  warn:  (tag, msg, data) => push('warn',  tag, msg, data),
  error: (tag, msg, data) => push('error', tag, msg, data),
};

export function getLogBuffer() { return ring.slice(); }

export function enableProxyLog() {
  proxyPostEnabled = true;
  proxyPostFailures = 0;
}

// Expose to window so you can run `__sgbus_log()` in DevTools for a quick dump
if (typeof window !== 'undefined') {
  window.__sgbus_log = () => ring.slice();
}
