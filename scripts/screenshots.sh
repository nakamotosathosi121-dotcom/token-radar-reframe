#!/usr/bin/env bash
# Radar reframe screenshots: serve a generated output directory, then capture the board,
# the top protocol's detail view and a filtered view at 1440x1200 with the
# Playwright Chromium binary. Run main.ts first so the output dir exists.
set -euo pipefail
OUT="${1:-/tmp/reframe-out}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="$HOME/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome"
PORT=8934

(cd "$OUT" && python3 -m http.server "$PORT" >/dev/null 2>&1 &)
sleep 1

shot() {
  "$CHROME" --headless --disable-gpu --no-sandbox --window-size=1440,1200 \
    --virtual-time-budget=6000 --screenshot="$REPO/screenshots/$1" \
    "http://127.0.0.1:$PORT/dashboard/index.html$2" 2>/dev/null
}

shot 1-board.png ""
shot 2-detail.png "#p=polymarket-international&focus=1"
shot 3-filtered.png "#category=Risk%20Curators&deposit=5000&slice=20"

pkill -f "http.server $PORT" || true
ls -la "$REPO/screenshots"
