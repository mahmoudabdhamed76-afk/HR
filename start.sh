#!/bin/sh
# EmdadX Attendance - Linux / macOS / Synology launcher
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js 22+ is required: https://nodejs.org"; exit 1
fi
MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$MAJOR" -lt 22 ]; then
  echo "[!] Node.js $(node -v) is too old. Install Node.js 22 or newer."; exit 1
fi
export PORT="${PORT:-8686}"
exec node --experimental-sqlite --no-warnings server.js
