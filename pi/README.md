# Raspberry Pi setup

The Pi keeps your boards, talks to Gemini, and shows the board full-screen on the TV. It takes about 15 minutes,
most of it waiting for downloads.

> These steps are written for a Raspberry Pi 5 (4 GB) with Raspberry Pi OS (64-bit, Bookworm or newer).
>
> The installer has been run end to end on Debian 13 (the base of current Raspberry Pi OS) in a container with systemd.
> That run covered:
> - Node install and checksum
> - the service user
> - sandboxed services
> - the health check
> - crash restart
> - backup
> - re-install and uninstall
>
> **Not yet tested on real Pi hardware, or with the TV kiosk** (which needs a screen). If a step fails, the
> [troubleshooting](#troubleshooting) section and `journalctl` output will show why.

## You need

- A Raspberry Pi 5 with its official 27 W USB-C power supply. Weaker supplies cause random restarts.
- A microSD card (32 GB+, A2 class) or a USB SSD. An SSD is faster and lasts longer.
- A micro-HDMI to HDMI cable. Use the HDMI port **next to the USB-C power port** (HDMI0).
- The TV, and your home Wi-Fi or Ethernet.
- A Gemini API key from <https://aistudio.google.com/apikey>.

## 1. Flash the card

In [Raspberry Pi Imager](https://www.raspberrypi.com/software/):

1. Choose **Raspberry Pi OS Lite (64-bit)**. The Desktop version works too; the installer switches it to boot straight
   to the TV board.
2. Open **Edit settings** (OS customisation) and set:
   - hostname: `oboard`
   - your username and password
   - your Wi-Fi network
   - your time zone
3. On the **Services** tab, enable SSH.
4. Write the card, put it in the Pi, connect the TV, and power on. The first boot takes a couple of minutes.

## 2. Copy O Board to the Pi

On your computer, either make the bundle:

```bash
node scripts/package.mjs
```

```bash
scp dist/oboard-pi-0.4.1.tar.gz <you>@oboard.local:
```

Or copy the whole project folder (the `server`, `web` and `pi` folders are what matter).

Then on the Pi:

```bash
ssh <you>@oboard.local
```

```bash
tar -xzf oboard-pi-0.4.1.tar.gz && cd oboard
```

## 3. Install

```bash
sudo ./pi/install.sh
```

When it asks, paste your Gemini key (it is not shown while you type), or leave it blank and add it from **Settings → Setup & diagnostics** after pairing the phone. The installer:

- Installs a pinned Node.js 24 (checksum-verified), Chromium, the `cage` kiosk compositor and Avahi.
- Creates a locked-down system user `oboard`, and copies the app to `/opt/oboard`.
- Writes your settings to `/etc/oboard/oboard.env`. Only root and the service can read it, and the Gemini key lives only
  there.
- Sets up the services:
  - `oboard` (the server)
  - `oboard-kiosk` (the TV)
  - a health check every minute
  - a nightly TV refresh at 04:30
- Advertises the Pi on the network so the phone app finds it.

When it finishes, the TV shows the board with a pairing code. Running the installer again upgrades the app in place and
keeps your boards and settings.

Options:

- `sudo ./pi/install.sh --no-kiosk` sets up the server only (no TV).
- `sudo PORT=8080 GEMINI_API_KEY=... ./pi/install.sh` installs without questions.

## 4. Pair your phone

Install the O Board APK on the phone and open it. It finds the Pi automatically. Type the 8-digit code from the TV, or
scan the TV's QR code with the camera. Codes work once and expire after 10 minutes.

To add another device later, use **Settings → Connection → Pair another device** on the phone. That screen also shows
paired devices; removing one cuts it off immediately.

Any browser on your network can use the board too: open `http://oboard.local:8080` and enter a code.

## Use it away from home

O Board never needs to be exposed to the internet. Use [Tailscale](https://tailscale.com), a free private network
between your own devices that is encrypted end to end.

On the Pi:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

```bash
sudo tailscale up
```

Open the link it prints and sign in. Then install the Tailscale app on the phone and sign in with the same account.

That is all. The next time the phone is connected at home, O Board learns the Pi's Tailscale address. When you leave,
it switches to it by itself (within a few seconds), and switches back when you are home again. There's no need to pair
again. The addresses it knows are listed under Settings → Connection.

> Do not forward port 8080 on your router. The Pi serves plain HTTP, which is fine inside your home network and inside
> Tailscale, but not on the open internet.

## Changing settings

```bash
sudo nano /etc/oboard/oboard.env
```

```bash
sudo systemctl restart oboard
```

| Setting | Default | |
|---|---|---|
| `GEMINI_API_KEY` | (asked by the installer) | Only ever stored here |
| `PORT` | 8080 | Change it in the installer instead, so the TV and Avahi follow |
| `GEMINI_TEXT_MODEL` / `GEMINI_LIVE_MODEL` | gemini-3.8-flash / gemini-3.8-live | Also changeable in the app (Settings → Assistant) |
| `BACKUP_EVERY_HOURS` / `BACKUP_KEEP` | 6 / 14 | Automatic database backups |
| `PUBLIC_URLS` | — | Extra addresses to tell phones about (comma-separated), e.g. a custom DNS name |

## Backups

- **Automatic.** A consistent copy of the database is made every 6 hours, and the newest 14 are kept in
  `/var/lib/oboard/backups`. Photos and files are stored separately in `/var/lib/oboard/assets` and are never changed
  once written.
- **Full backup to a USB stick:**

  ```bash
  sudo /opt/oboard/pi/backup.sh /media/<you>/<stick>/
  ```

  The backup includes the database and every file.
- **From the phone.** Settings → Backup & export downloads everything as one `.tar`.

Widget API keys are deliberately left out of every backup. After restoring onto a new Pi, add them again in the app
(Settings → API keys).

These copies live on the same SD card as the original. Keep one somewhere else from time to time (USB stick, phone
export).

**Restore** from a `.tar.gz` (`backup.sh`), a `.tar` (phone export) or a `.db` (automatic):

```bash
sudo /opt/oboard/pi/restore.sh /path/to/backup
```

The current data is first moved aside to `/var/lib/oboard.before-restore-<time>`, so a restore can be undone.

## Keeping it running

- The server restarts by itself if it crashes. The health check also restarts it if it stops answering for 3 minutes,
  and brings the TV back if the browser dies.
- After a power cut everything comes back on its own. SQLite runs in WAL mode with full sync, so saved changes survive.
- To update, copy the new version over and run `sudo ./pi/install.sh` again.
- To uninstall, run `sudo /opt/oboard/pi/uninstall.sh`, which keeps your data. Add `--purge` to delete it too.

## TV sound (beta)

By default replies play on the phone. **Settings → Voice → Play replies on the TV** sends the on-device voice to the TV
through the Pi instead.

The kiosk browser plays sound on the Pi's default audio device. On Raspberry Pi OS that is normally the HDMI output.
This path has not been tested on real hardware yet. If the TV stays silent:

- Run `aplay -l` to see the HDMI card.
- Check the TV's input volume.
- If needed, set the default card in `/etc/asound.conf`.

Use push-to-talk rather than hands-free while the TV is speaking, so the phone's microphone doesn't hear the TV.

## Troubleshooting

| Problem | Try |
|---|---|
| TV is black or shows a console | `journalctl -u oboard-kiosk -n 80`, then `sudo systemctl restart oboard-kiosk` |
| "Can't reach the Pi" on the phone | Same Wi-Fi? `curl http://oboard.local:8080/healthz` from a computer; `journalctl -u oboard -n 100` |
| Phone doesn't find the Pi automatically | Type the address shown on the TV (e.g. `192.168.1.20:8080`) |
| Assistant says the key is missing or invalid | Fix `GEMINI_API_KEY` in `/etc/oboard/oboard.env`, then `sudo systemctl restart oboard` |
| "Too many pairing attempts" | Wait 5 minutes |
| Pi restarts randomly | Use the official 27 W power supply |
| Disk nearly full (warning in the journal) | Delete old files in `/var/lib/oboard/backups` |

Logs: `journalctl -u oboard -f` (server), `journalctl -u oboard-kiosk -f` (TV), `journalctl -u oboard-health`
(health check).
