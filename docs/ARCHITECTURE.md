# Architecture

O Board has three parts:
- a **server** on the Raspberry Pi, which owns all data and talks to Gemini;
- the **canvas** web UI, shared by the TV, the phone and any browser;
- the **Android app**, which adds capture, voice and native screens around that canvas.

## Server (`server/`)

The server runs on Node 24 with one npm dependency (`ws`). It uses the built-in `node:sqlite` with WAL and
`synchronous=FULL`, so a power cut cannot lose an acknowledged change.

| Module | Job |
|---|---|
| `db.js` | Schema and migrations |
| `store.js` | Boards, objects, op log, undo/redo, snapshots, full-text search, conversation |
| `hub.js` | WebSocket hub: per-board subscriptions, live sync, presence, the TV's display state |
| `auth.js` | Pairing codes and device tokens |
| `assets.js` | Uploaded photos and files |
| `capture.js` | Quick capture into the Thoughts inbox |
| `backup.js` | Automatic database backups and a streamed full export |
| `widgets.js` | Data proxy for widgets, and their status reports |
| `secrets.js` | API keys for widgets (kept outside the database) |
| `ai/agent.js` | The Gemini turn loop |
| `ai/tools.js` | The 31 canvas tools |
| `ai/live.js` | Gemini Live ephemeral tokens and tool calls |
| `ai/pending.js` | Confirmation of destructive changes |
| `ai/context.js` | Board summary for the prompt |
| `ai/caption.js` | Image captions for recall |
| `http.js` | REST API, static files and security headers |

### Data model

- **Boards.** One *Thoughts* inbox (quick captures land here) and any number of *Spaces* (projects). Each board has a
  revision number `rev` that goes up with every change.
- **Objects.** Each object is a JSON document validated by the shared schema (`web/shared/schema.js`, also used by
  the browser). Types:

  | Type | Content |
  |---|---|
  | `note` | text, colour, tag |
  | `text` | free text |
  | `shape` | rect / ellipse / diamond / pill, with text |
  | `frame` | a titled section |
  | `arrow` | between objects or points, optional label |
  | `draw` | pen strokes |
  | `image` | an uploaded photo |
  | `file` | an uploaded file |
  | `link` | a URL |

  Unknown properties are rejected.
- **Op log.** Every change is a *batch* of `put` / `patch` / `del` ops. Each batch has:
  - an actor (a device, or `ai`) and a label ("Add 3 notes");
  - before/after copies of each object.

  This one log provides:
  - undo/redo, including "undo the assistant's last change", which only touches the AI's batch;
  - **delta resync**: a client that reconnects says "I have rev 120" and gets just what changed since;
  - **versions**: a snapshot is taken automatically before AI changes, which is what "go back to the earlier version"
    restores.
- **Search.** SQLite FTS5 indexes object text and the conversation. The assistant uses it for `search_board` and
  `recall` ("what did I say about the gripper last week?").
- **Assets.** Assets are stored by SHA-256 (content-addressed and never modified), so a database backup plus the
  `assets/` folder is a complete backup.

### Sync protocol (WebSocket `/ws?token=…`)

1. The server sends `welcome` with the board list and the TV's display state.
2. The client sends `sub` with the board id and its last known rev. The server replies with either a `delta` (just the
   changes) or the full `board`.
3. Client edits go out as `ops` with a client id (`cid`). The server answers `ack` or `nack`, and broadcasts `ops`
   to everyone else subscribed to that board.

Other messages:
- `live`: drag previews; relayed to others, never stored.
- `display`: the TV's board, camera, focus and presentation mode.
- `presence`: who is connected.
- `ai`: turn progress events (`start`, `tool`, `text`, `done`, `error`).
- `msg`: new conversation messages.
- `pending`: a destructive change waiting for confirmation.
- `caption`: subtitles for the TV.
- `tts`: phone-to-TV audio (beta).

Offline edits on the canvas are kept in an **outbox** (browser storage) and replayed in order on reconnect. Quick
captures on the phone have their own persistent queue (`CaptureQueue.kt`) with idempotency keys, so a retry never
creates duplicates.

### The assistant (Gemini)

`POST /api/ai/message` saves the user's message and starts a turn in the background.

**Inputs to each turn:**
- the system prompt (`ai/prompt.js`);
- the last 24 messages of that board's conversation;
- a compact board summary (`ai/context.js`): up to 260 objects nearest what the user is looking at, plus the
  selection;
- any attached images, sent inline so Gemini actually sees them.

**The loop:** Gemini streams back text and tool calls, and the server runs the tools. One turn allows up to 8 rounds
and 30 tool calls, with a 120 s timeout. Gemini's thought signatures are passed back unchanged, so multi-step reasoning
survives tool calls.

**Tools** are real operations on the saved board, validated like any client edit:

| Purpose | Tools |
|---|---|
| Read | `read_board`, `read_objects`, `search_board`, `recall`, `list_boards`, `view_images` |
| Create | `add_notes`, `create_diagram` (laid out with arrows and labels), `connect_objects`, `create_section`, `group_into_section` |
| Change | `edit_object`, `move_objects`, `resize_object`, `organize_objects` |
| Remove and history | `delete_objects`, `undo_ai_change`, `redo_ai_change`, `list_versions`, `restore_version`, `forget_recent` ("don't save that") |
| TV and boards | `focus_tv`, `switch_board`, `create_board` |
| Widgets | `add_widget` (templates), `create_widget` (custom code), `update_widget`, `read_widget_logs`, `list_api_keys`, `request_api_key` |
| Confirmation | `resolve_pending` |

**Safety rules:**
- All of one turn's changes are one undoable batch, so the phone's **Undo** chip removes exactly what the assistant
  did.
- Deleting more than a couple of objects, or restoring a version, creates a *pending* change. The assistant must ask,
  and only a new message from the user can approve it.
- After each change, `hub.reveal` pans the TV to show the new content, unless it is already in view.

**Gemini Live** (optional): the phone asks the Pi for an ephemeral token (`POST /api/live/token`).
- The token is single use, must start a session within 1 minute, lasts at most 30 minutes, and is locked to the Live
  model.
- The Pi also builds the session's first message (system prompt, board context, the tool list). The phone sends it
  as-is and then streams audio with Gemini directly over WebSocket.
- Tool calls from Live go back through the Pi (`POST /api/live/tool`), so they use the same validated tools and undo
  history.

### Widgets

A widget is a board object (`type: "widget"`) whose `html` is a small app: markup, styles and inline scripts. It also
has a small saved `state`. It syncs, undoes and backs up like any other object.

**Where it runs.** Each screen showing the widget (TV, phone canvas, browser) loads it in its own iframe:
- The iframe uses `sandbox="allow-scripts"` without same-origin, so it cannot see the board page, its token or its
  storage.
- `web/widget.html` gives it a policy with `connect-src 'none'`: no network at all.
- `web/widgets.js` lays the frames over the canvas and scales them with the camera.
- Frames start only near the visible area, at most 12 at once. Off-screen frames pause their refresh loops and stop
  after a minute.

**The runtime** (`web/js/widget-runtime.js`) gives widget code the `ob` object:

| Call | What it does |
|---|---|
| `ob.fetch(url, opts)` | Data, through the Pi |
| `ob.every(seconds, fn)` | Refresh at least 10 s apart; paused off screen |
| `ob.state` / `ob.setState()` | Saved data, at most every 5 s |
| `ob.theme` | The board's colours, also as CSS variables |
| `ob.onResize()` | Called when the widget is resized |

Chart.js 4 is preloaded (`web/vendor/chart.umd.min.js`, checked against npm's integrity hash).

`ob.kit` and `css/widget.css` provide formatters, a styled line chart and layout classes. Templates and custom widgets
therefore share one look.

**Templates** (`web/shared/widget-templates.js`, shared by the Pi and the board):
- The six templates are stock, crypto, weather, clock, countdown and timer.
- Each is ordinary code plus a settings list. `buildWidget(name, params)` checks the settings and embeds them safely in
  the widget's script.
- A widget remembers its `template` and `params`, so "switch it to AMD" or the Settings button rebuilds it with new
  settings.
- The assistant uses `add_widget` for these and writes code with `create_widget` only when none fits.
- `tools/check-widgets.mjs` runs every template against live data in headless Chrome.

**Data proxy** (`POST /api/widgets/fetch`):
- The Pi makes the request and keeps short-lived answers in a cache, so the TV and phone share one upstream request.
- Refusals:
  - addresses inside the home network (private, loopback, link-local, CGNAT/Tailscale), checked on every DNS lookup and
    redirect;
  - answers over 2 MB;
  - binary answers;
  - more than 60 upstream requests a minute per widget.
- API keys appear in widget code only as `{{NAME}}` placeholders. The Pi fills them in only for the host each key is
  bound to, only over https, and never in a host name. On a redirect to another host, the key headers are dropped.

**Feedback loop.** Each screen reports `ready` (with the text the widget shows), errors, or a missing key to
`POST /api/widgets/:id/report`.
- `create_widget` and `update_widget` move the TV to the widget, then wait up to 9 s for the first report on that exact
  code version, matched by hash. The model learns in the same turn whether it worked, and fixes errors with
  `update_widget`.
- The board summary the model reads shows each widget's latest state.

**Keys** (`secrets.js`) live in `DATA_DIR/secrets.json` (mode `0600`), outside the database.
- They are never part of backups or exports, never returned by the API, and never in the conversation.
- `request_api_key` creates an empty entry. The app shows a card where the user pastes the key, which goes straight
  to `PUT /api/secrets/:name`. Widgets waiting for that key restart on their own.

## Canvas (`web/`)

The canvas is plain ES modules with no build step. The server serves it to the TV and browsers, and the APK bundles a
copy (loaded through `WebViewAssetLoader`) so the phone canvas opens instantly.

| Module | Job |
|---|---|
| `render.js` | Canvas 2D renderer |
| `camera.js` | Pan and zoom with inertia |
| `input.js` | Gestures: pan, pinch, marquee, snapping, tools |
| `editor.js` | In-place text editing |
| `model.js` | Board state |
| `session.js` | Sync, outbox, undo |
| `ui.js` | Toolbars, menus, AI strip |
| `tv.js` | TV mode: pairing screen, captions, follows the display state |
| `remote.js` | The phone's TV-remote view |

Shared code:
- `web/shared/schema.js` (validation) and `layout.js` (placement, grids, graph layout for diagrams) are the same files
  the server imports.
- Diagrams lay out identically whether the AI or a person makes them.

The canvas has three modes:
- `?mode=tv`: no chrome; follows the display state; shows captions and assistant progress.
- `edit`: full editor (phone, browser).
- `remote`: a live miniature of what the TV shows. Dragging pans the TV, and the area outside the TV's frame is
  dimmed.

## Android app (`android/`)

The app uses Kotlin, Jetpack Compose and Material 3 components, styled with its own midnight-blue theme.
- minSdk 29, targetSdk 36. The release build is arm64 only.
- `OBoardApp.kt` holds the long-lived services, and `AppViewModel.kt` holds the UI state.

**Data layer** (`data/`):

| File | Job |
|---|---|
| `Api.kt` | REST |
| `Events.kt` | The WebSocket, with reconnect and backoff |
| `CaptureQueue.kt` | Offline capture queue |
| `Discovery.kt` | Finding the Pi over mDNS (`_oboard._tcp`) |
| `Failover.kt` | Switching between the Pi's addresses |
| `Prefs.kt` | Settings in DataStore |
| `SecureBox.kt` | The device token, encrypted with an AndroidKeyStore AES-GCM key |

**Address failover.** After pairing, `GET /api/me` tells the phone every address the Pi answers on: LAN IPs, its
Tailscale `100.x` address, `<hostname>.local`, and anything in `PUBLIC_URLS`.
- When the current address stops answering, the phone probes all of them at once and switches to the most preferred
  one that proves to be the same Pi (same `serverId`).
- When the phone joins a new network, it retries the preferred (home) address.
- The device token is per Pi, not per address, so nothing is re-paired. The canvas WebView reloads against the new
  address, and its outbox keeps any unsent edits.

**UI** (`ui/`):
- Screens:
  - Capture: composer, conversation, voice controls.
  - Boards.
  - Canvas: WebView with a JS bridge `OBoardHost`.
  - Remote.
  - Settings.
  - Pairing.
- Layout by window width:
  - Under 760 dp (cover screen): bottom navigation and a single column.
  - Unfolded: a navigation rail, with Capture or Boards next to a live board pane.

**Voice** (`voice/`): see [VOICE.md](VOICE.md).

| Part | Job |
|---|---|
| `Mic` | 16 kHz capture with echo cancellation for hands-free |
| `SpeechDetector` | Silero VAD |
| `LocalAsr` | Qwen3-ASR |
| `LocalTts` | Kokoro or Supertonic |
| `PcmPlayer` | Gapless playback with instant stop |
| `SpeechText` | Splits replies into sentences, so speaking starts after the first one |
| `VoiceController` | Push-to-talk, hands-free, barge-in, TV audio |
| `LiveSession` | Gemini Live client |
| `ModelStore` | Resumable, SHA-256-verified model downloads |

## Raspberry Pi (`pi/`)

Two systemd services run on the Pi: `oboard` (the server, sandboxed, with a 900 MB memory cap) and `oboard-kiosk`
(cage + Chromium on tty1).

The kiosk opens `http://127.0.0.1:8080/?mode=tv`, using a display token that the server writes to
`/var/lib/oboard/display.token`. The token is passed through a private file, never on the command line.

Timers:
- a health check every minute;
- a nightly kiosk refresh.

Avahi advertises `_oboard._tcp` so the phone can find the Pi. See [pi/README.md](../pi/README.md).
