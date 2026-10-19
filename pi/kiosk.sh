#!/usr/bin/env bash
# Starts the TV display: waits for the server, then opens the board full screen on the HDMI output.
set -euo pipefail

PORT="${PORT:-8080}"
DATA="${DATA_DIR:-/var/lib/oboard}"
PROFILE="$DATA/kiosk-profile"

for _ in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done

# The display's access token is handed to the page through a private local file rather than the command line,
# so it never shows up in the process list.
TOKEN="$(cat "$DATA/display.token")"
START="$DATA/kiosk-start.html"
umask 077
cat > "$START" <<EOF
<!doctype html><meta charset="utf-8"><title>O Board</title><style>html{background:#05070C}</style>
<script>location.replace("http://127.0.0.1:$PORT/?mode=tv#t=$TOKEN")</script>
EOF

BROWSER="$(command -v chromium || command -v chromium-browser)"
mkdir -p "$PROFILE"
# A crash or power cut leaves Chromium thinking it exited badly; clear that so no "restore pages" bubble appears.
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PROFILE/Default/Preferences" 2>/dev/null || true

exec cage -d -s -- "$BROWSER" \
  --kiosk --noerrdialogs --disable-infobars --no-first-run --no-default-browser-check \
  --disable-session-crashed-bubble --disable-features=Translate,MediaRouter,OptimizationHints \
  --autoplay-policy=no-user-gesture-required --check-for-update-interval=31536000 \
  --password-store=basic --ozone-platform=wayland --enable-gpu-rasterization \
  --user-data-dir="$PROFILE" \
  "file://$START"
