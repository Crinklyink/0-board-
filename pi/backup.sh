#!/usr/bin/env bash
# Full backup: a consistent copy of the database plus every uploaded file, in one .tar.gz.
#   sudo /opt/oboard/pi/backup.sh                 -> /var/lib/oboard/backups/oboard-full-YYYYmmdd-HHMMSS.tar.gz
#   sudo /opt/oboard/pi/backup.sh /media/usb/     -> written to that folder instead
# Safe while the server is running (SQLite's online backup API is used).
set -euo pipefail
DATA="${DATA_DIR:-/var/lib/oboard}"
OUT_DIR="${1:-$DATA/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$DATA/oboard.db" ] || { echo "No database at $DATA/oboard.db" >&2; exit 1; }
mkdir -p "$OUT_DIR"
sqlite3 "$DATA/oboard.db" ".backup '$WORK/oboard.db'"
sqlite3 "$WORK/oboard.db" "PRAGMA integrity_check;" | grep -qx ok || { echo "Backup copy failed its integrity check" >&2; exit 1; }
OUT="$OUT_DIR/oboard-full-$STAMP.tar.gz"
tar -czf "$OUT" -C "$WORK" oboard.db -C "$DATA" assets
chmod 0640 "$OUT"
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
