#!/usr/bin/env bash
# SG Bus Tracker — proxy stop script
# Reads ~/.sg-bus-tracker.pid and kills the process tree.
set -e
PID_FILE="${HOME}/.sg-bus-tracker.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "✗ No PID file at $PID_FILE"
  echo "  Either the proxy isn't running, or it was started outside start.sh."
  echo "  Try: pkill -f 'python proxy.py'"
  exit 1
fi

PID=$(cat "$PID_FILE")
if ! kill -0 "$PID" 2>/dev/null; then
  echo "✗ Process $PID is not running. Cleaning up stale PID file."
  rm -f "$PID_FILE"
  exit 1
fi

# Kill the run_loop subshell; it and any child python process will die.
# On Termux we also kill any python proxy.py children just to be sure.
kill "$PID" 2>/dev/null || true
pkill -P "$PID" 2>/dev/null || true
pkill -f "python proxy.py" 2>/dev/null || true
rm -f "$PID_FILE"

# Release the wake-lock, if we acquired one
if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock 2>/dev/null || true
fi

echo "✓ Proxy stopped."
