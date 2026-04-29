#!/usr/bin/env bash
# SG Bus Tracker — proxy status script
# Reports whether the proxy is running, its PID, and the last ~20 log lines.
PID_FILE="${HOME}/.sg-bus-tracker.pid"
LOG_FILE="${HOME}/.sg-bus-tracker.log"

echo "── SG Bus Tracker proxy status ─────────────────"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "  State:  RUNNING (PID $PID)"
  else
    echo "  State:  PID FILE EXISTS but process is dead (stale)"
  fi
else
  # Secondary check — maybe user started it manually without start.sh
  if pgrep -f "python proxy.py" >/dev/null 2>&1; then
    echo "  State:  running (no PID file — started manually?)"
    pgrep -f "python proxy.py" | head -3 | while read p; do
      echo "          PID: $p"
    done
  else
    echo "  State:  NOT RUNNING"
  fi
fi

echo "  Log:    $LOG_FILE"
if [ -f "$LOG_FILE" ]; then
  echo "  Size:   $(wc -c < "$LOG_FILE") bytes"
  echo ""
  echo "── Last 20 log lines ──────────────────────────"
  tail -20 "$LOG_FILE"
else
  echo "  (log file doesn't exist yet)"
fi

# Reachability check
echo ""
echo "── Reachability ───────────────────────────────"
if command -v curl >/dev/null 2>&1; then
  if curl -sS --max-time 2 http://127.0.0.1:8080/ping >/dev/null 2>&1; then
    echo "  127.0.0.1:8080/ping — OK"
  else
    echo "  127.0.0.1:8080/ping — unreachable"
  fi
else
  echo "  curl not installed; skipping reachability check"
fi
