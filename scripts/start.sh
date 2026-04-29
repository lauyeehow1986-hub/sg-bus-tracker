#!/usr/bin/env bash
# SG Bus Tracker — proxy start script
# Starts proxy.py in the background with:
#   - a PID file so we don't accidentally start two instances
#   - Termux wake-lock (if available) so Android doesn't kill it on sleep
#   - a crash-restart loop (restart up to 5 times if it dies quickly)
#   - log redirection to ~/.sg-bus-tracker.log
#
# Usage:
#   bash scripts/start.sh              # start in background, return immediately
#   bash scripts/start.sh --foreground # start and block (for debugging)

set -e
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
PID_FILE="${HOME}/.sg-bus-tracker.pid"
LOG_FILE="${HOME}/.sg-bus-tracker.log"

# Already running?
if [ -f "$PID_FILE" ]; then
  OLDPID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null; then
    echo "✓ Proxy already running (PID $OLDPID). Logs: $LOG_FILE"
    exit 0
  fi
  # Stale PID file — clean up
  rm -f "$PID_FILE"
fi

# Acquire Termux wake-lock if the command exists. This stops Android from
# killing the proxy when the phone sleeps. Harmless on non-Termux systems.
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock 2>/dev/null || true
fi

run_loop() {
  local tries=0
  local max=5
  local last_start=0
  while [ $tries -lt $max ]; do
    local now=$(date +%s)
    # If the previous run lasted < 10s, count this as a "quick death" and
    # back off. If it lasted longer, reset the counter — it was probably
    # a clean external stop.
    if [ $((now - last_start)) -lt 10 ]; then
      tries=$((tries + 1))
    else
      tries=0
    fi
    last_start=$now

    echo "[$(date '+%F %T')] starting proxy.py (attempt $((tries + 1))/$max)" >> "$LOG_FILE"
    python proxy.py >> "$LOG_FILE" 2>&1 || true
    echo "[$(date '+%F %T')] proxy exited, retrying in 2s..." >> "$LOG_FILE"
    sleep 2
  done
  echo "[$(date '+%F %T')] too many quick crashes, giving up" >> "$LOG_FILE"
}

if [ "${1:-}" = "--foreground" ]; then
  run_loop
else
  # Background: launch run_loop in a subshell disowned from this terminal
  (
    run_loop
    rm -f "$PID_FILE"
  ) &
  echo $! > "$PID_FILE"
  # Give it a moment so the log file exists when the user tails it
  sleep 0.3
  echo "✓ Proxy started (PID $(cat "$PID_FILE"))."
  echo "  Logs:  tail -f $LOG_FILE"
  echo "  Stop:  bash $APP_DIR/scripts/stop.sh"
fi
