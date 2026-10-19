#!/usr/bin/env bash
# Removes the O Board services and app. Your boards in /var/lib/oboard and settings in /etc/oboard are KEPT
# unless you pass --purge.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
for u in oboard-kiosk-refresh.timer oboard-health.timer oboard-kiosk.service oboard.service; do
  systemctl disable --now "$u" 2>/dev/null || true
done
rm -f /etc/systemd/system/oboard*.service /etc/systemd/system/oboard*.timer /etc/avahi/services/oboard.service
systemctl daemon-reload
systemctl enable --now getty@tty1.service 2>/dev/null || true
rm -rf /opt/oboard /opt/oboard.old
if [ "${1:-}" = "--purge" ]; then
  rm -rf /var/lib/oboard /etc/oboard
  userdel oboard 2>/dev/null || true
  echo "O Board removed, including all boards and settings."
else
  echo "O Board removed. Data kept in /var/lib/oboard and /etc/oboard (use --purge to delete)."
fi
