#!/data/data/com.termux/files/usr/bin/sh
# SG Bus Tracker — Termux:Boot entry point
#
# This script is what Termux:Boot runs at phone boot. Copy it to
# ~/.termux/boot/ (Termux:Boot scans that directory).
#
# Expected install path:
#   ~/.termux/boot/sg-bus-tracker   → points at sg-bus-v8.2/scripts/start.sh
#
# The boot script deliberately stays minimal — it just delegates to start.sh
# which handles PID tracking, wake-lock, and the crash-restart loop.
#
# If you moved the project to a different path, edit APP_DIR below.

APP_DIR="$HOME/sg-bus-v8.2"

# Wait for the network stack to be up. Android usually takes a few seconds
# after boot before localhost sockets work reliably.
sleep 3

# Delegate to the main start script
exec bash "$APP_DIR/scripts/start.sh"
