# Test report

Version 0.4.1, 20 October 2026. A test is marked as passing only if it actually ran.

## v0.4.1 verification

0.4.1 fixes four bugs found by reviewing 0.4.0. Each new check below was also run against the 0.4.0 code, and failed
there for the bug it covers.

- **PASSED — task stacking:** `node tools/check-productivity.mjs` now checks that a new task, and a task made from a
  note stacked above everything else, are drawn on top in the browser and in the saved data. On 0.4.0 the new task had
  z = 0, under the template's sections.
- **PASSED — toolbar on touch screens:** the same check emulates a touch screen at 681, 700, 720, 768, 800, 900 and
  1280 px. At each width it requires the toolbar to stay on screen without scrolling, Undo and Redo to stay on it, and
  any hidden tools to be under **More**. It also checks that a 760 px mouse screen still shows the full toolbar.
  On 0.4.0 it failed at 681 px with Undo and Redo cut off.
- **PASSED — widget status:** the new `node tools/check-widget-ready.mjs` runs four widgets in headless Chrome against
  a local fake API. It requires:
  - a widget whose second, slow request depends on the first to report "Price 123.45", not its loading text;
  - three slow requests in a row to report once, with the final text;
  - a widget with no requests to still report as running;
  - a failing follow-up request to report an error and never "running".

  On 0.4.0 the first widget was reported running while it showed "Loading price…".
  `node tools/check-widgets.mjs` now also fails a widget reported running while it says "Loading". All six templates
  passed with live data; the weather widget reported its full five-day forecast.
- **PASSED — board view crash recovery (emulator, 2184×1968):** opened a board with six live widgets on the full
  canvas, then used the debug build's commands:
  - `crash-canvas` crashed the board view's renderer;
  - `kill-canvas` stopped it the way Android does when memory is low.

  Both times the app process kept running (same PID) and a new renderer started. The app logged
  `Board renderer gone (crashed=true/false); rebuilding the board view` with no fatal exception. The same board came
  back with the weather widget running, and its More menu opened normally.
- **PASSED — server:** 73 tests. **PASSED — browser:** all `check-productivity` checks, no uncaught JavaScript errors.
- **PASSED — Pi distribution:** `oboard-pi-0.4.1.tar.gz` boots and passes `tools/check-package.mjs`, which now also
  runs under Git Bash's GNU tar.
- **PASSED — Android lint:** `lintRelease`: zero errors, 13 warnings (17 in 0.4.0). The board view now handles
  `onRenderProcessGone`. androidx.webkit's lint rule still flags every `WebViewClient()` constructor call, including
  Kotlin's `object : WebViewClient()`, so that one rule is suppressed on `BoardWebView`, with a comment saying why.
- **PASSED — Android builds and APK:** debug (arm64 + x86_64) and signed, minified arm64 release. The signature
  verifies and the signer matches v0.4.0. `zipalign -c -P 16 4` succeeds. `aapt2` confirms package `app.oboard`,
  version 0.4.1 (5), minSdk 29, targetSdk 36 and arm64-v8a only. APK SHA-256:
  `e791d9bf23a0bbf8680b7f88eb7cad347d083cac8be934dd68e8fc47a1d526d6`. The crash test above used the debug build; its
  crash commands do not exist in release builds.
- **Found, not fixed in 0.4.1:** on the unfolded canvas, the phone's floating mic button covers the bottom of the
  web toolbar's **More** menu. HTML dialogs already hide it; the More menu does not yet.

## v0.4 verification

- **PASSED — server:** `cd server && npm test`: 73 tests. The 15 new tests cover task validation, real calendar dates, templates and rollback, task sync/search/undo and restart, memory persistence/export/import and concurrent-edit rejection, memory merge recovery, rapid backup requests, stale in-flight connection tests, migration from the v0.3 schema, protected AI edits, credential isolation and redacted diagnostic failures. One test confirms the real agent request includes project memory after the original conversation has fallen out of its 24-message history window.
- **PASSED — browser:** `node tools/check-productivity.mjs`, in isolated headless Chrome. Created a project template through the picker; added a task with detail/priority/date; clicked its actual canvas checkbox; checked saved status and undo/redo. Repeated Complete/Reopen through the selection menu. Task list progress, search, status/overdue filters, completion and live edits passed. Saved/reopened memory, merged independent edits and resolved a conflicting field with an explicit choice; unsaved text was preserved and the choice buttons remained visible above the footer. Saved a stand-in key and tested model access through the setup UI. At 375 px the menu, task list and task/memory sheets fit. No uncaught JavaScript errors. Screenshots are in `dist/qa-v0.4/`.
- **PASSED — Android builds:** debug (arm64 + x86_64) and signed, minified arm64 release, version 0.4.0 (4).
- **PASSED — Android lint:** `lintRelease`: zero errors, 17 existing warnings. The check found API 31 audio-routing calls that were unguarded on Android 10/11; these now use an SDK guard and a legacy routing fallback. A malformed local SDK property was corrected. Release lint now aborts on errors.
- **PASSED — APK:** signature verifies, signer matches v0.3.0, `zipalign -c -P 16 4` succeeds; `aapt2` confirms package `app.oboard`, version 0.4.0 (4), minSdk 29, targetSdk 36 and arm64-v8a only. APK SHA-256: `c0ad8efcf2b3e24ebf0f087322e1adff8cd8f5760f07ec44603591a781dcdecb`.
- **PASSED — Android emulator setup:** installed the debug APK; paired to an isolated QA server by link and landed in the new diagnostics screen. The phone showed microphone permission and installed ASR/TTS/VAD status. Entered a stand-in key through the masked native input and ran the model-access check successfully. This used the local Gemini stand-in, not Google.
- **PASSED — Android productivity screens:** at 1080×2520, created a project through the native template picker, saved project memory through the WebView and added a task through the native canvas menu; verified all three in the QA server's persisted state. HTML dialogs now hide the overlaid canvas mic and keep Save buttons visible. Also checked the 2184×1968 unfolded canvas/conversation layout. Screenshots are in `dist/qa-v0.4/android-*.png`.
- **PASSED — Pi distribution:** `node scripts/package.mjs` and `node tools/check-package.mjs`. The extracted archive booted a fresh server, paired a test phone, created a template with task cards, saved memory and returned diagnostics. Installer permissions are executable and line endings are Unix. The archive contains no credential files, databases or signing keys.
- **PASSED — installer syntax:** `bash -n pi/install.sh` under WSL.
- **NOT RUN — real Gemini, physical Fold 7, physical Pi/TV:** no key or devices were available for these tests. Model-list diagnostics check key acceptance and listed model capabilities; they do not prove generation quality or a successful Live audio session.

The A–I details below record earlier release checks. Their device/voice timing measurements and v0.3 APK checksum are historical; they were not remeasured for v0.4.

**Test environment:**
- Windows 11 PC: AMD, 16 logical cores, no NVIDIA GPU.
- Android emulator: Android 17 / API 37, x86_64, 16 KB memory pages.
  - Fold 7 layouts were checked at its real resolutions: 2184×1968 unfolded and 1080×2520 cover.
- Debian 13 container with systemd, inside WSL, used for the Pi installer.

**Not available:**
- A Galaxy Z Fold 7.
- A Raspberry Pi.
- A TV.
- A Gemini API key.

Where Gemini was needed, a local stand-in (`tools/mock-gemini.mjs`) answered instead. It speaks the same REST
(streaming, function calls) and Live WebSocket protocols. It proves that O Board's side of each conversation works;
it does **not** prove that real Gemini makes good choices.

## Summary

| Test | Result |
|---|---|
| A. Input: speech becomes editable text | **Pass** on the emulator (synthesised speech through the real recogniser). Real microphone not tested |
| B. Voice: spoken replies, interruption, repeats | **Pass** on the emulator. Not judged by ear on a phone speaker |
| C. AI: instruction to Gemini, get a response | **Plumbing passes** against the stand-in. **Not run against real Gemini** (no key) |
| D. Canvas actions: AI creates a real, saved note | **Pass** with the stand-in choosing the tool. Real Gemini's choices untested |
| E. Synchronisation: phone edit reaches the TV | **Pass** (automated, plus emulator ↔ browser by hand) |
| F. Persistence: survive a server restart | **Pass** (automated) |
| G. Vision: the answer uses the photo's content | **Plumbing passes** (the photo reaches Gemini byte for byte). **Real answer not tested** (no key) |
| H. Recovery: reconnect, interrupt, restart | **Pass** for each part tested (details below) |
| I. APK: signed, installable, compatible | **Pass** for build, signature, alignment and the emulator. **Not installed on a physical Fold 7** |

Automated suite: `cd server && npm test` runs **73 tests, 73 pass**. They cover the store, the server, widgets and API keys, the AI tools
(against the stand-in), and layout and schema.

## Details

### A. Input

The debug build's `dictate` command uses the same path as holding the mic with **Send when I let go** turned off:
1. The phone speaks "Add a note about the gripper pads." with Kokoro.
2. It feeds that audio, padded with silence, through Silero VAD and Qwen3-ASR.
3. It puts the result in the text box.

**Result:** the text box contained `Add a note about the gripper pads.`, word for word. Typing on the keyboard then
changed it to `Add a note about the gripper pads in blue please.`, so the text is editable before sending.

**Recognition accuracy (PC, same runtime):**
- WER 0% on the five Kokoro-spoken test sentences.
- Real recordings: noisy radio and fast rap were good; French, German and Spanish clips were good; a four-language
  code-switching clip was weaker.
- See [VOICE.md](VOICE.md).

**Not tested:** a real microphone in a real room. The emulator has no microphone input in this setup.

### B. Voice

On the emulator (x86_64, using the PC's CPU), via **Settings → Voice → Run voice self-test** and the debug commands:

| | Result |
|---|---|
| Kokoro | 4.31 s of speech made in 2.67 s (RTF 0.62) |
| Supertonic | RTF 0.15, first audio after 811 ms |
| Conversation (recognise → AI → speak): reply text to first sound | 648 ms debug build, 766 ms release |
| Conversation: mic release to first sound | 3.98 s debug, 4.31 s release. Includes model warm-up, recognition and the stand-in reply on emulated hardware |
| Interruption: from "stop" to silence | **3 ms** |

After an interruption, the server cancelled the turn and no queued speech resumed. Repeated conversations worked
(run several times, in both builds).

**Not tested:** how the voices sound through a phone speaker, and real speed on the Fold 7's processor. The emulator
runs on a desktop CPU.

### C. AI (Gemini)

**Automated** (`ai.test.js`, against the stand-in):
- A spoken request becomes saved notes, and progress events stream to the TV.
- Gemini 3 thought signatures are returned untouched.
- Bad tool arguments come back to the model as a readable error.
- Rate-limit and bad-key failures are reported plainly.
- With no key set, messages still save and the user gets a clear message.

**Not run:** any request to the real Gemini API. **To run it:** put your key in `/etc/oboard/oboard.env` on the Pi, or
in `server/.env` on a PC without the `GEMINI_BASE_URL` line. Then ask something on the phone.

### D. Canvas actions

**Automated:**
- The stand-in calls `add_notes`, and real objects appear in SQLite and on a connected TV client.
- Every other tool is exercised against real state: diagram, connect, move, resize, group, organise, search, recall,
  forget, focus TV, undo/redo, versions, delete with confirmation.

**On the emulator:** "Put a note on the board about mounting a camera above the robot arm" was spoken, recognised
and sent.
- The Pi stored it as a voice message.
- About 0.4 s later, the stand-in's `add_notes` call saved new notes, which appeared on the phone's board and the TV
  view.
- The stand-in always adds the same three notes, whatever the request. It does not understand language.

**Live mode with the stand-in:** a tool call created the note "Live mode works end to end" through the Pi.

**Not tested:** whether real Gemini picks sensible tools and layouts.

### E. Synchronisation

**Automated** (`Test E — sync`): an edit from the phone reaches the TV client, and the reverse.

**By hand:** edits on the emulator canvas appeared in the browser TV view, and the reverse. Touch tests on the phone
canvas (sent through Chrome DevTools to the WebView):
- one-finger pan with inertia;
- pinch zoom ×3;
- tap to select;
- drag to move a note, after which **Undo** put it back.

### F. Persistence

**Automated** (`Test F — persistence`): the server was restarted, and boards, objects, an uploaded image,
conversation history and settings were all intact. Related tests passed for reopening the database file, graceful
shutdown (WAL checkpointed, `quick_check ok`) and backup round-trips.

**On the Pi installer test:** the server was killed with `kill -9`, and systemd restarted it within seconds
(`/healthz` 200).

### G. Vision

**Automated** (`Test G (plumbing)`): a photo attached on the phone reaches Gemini byte for byte as inline image data.
`view_images` lets the model ask to see an image already on the board. Uploaded photos get a searchable caption.

**Not tested:** that real Gemini's answer describes the photo correctly. This needs a key.

### H. Recovery

| Part | Evidence |
|---|---|
| Client disconnects and reconnects | Automated: it receives only what it missed (delta), and no data is lost |
| Phone changes network | Emulator, using a relay as the "home" address, which was then switched off. The phone moved to the Pi's other address about 5 s later without re-pairing; when "home" came back, it returned. The canvas reconnected both times |
| Removed device | Automated: its open connection is cut at once, and its token stops working |
| Interrupting a voice response | Emulator: silent within 3 ms; the server cancelled the turn; the next turn works (also automated) |
| Server restart | Automated (F), plus the Pi `kill -9` test |
| Offline capture | Captures are queued on the phone with idempotency keys. Automated: retried captures are not duplicated |

### I. APK

`dist/OBoard-0.3.0-arm64.apk`: 36.3 MB, SHA-256
`803d3c8d4249a8a3856a748ceed2afd5ee1c776ffe5032f9c84b91e734c6d301`.

| Check | Result |
|---|---|
| Package | `app.oboard` 0.3.0 (3), minSdk 29, targetSdk 36, compileSdk 37 |
| Signature (`apksigner verify`) | Verifies; APK Signature Scheme v2; 1 signer `CN=O Board, O=Personal` |
| 16 KB page support | `zipalign -c -P 16` OK, and every native library's LOAD segments are 16 KB aligned (needed on Android 15+ devices) |
| Native code | `arm64-v8a` only (the Fold 7's ABI) |
| Shrinking | R8 minify and resource shrinking on. The release build ran correctly on the emulator (cold start 1.09 s, warm 0.76 s) |
| Permissions | Internet, network state, Wi-Fi state, multicast (Pi discovery), microphone, audio settings, vibrate |

**Installed on a physical Galaxy Z Fold 7: no.**
- The emulator runs x86_64, so emulator testing used the same code built with an extra x86_64 library set.
- An arm64-only build on the x86 emulator runs through Android's arm translation layer, which crashed inside the
  speech runtime. That is a limitation of the translation layer; real arm64 hardware runs the code natively.
- This should be confirmed on the phone: install the APK, then run **Settings → Voice → Run voice self-test**.

### Live widgets and API keys (added after the first release)

Widgets were checked in **real Chrome** (headless, the TV kiosk's engine) and in the **Android WebView** of the phone
app. Data came from real services.

**Asking for a widget:** with the TV view open, "Can you track NVDA stock on the board?" worked end to end:
1. The assistant (the stand-in, which always writes the same pre-made NVDA widget) created the widget.
2. The TV moved to it and ran it.
3. The widget reported back "NVDA … $217.09 +2.96 (+1.38%) … [1 chart]".
4. The spoken reply quoted the live price: "NVDA is on the board at $217.09."

That took 2.1 s in total. The widget showed the day's chart from Yahoo Finance.

**Fixing its own mistakes (automated):**
1. The first code threw `ReferenceError`; the screen reported it, and the tool returned the error to the model.
2. The model called `update_widget` with corrected code, and the tool returned "running" with the visible text.
3. Code using `fetch()` directly is refused before it runs, with a hint to use `ob.fetch`.

**Runtime behaviour (real Chrome):**
- A widget needing a missing key showed "Waiting for an API key" and reported it. Once the key was saved, it
  restarted by itself and called the provider.
- A broken widget showed an error panel and reported `ReferenceError: nope is not defined`.
- A widget using top-level `await` ran and showed real weather: "NYC 12.9 °C" from Open-Meteo.
- A counter widget saved its data on the board (`{"n":41}`).

**On the phone (emulator):**
- The same widgets ran inside the app's board view.
- Double-tapping the counter entered "Use" mode. Two taps on its button made it 43, and that was saved to the board.

**API keys:**
- With Twelve Data's public `demo` key saved for `api.twelvedata.com`, a request using `{{TWELVE_DATA_KEY}}` returned
  a real Apple quote ($342.94).
- The same key was refused when sent to:
  - another website;
  - another website in a header;
  - plain http;
  - a lookalike domain (`api.twelvedata.com.evil.example`);
  - a host name.
- Automated tests also show:
  - the TV cannot add keys;
  - key values are never returned by the API;
  - keys are not in the full backup;
  - a redirect to another host drops key headers;
  - repeated requests are answered from the cache.
- On the phone, the assistant's `request_api_key` made the key card appear above the message box. It says where the
  key is kept and which website it is sent to.

**Home network protection:** requests to `192.168.1.1`, `127.0.0.1`, `localhost` and `169.254.169.254` were refused
(live and automated). The local service was never contacted.

**Bug found and fixed while testing:** the phone app read some server responses on the main thread. Small responses
happened to work, but the larger board list (with the new thumbnails) failed. All responses are now read on a
background thread.

**Not tested:**
- Real Gemini writing widget code. The stand-in always returns the same pre-made NVDA widget, so the quality of the
  widgets Gemini writes is unverified.
- Widgets on the Pi's kiosk hardware.

### Ready-made widgets (0.3.0)

`node tools/check-widgets.mjs` puts every template on a board and runs them in headless Chrome with live data. All
six ran:

| Template | It showed |
|---|---|
| Stock | "NVDA NVIDIA Corporation $217.09 +2.96 (+1.38%) Market closed" with the day's chart |
| Crypto | "BTC Bitcoin $81,603.00 −0.94% 24h" with the 24-hour chart |
| Weather | New York, 53°, clear, feels like 49°, plus a 5-day forecast |
| Clock | New York time, with London and Tokyo |
| Countdown | "73 days 04 hours 12 min" to New Year |
| Timer | 25:00 with Start and Reset |

**The picker, in real Chrome:**
- It lists all six templates.
- It rejects a bad symbol with a clear message.
- It added an AMD 1-month chart, which ran with live data.
- "Settings" reopened prefilled. Switching to TSLA rebuilt the widget, which ran, and its title updated.
- At phone width (375 px), More shows "Add a widget" and the picker fits in one column.

**The assistant, with the stand-in:**
- "Track AMD stock for me" gave a template widget, and the reply quoted its live price.
- "Show the weather in Tokyo" gave the weather template.
- Automated: a template widget can be re-configured with new settings, and bad settings come back as readable errors.

**Security fix found by a test:** a template setting containing `</script>` could have broken out of the widget's
script. Settings are now escaped. A test feeds in a hostile label and checks that it stays inside, and still reads back
exactly.

### Pi installer (extra)

`pi/install.sh --no-kiosk` ran on Debian 13 (trixie) with systemd, in a disposable container.

**What worked:**
- It installed Node.js v24.21.0 after checking its SHA-256.
- The `oboard` service ran with `User=oboard`, `ProtectSystem=strict`, `NoNewPrivileges` and `MemoryMax`.
- `/etc/oboard/oboard.env` was `root:oboard 640` and unreadable by other users.
- `/healthz` returned 200; `/api/boards` without a token returned 401.
- The health check and `backup.sh` worked.
- Re-running the installer kept settings and data, and `uninstall.sh` kept data.

**Not tested:**
- Raspberry Pi hardware or the arm64 Node download. Its checksum is pinned from the official `SHASUMS256.txt`.
- The TV kiosk (cage + Chromium), which needs a display.
- HDMI audio.

## Still unverified, in priority order

1. Real Gemini (C, G, D's quality, and how well it writes widgets). It needs your API key.
2. Installing and using the APK on the Fold 7, including on-device voice speed and quality, and the microphone.
3. The Pi on real hardware: the TV kiosk, HDMI audio, and Avahi discovery from the phone.
4. Gemini Live against Google's real endpoint, including ephemeral-token minting.
5. Tailscale switching on a real phone network change.
