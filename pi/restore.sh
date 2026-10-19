#!/usr/bin/env bash
# Restore from a backup made by backup.sh (.tar.gz), the phone app (.tar), or an automatic database backup (.db).
#   sudo /opt/oboard/pi/restore.sh /path/to/oboard-full-....tar.gz
# The current data is moved aside to /var/lib/oboard.before-restore-<time> first, so a restore can be undone.
set -euo pipefail
SRC="${1:?Usage: restore.sh <backup.tar.gz | backup.tar | backup.db>}"
DATA="${DATA_DIR:-/var/lib/oboard}"
STAMP="$(date +%Y%m%d-%H%M%S)"
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
[ -f "$SRC" ] || { echo "No such file: $SRC" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
case "$SRC" in
  *.tar.gz|*.tgz) tar -xzf "$SRC" -C "$WORK" ;;
  *.tar) tar -xf "$SRC" -C "$WORK" ;;
  *.db) cp "$SRC" "$WORK/oboard.db" ;;
  *) echo "Unknown backup type: $SRC" >&2; exit 1 ;;
esac
[ -f "$WORK/oboard.db" ] || { echo "Backup has no oboard.db" >&2; exit 1; }
sqlite3 "$WORK/oboard.db" "PRAGMA integrity_check;" | grep -qx ok || { echo "Backup database is damaged; not restoring." >&2; exit 1; }

echo "Stopping O Board"
systemctl stop oboard-kiosk.service 2>/dev/null || true
systemctl stop oboard.service
cp -a "$DATA" "$DATA.before-restore-$STAMP"
rm -f "$DATA/oboard.db" "$DATA/oboard.db-wal" "$DATA/oboard.db-shm"
cp "$WORK/oboard.db" "$DATA/oboard.db"
if [ -d "$WORK/assets" ]; then
  mkdir -p "$DATA/assets"
  cp -an "$WORK/assets/." "$DATA/assets/"   # assets are content-addressed: never overwrite, only add
fi
chown -R oboard:oboard "$DATA"
systemctl start oboard.service
systemctl start oboard-kiosk.service 2>/dev/null || true
echo "Restored. Previous data kept in $DATA.before-restore-$STAMP"
