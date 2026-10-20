# O Board 0.4.0

## Setup & diagnostics

After pairing, the phone opens the setup checks. You can also open **Settings → Setup & diagnostics** or the browser's setup button. Add the Gemini API key there, then run **Test Gemini connection**. It checks key acceptance and whether the selected text/Live models are listed; use Assistant settings to choose another model if needed. It does not generate a response or test Live audio.

The screen checks the server, database, storage, TV connection and recent backups. The Android screen also checks microphone permission and local speech-model installation and links to the existing voice self-test.

The key is stored only on the Pi in `DATA_DIR/server-credentials.json` (Linux mode 0600). It takes precedence over any installer/environment key, works immediately and survives restart. No API returns it, widget code cannot use it, and it is excluded from backups and exports. Enter keys again when restoring onto a new Pi.

## Task cards

Use **Add task** in the canvas toolbar or **More → Add task**. Tasks have a title, details, status, priority and optional due date. Tap the checkbox to complete/reopen; double-tap the card or choose **Edit task** to edit all fields. The selection menu can create a task from a note while keeping the original note. Tasks support live sync, offline editing, undo/redo, search, snapshots and backups.

Open **Task list** for board progress, search and filters for To do, In progress, Done and Overdue. Complete or reopen tasks directly in the list; it updates as other devices edit the board. Click a task title to find it on the canvas.

Ask the assistant to add tasks or mark them complete. AI changes use the same validation and undo as other canvas changes. Replacing substantial user-written task details requires confirmation. Due dates are visual reminders; scheduled notifications are not part of this release.

## Board templates

Choose **New space** in the Android Boards → Spaces tab, or **New board from template** in the browser board menu. Start blank, or choose project planner, brainstorm, decision comparison, weekly plan or research. Templates are editable sections, notes and tasks; no AI key is needed to use them.

## Project memory

Open **Project memory** from the canvas toolbar or **More**. Save the goal, decisions, open questions and next steps. Every assistant turn for that board includes this brief, even when older chat messages fall out of recent history. You control its contents; nothing is inferred or saved to memory in the background.

You can ask the assistant to remember something. It appends without discarding existing text; replacement of non-empty memory needs confirmation. If another device edits memory while you have the form open, your draft remains visible. Choose **Review latest changes** to combine independent edits; for conflicting fields, choose **Keep my draft** or **Use latest**, then save.

Memory lives in the board database and travels with full backups and board exports/imports. It is independent of canvas undo, snapshots and chat deletion. To remove it, clear the relevant memory fields or ask explicitly to forget the saved memory.

## Fixes and polish

- Task menus correctly switch between Complete and Reopen after each change.
- Rapid backup requests receive unique filenames instead of colliding within the same second.
- Changing a Gemini key or model discards old connection-test results, including tests still in flight.
- Canvas dialogs hide the Android microphone overlay; Android Back closes the dialog and Save buttons stay visible while scrolling.
- Section headings remain readable when zoomed out, and forms and task lists fit narrow phone screens.
- Audio routing uses compatible fallbacks on Android 10 and 11; release lint now blocks errors.

## Install or update

- Install `dist/OBoard-0.4.0-arm64.apk` over the existing app. It uses the same signing certificate.
- Extract `dist/oboard-pi-0.4.0.tar.gz` on the Pi and run `sudo ./pi/install.sh` as before. Existing boards/settings remain; the database migration adds memory fields automatically. Back up before upgrading. Update the Pi and phone together because older clients do not render task cards.

See [TEST-REPORT.md](TEST-REPORT.md) for current verification and hardware limitations.
