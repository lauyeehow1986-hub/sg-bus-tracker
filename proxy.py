#!/usr/bin/env python3
"""
LTA DataMall CORS Proxy — PNA-safe edition
Run: python proxy.py
Open the URL printed below in Chrome.

Key Chrome fix:
  Access-Control-Allow-Private-Network: true is now sent on EVERY response,
  not only on OPTIONS preflights. Chrome's Private Network Access check is
  triggered on the *actual* request when the initiator is a LAN-IP page and
  the target is localhost/loopback, so the header must be on the GET response
  as well.
"""

import json, os, time, socket, threading
import urllib.request, urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
API_KEY_FILE = os.path.join(SCRIPT_DIR, "lta_api_key.txt")
LTA_BASE     = "https://datamall2.mytransport.sg/ltaodataservice"
PROXY_PORT   = 8080

# ── Cache ─────────────────────────────────────────────
_cache = {}
_cache_lock = threading.Lock()
CACHE_RULES = {
    "/BusRoutes":    6 * 60 * 60,   # 6h: global route table, ~26k rows, rarely changes
    "/BusStops":     60 * 60,
    "/BusServices":  10 * 60,
    "/v3/BusArrival": 0,   # never cache live data
}

def get_cache_ttl(path):
    for prefix, ttl in CACHE_RULES.items():
        if path.startswith(prefix):
            return ttl
    return 0

def cache_get(url):
    with _cache_lock:
        entry = _cache.get(url)
        if entry:
            ts, data = entry
            path = '/' + urllib.parse.urlparse(url).path.split('/', 3)[-1]
            ttl = get_cache_ttl(path)
            if ttl and (time.time() - ts) < ttl:
                return data
            elif url in _cache:
                del _cache[url]
    return None

def cache_set(url, data):
    path = '/' + urllib.parse.urlparse(url).path.split('/', 3)[-1]
    if get_cache_ttl(path):
        with _cache_lock:
            _cache[url] = (time.time(), data)

# ── Get LAN IP ────────────────────────────────────────
def get_lan_ip():
    """Get the device's LAN IP — works on Termux/Android without special perms."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

LAN_IP = get_lan_ip()

# ── T4.3: client-log ring buffer (thread-safe) ───────
_client_log = []
_client_log_lock = threading.Lock()
_CLIENT_LOG_MAX = 500

def _log_append(entry):
    with _client_log_lock:
        _client_log.append(entry)
        if len(_client_log) > _CLIENT_LOG_MAX:
            del _client_log[:len(_client_log) - _CLIENT_LOG_MAX]

def _log_render():
    with _client_log_lock:
        snapshot = list(_client_log)
    lines = []
    for e in snapshot:
        ts = e.get("ts", 0)
        when = time.strftime("%H:%M:%S", time.localtime(ts / 1000)) if ts else "--:--:--"
        level = (e.get("level") or "info")[:5].upper().ljust(5)
        tag = (e.get("tag") or "?")[:12].ljust(12)
        msg = e.get("msg") or ""
        data = e.get("data")
        line = f"{when}  {level}  [{tag}]  {msg}"
        if data not in (None, ""):
            line += f"  {json.dumps(data)[:300]}"
        lines.append(line)
    return "\n".join(lines) + ("\n" if lines else "(empty)\n")

# ── Threading server ──────────────────────────────────
class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

def load_api_key():
    if os.path.exists(API_KEY_FILE):
        with open(API_KEY_FILE) as f:
            return f.read().strip()
    return None

def save_api_key(key):
    with open(API_KEY_FILE, "w") as f:
        f.write(key.strip())

class ProxyHandler(SimpleHTTPRequestHandler):

    def log_message(self, fmt, *args): pass

    def send_cors_headers(self):
        # T20: server now binds to 127.0.0.1 only, so no remote origin
        # can reach this proxy. CORS headers below are mostly defensive
        # — they ensure same-origin requests work cleanly regardless of
        # how the page is loaded (direct URL vs installed PWA context).
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, AccountKey, X-Requested-With")
        # PNA header retained for compatibility but no longer load-bearing
        # — same-origin requests don't trigger Chrome's PNA check.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "86400")
        # Don't let the browser cache 4xx/5xx forever
        self.send_header("Cache-Control", "no-store")

    def send_json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        # T4.3: accept structured log entries from the client
        if path == "/log":
            try:
                length = int(self.headers.get("Content-Length", "0") or 0)
                body = self.rfile.read(length) if length > 0 else b""
                entry = json.loads(body.decode() or "{}")
                _log_append(entry)
                self.send_response(204)
                self.send_cors_headers()
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            except Exception as e:
                self.send_json(400, {"error": str(e)})
                return
        # Unknown POST path
        self.send_json(404, {"error": "Not found"})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, query = parsed.path, parsed.query

        # /ping — simple reachability check
        if path == "/ping":
            self.send_response(200)
            self.send_cors_headers()
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return

        # /logs — return the last N client log entries as text
        if path == "/logs":
            out = _log_render()
            data = out.encode()
            self.send_response(200)
            self.send_cors_headers()
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        # /keycheck
        if path == "/keycheck":
            self.send_json(200, {"hasKey": bool(load_api_key()), "lan_ip": LAN_IP})
            return

        # /setkey?key=XXX
        if path == "/setkey":
            params = urllib.parse.parse_qs(query)
            key = params.get("key", [None])[0]
            if key:
                save_api_key(key)
                print(f"  [KEY] Saved")
                self.send_json(200, {"ok": True})
            else:
                self.send_json(400, {"ok": False, "message": "No key"})
            return

        # /cache/stats and /cache/clear
        if path == "/cache/stats":
            with _cache_lock:
                self.send_json(200, {"entries": len(_cache)})
            return
        if path == "/cache/clear":
            with _cache_lock:
                n = len(_cache); _cache.clear()
            self.send_json(200, {"cleared": n})
            return

        # /lta/<endpoint>
        if path.startswith("/lta/"):
            api_key = load_api_key()
            if not api_key:
                self.send_json(401, {"error": "No API key"})
                return

            lta_endpoint = path[5:]
            lta_url = f"{LTA_BASE}/{lta_endpoint}"
            if query:
                lta_url += f"?{query}"

            cached = cache_get(lta_url)
            if cached:
                print(f"  [HIT]  {lta_endpoint.split('?')[0]}")
                self.send_response(200)
                self.send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(cached)))
                self.send_header("X-Cache", "HIT")
                self.end_headers()
                self.wfile.write(cached)
                return

            print(f"  [LTA]  GET {lta_url}")
            try:
                req = urllib.request.Request(
                    lta_url,
                    headers={"AccountKey": api_key, "accept": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    raw = resp.read()
                    print(f"  [OK]   {resp.status} ({len(raw)}b)")
                    cache_set(lta_url, raw)
                    self.send_response(200)
                    self.send_cors_headers()
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)

            except urllib.error.HTTPError as e:
                body = e.read().decode(errors="replace")
                print(f"  [ERR]  HTTP {e.code}: {body[:100]}")
                self.send_json(e.code, {"error": f"LTA {e.code}: {e.reason}", "detail": body[:300]})
            except Exception as e:
                print(f"  [ERR]  {e}")
                self.send_json(502, {"error": str(e)})
            return

        # Static file serving — add CORS + PNA headers to these too
        # (needed if you ever open the HTML from file:// and fetch from proxy).
        return self.serve_static()

    def serve_static(self):
        """Like super().do_GET() but adds our security headers."""
        # We can't easily inject headers into SimpleHTTPRequestHandler's response,
        # so we do a manual implementation for the files we actually serve.
        path = urllib.parse.urlparse(self.path).path
        if path == "/":
            path = "/index.html"
        fs_path = os.path.join(SCRIPT_DIR, path.lstrip("/"))
        fs_path = os.path.normpath(fs_path)
        if not fs_path.startswith(SCRIPT_DIR):
            self.send_json(403, {"error": "Forbidden"}); return
        if not os.path.isfile(fs_path):
            self.send_json(404, {"error": "Not found"}); return

        # Guess content type
        ext = os.path.splitext(fs_path)[1].lower()
        ctypes = {
            ".html": "text/html; charset=utf-8",
            ".js":   "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".css":  "text/css; charset=utf-8",
            ".svg":  "image/svg+xml",
            ".png":  "image/png",
            ".ico":  "image/x-icon",
        }
        ctype = ctypes.get(ext, "application/octet-stream")

        with open(fs_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_cors_headers()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # SW must be fetched with Service-Worker-Allowed when scope differs,
        # but since both page and SW are at root, default scope works.
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    os.chdir(SCRIPT_DIR)
    key = load_api_key()

    print("=" * 55)
    print("  SG Bus Tracker — Proxy")
    print("=" * 55)
    print(f"  Key     : {'SET ✓' if key else 'NOT SET'}")
    print(f"  Bind    : 127.0.0.1:{PROXY_PORT}  (localhost only)")
    print()
    print(f"  ► Open this in Chrome on the same device:")
    print(f"    http://127.0.0.1:{PROXY_PORT}/index.html")
    print()
    print("  Stop: Ctrl+C")
    print("=" * 55 + "\n")

    # T20: bind to loopback only. Previously bound to 0.0.0.0 (all
    # interfaces), which exposed the proxy to the entire LAN. Anyone on
    # the same WiFi could hit /setkey, /logs, or /lta endpoints.
    # Localhost-only eliminates that attack surface entirely. The trade-
    # off is no LAN-IP access from a laptop on the same network — but
    # the documented usage was always 127.0.0.1 anyway.
    server = ThreadingHTTPServer(("127.0.0.1", PROXY_PORT), ProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
