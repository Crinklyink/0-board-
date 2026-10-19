#!/usr/bin/env bash
# Runs every minute (oboard-health.timer). Restarts the server after 3 failed checks in a row,
# brings the TV browser back if it died, and warns in the journal when the SD card is nearly full.
set -uo pipefail
PORT="$(grep -E '^PORT=' /etc/oboard/oboard.env 2>/dev/null | cut -d= -f2)"
PORT="${PORT:-8080}"
STATE=/run/oboard-health.fails

if curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo 0 > "$STATE"
else
  n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$STATE"
  echo "health check failed ($n in a row)"
  if [ "$n" -ge 3 ]; then
    echo "restarting oboard.service"
    systemctl restart oboard.service
    echo 0 > "$STATE"
  fi
fi

if systemctl is-enabled --quiet oboard-kiosk.service 2>/dev/null && ! systemctl is-active --quiet oboard-kiosk.service; then
  echo "TV kiosk not running; starting it"
  systemctl start oboard-kiosk.service
fi

free_mb=$(df -Pm /var/lib/oboard | awk 'NR==2 {print $4}')
if [ "${free_mb:-9999}" -lt 500 ]; then
  echo "WARNING: only ${free_mb} MB free on the data disk; old backups in /var/lib/oboard/backups can be removed"
fi
