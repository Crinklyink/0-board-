#!/usr/bin/env bash
# O Board — Raspberry Pi installer.
#
#   sudo ./pi/install.sh                 # server + TV kiosk on HDMI (Raspberry Pi OS Lite or Desktop, 64-bit)
#   sudo ./pi/install.sh --no-kiosk      # server only (headless, or you run the browser yourself)
#   sudo GEMINI_API_KEY=... ./pi/install.sh   # non-interactive key
#
# Safe to re-run: it upgrades the app in place and keeps your data (/var/lib/oboard) and settings (/etc/oboard).
set -euo pipefail

NODE_VERSION="v24.21.0"
NODE_SHA256_ARM64="6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2"
NODE_SHA256_X64="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"

APP_DIR=/opt/oboard
DATA_DIR=/var/lib/oboard
ETC_DIR=/etc/oboard
SERVICE_USER=oboard
PORT="${PORT:-8080}"
KIOSK=1
for arg in "$@"; do
  case "$arg" in
    --no-kiosk) KIOSK=0 ;;
    --help|-h) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo."
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SRC_DIR/server/package.json" ] && [ -f "$SRC_DIR/web/index.html" ] || die "Run from an O Board checkout or release folder."
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64) NODE_ARCH=arm64; NODE_SHA="$NODE_SHA256_ARM64" ;;
  x86_64) NODE_ARCH=x64; NODE_SHA="$NODE_SHA256_X64"; warn "Not a Raspberry Pi (x86_64). Continuing for testing." ;;
  *) die "Unsupported CPU $ARCH. Use 64-bit Raspberry Pi OS." ;;
esac
command -v apt-get >/dev/null || die "This installer needs a Debian-based OS (Raspberry Pi OS)."

# ---------------------------------------------------------------- packages
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
PKGS=(curl ca-certificates xz-utils avahi-daemon sqlite3 tar)
if [ "$KIOSK" = 1 ]; then
  PKGS+=(cage seatd fonts-noto-color-emoji)
  if apt-cache show chromium >/dev/null 2>&1; then PKGS+=(chromium); else PKGS+=(chromium-browser); fi
fi
apt-get install -y -qq --no-install-recommends "${PKGS[@]}"

# ---------------------------------------------------------------- Node.js (pinned + checksum-verified)
if ! /opt/node/bin/node --version 2>/dev/null | grep -qx "$NODE_VERSION"; then
  say "Installing Node.js $NODE_VERSION ($NODE_ARCH)"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  TARBALL="node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  curl -fsSL -o "$TMP/$TARBALL" "https://nodejs.org/dist/$NODE_VERSION/$TARBALL"
  echo "$NODE_SHA  $TMP/$TARBALL" | sha256sum -c --quiet - || die "Node.js download failed its checksum. Not installing."
  rm -rf /opt/node.new && mkdir -p /opt/node.new
  tar -xJf "$TMP/$TARBALL" -C /opt/node.new --strip-components=1
  rm -rf /opt/node && mv /opt/node.new /opt/node
  ln -sf /opt/node/bin/node /usr/local/bin/node
fi

# ---------------------------------------------------------------- user, folders, app
say "Setting up the oboard user and folders"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
usermod -aG video,render,input,audio "$SERVICE_USER" 2>/dev/null || true
getent group _seatd >/dev/null && usermod -aG _seatd "$SERVICE_USER" || true
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
install -d -m 0750 -o root -g "$SERVICE_USER" "$ETC_DIR"

say "Installing the app to $APP_DIR"
rm -rf "$APP_DIR.new" && mkdir -p "$APP_DIR.new"
cp -a "$SRC_DIR/server" "$SRC_DIR/web" "$SRC_DIR/pi" "$APP_DIR.new/"
rm -rf "$APP_DIR.new/server/data" "$APP_DIR.new/server/.env" "$APP_DIR.new/server/test"
if [ ! -d "$APP_DIR.new/server/node_modules/ws" ]; then
  (
    cd "$APP_DIR.new/server"
    export PATH=/opt/node/bin:$PATH
    npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund
  )
fi
chown -R root:root "$APP_DIR.new"
rm -rf "$APP_DIR.old"; [ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"
chmod +x "$APP_DIR"/pi/*.sh

# ---------------------------------------------------------------- settings (the Gemini key lives only here)
ENV_FILE="$ETC_DIR/oboard.env"
if [ ! -f "$ENV_FILE" ]; then
  KEY="${GEMINI_API_KEY:-}"
  if [ -z "$KEY" ] && [ -t 0 ]; then
    echo
    echo "Paste your Gemini API key (from https://aistudio.google.com/apikey)."
    echo "It is stored only on this Pi, readable by root and the oboard service. Leave empty to add it later."
    read -r -s -p "GEMINI_API_KEY: " KEY; echo
  fi
  TZ_NAME="$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"
  umask 077
  cat > "$ENV_FILE" <<EOF
# O Board server settings. Restart after editing:  sudo systemctl restart oboard
GEMINI_API_KEY=$KEY
PORT=$PORT
HOST=0.0.0.0
DATA_DIR=$DATA_DIR
TZ=$TZ_NAME
# Optional overrides (defaults shown):
# GEMINI_TEXT_MODEL=gemini-3.8-flash
# GEMINI_LIVE_MODEL=gemini-3.8-live
# BACKUP_EVERY_HOURS=6
# BACKUP_KEEP=14
EOF
  chown root:"$SERVICE_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
else
  say "Keeping existing $ENV_FILE"
fi

# ---------------------------------------------------------------- systemd
say "Installing services"
install -m 0644 "$APP_DIR/pi/systemd/oboard.service" /etc/systemd/system/oboard.service
install -m 0644 "$APP_DIR/pi/systemd/oboard-health.service" /etc/systemd/system/oboard-health.service
install -m 0644 "$APP_DIR/pi/systemd/oboard-health.timer" /etc/systemd/system/oboard-health.timer
if [ "$KIOSK" = 1 ]; then
  install -m 0644 "$APP_DIR/pi/systemd/oboard-kiosk.service" /etc/systemd/system/oboard-kiosk.service
  install -m 0644 "$APP_DIR/pi/systemd/oboard-kiosk-refresh.service" /etc/systemd/system/oboard-kiosk-refresh.service
  install -m 0644 "$APP_DIR/pi/systemd/oboard-kiosk-refresh.timer" /etc/systemd/system/oboard-kiosk-refresh.timer
  systemctl enable seatd.service >/dev/null 2>&1 || true
  # The kiosk takes over the first console; stop the login prompt there.
  systemctl disable --now getty@tty1.service >/dev/null 2>&1 || true
  # If a desktop session is installed it would fight over the screen: boot to console instead.
  if systemctl get-default | grep -q graphical; then
    warn "Switching the default boot target to console so the TV kiosk owns the screen (sudo systemctl set-default graphical.target to undo)."
    systemctl set-default multi-user.target >/dev/null
  fi
fi

# mDNS: the phone app finds the Pi automatically
install -m 0644 "$APP_DIR/pi/avahi-oboard.service" /etc/avahi/services/oboard.service
sed -i "s/<port>[0-9]*<\/port>/<port>$PORT<\/port>/" /etc/avahi/services/oboard.service
systemctl enable --now avahi-daemon >/dev/null 2>&1 || true

systemctl daemon-reload
systemctl enable --now oboard.service oboard-health.timer
if [ "$KIOSK" = 1 ]; then
  systemctl enable oboard-kiosk.service oboard-kiosk-refresh.timer
  systemctl restart oboard-kiosk.service || warn "Kiosk did not start yet; it will on next boot."
fi

# ---------------------------------------------------------------- done
say "Waiting for the server"
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || die "Server did not come up. See: journalctl -u oboard -n 100"
IPS="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -3 | tr '\n' ' ')"
echo
say "O Board is running."
echo "    On this network:  http://$(hostname).local:$PORT   ($IPS)"
grep -q '^GEMINI_API_KEY=$' "$ENV_FILE" && warn "No Gemini key yet: edit $ENV_FILE, then  sudo systemctl restart oboard"
echo "    Pair your phone:  open the O Board app; the TV shows an 8-digit code."
echo "    Logs:             journalctl -u oboard -f        Kiosk logs: journalctl -u oboard-kiosk -f"
echo "    Backups:          $DATA_DIR/backups (every 6 h)  Full backup: sudo $APP_DIR/pi/backup.sh"
echo "    Remote access:    see $APP_DIR/pi/README.md (Tailscale)"
