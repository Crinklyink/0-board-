# O Board 0.4.1

A bug-fix release for 0.4.0. Nothing changes in the data or the API, so the Pi and the phone can be updated in either
order.

## Fixes

- **The app survives a crashed board view.** Android can stop the web page that draws the board. This happens when
  memory runs low (more likely with many live widgets open) or when the page crashes. Before, that crashed the whole
  app. Now the board view rebuilds itself on the same board and shows "The board view stopped and was reloaded".
  Edits not yet sent are kept in the page's offline outbox and sent once it reconnects.
- **New tasks appear on top.** A task added from the toolbar, or made from a note, was placed under everything else
  on the board. Template sections could hide it. New tasks now go on top, like every other new object.
- **The toolbar fits touch screens.** Touch screens use larger buttons. Between 681 and about 800 px wide, Undo and
  Redo ran off the end of the toolbar. The toolbar now measures itself: when the full set does not fit, the less-used
  tools move into **More**, as on a phone.
- **Widgets report "running" only once they have loaded.** A widget whose second request depends on the first, like
  the weather widget (place lookup, then forecast), was reported as running while it still showed "Loading…". The
  assistant was then told it worked before it had. Widgets now report once every pending step has finished.

## Install or update

- Install `OBoard-0.4.1-arm64.apk` over the existing app. It uses the same signing certificate.
- Extract `oboard-pi-0.4.1.tar.gz` on the Pi and run `sudo ./pi/install.sh` as before. Existing boards and settings
  remain. There is no database change.

## Verification

See [TEST-REPORT.md](TEST-REPORT.md). Each fix has a check that fails on 0.4.0 and passes on 0.4.1:
`tools/check-productivity.mjs` covers task stacking and the toolbar, and `tools/check-widget-ready.mjs` covers widget
status. The crash recovery was tested on the emulator by crashing and by killing the board view's renderer.
