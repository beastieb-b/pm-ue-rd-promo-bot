#!/bin/bash
# Postmates Promo Tracker — double-click to launch, or run from terminal

# ── Navigate to this script's folder (works wherever you move it) ────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Helpers ──────────────────────────────────────────────────────────────────
alert() {
  osascript -e "display dialog \"$1\" buttons {\"OK\"} default button \"OK\" with icon stop" 2>/dev/null || echo "ERROR: $1"
}

PORT=8766

# ── Check if already running ─────────────────────────────────────────────────
if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Postmates Promo Tracker is already running."
  open "http://localhost:$PORT"
  exit 0
fi

# ── Check Node.js ─────────────────────────────────────────────────────────────
NODE_BIN=""
for p in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin/node" /usr/bin/node; do
  if [ -x "$p" ]; then NODE_BIN="$p"; break; fi
done
# Also try PATH
if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node 2>/dev/null)
fi

if [ -z "$NODE_BIN" ]; then
  alert "Node.js is required but not found.\n\nInstall it from https://nodejs.org (LTS version), then try again."
  exit 1
fi

NODE_VER=$("$NODE_BIN" -e "process.stdout.write(process.version)")
echo "Using Node.js $NODE_VER at $NODE_BIN"

# ── Check Chrome ──────────────────────────────────────────────────────────────
CHROME="/Applications/Google Chrome.app"
if [ ! -d "$CHROME" ]; then
  alert "Google Chrome is required for Postmates automation.\n\nInstall it from https://www.google.com/chrome, then try again."
  exit 1
fi

# ── Install npm dependencies if missing ───────────────────────────────────────
if [ ! -d "$SCRIPT_DIR/node_modules/playwright" ]; then
  echo "Installing dependencies (first run, takes ~30 seconds)..."
  NPM_BIN=$(dirname "$NODE_BIN")/npm
  "$NPM_BIN" install --silent 2>&1 | tail -3
  if [ $? -ne 0 ]; then
    alert "Failed to install dependencies.\n\nCheck your internet connection and try again."
    exit 1
  fi
  echo "Dependencies installed."
fi

# ── Create data directory if missing ─────────────────────────────────────────
mkdir -p "$SCRIPT_DIR/data" "$SCRIPT_DIR/archive"

# ── Start the daemon ──────────────────────────────────────────────────────────
LOG="$SCRIPT_DIR/data/daemon.log"
echo "" >> "$LOG"
echo "=== Started at $(date) ===" >> "$LOG"

"$NODE_BIN" "$SCRIPT_DIR/src/index.js" >> "$LOG" 2>&1 &
DAEMON_PID=$!
echo "Daemon started (PID $DAEMON_PID)"

# ── Wait for the server to be ready ──────────────────────────────────────────
echo -n "Waiting for server..."
for i in $(seq 1 20); do
  sleep 0.5
  if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo " ready."
    break
  fi
  echo -n "."
done

# ── Open dashboard ────────────────────────────────────────────────────────────
open "http://localhost:$PORT"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Postmates Promo Tracker is running"
echo "  Dashboard:  http://localhost:$PORT"
echo "  Log file:   $LOG"
echo ""
echo "  Press Ctrl+C or close this window to stop."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Keep running until killed ─────────────────────────────────────────────────
trap "echo ''; echo 'Stopping...'; kill $DAEMON_PID 2>/dev/null; exit 0" INT TERM
wait $DAEMON_PID
