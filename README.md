# clipboard-manager@ravetcofx — local fork

Working copy of the Cinnamon Clipboard Manager applet (a port of GNOME
Shell's Clipboard Indicator). The code is developed here and deployed to
`~/.local/share/cinnamon/applets/clipboard-manager@ravetcofx/`.

## Layout

- `applet/` — the xlet package, copied verbatim to the install location.
- `install.sh` — copies `applet/` over the installed applet and reloads it
  in the running Cinnamon session (via the Looking Glass DBus API).

## Local changes since the 1.0.0 import

### 1.1.0 — capture survives clipboard errors and tells the user

Before this, the capture path could die silently, one bad copy away:

- `_captureClipboard()` armed `_refreshInProgress` before reading the
  clipboard and only the read's callback cleared it. A read whose owner
  never answered the transfer (typically an app freezing mid-copy of an
  image) left the flag set forever, so the applet stopped recording
  everything until it was reloaded.
  - A watchdog (`CAPTURE_TIMEOUT_MS`, 5 s) now releases the flag when a
    read is clearly hung, shows a notification, and re-queues the capture
    so the stalled copy still gets recorded once the owner responds again.
    A capture serial keeps a fired watchdog from releasing a newer, healthy
    read in flight.
- Read failures are reported instead of swallowed. `_readClipboard()`
  now delivers errors as callback values — `(null, null, reason)` — and
  synchronous throws during the transfer setup are caught and reported.
  `(null, null, null)` still means "nothing recordable on the clipboard",
  which is not an error.
- Storing a copied image or writing the history file now catches failures
  (full disk, permissions) instead of throwing inside the capture chain.
- All of the above go through `_notifyError()`: a desktop notification plus
  a warning in the Cinnamon log, with a cooldown
  (`ERROR_NOTIFY_COOLDOWN_MS`, one minute) so a persistent problem does not
  toast repeatedly while the watchdog retries.

## Development notes

- Check syntax without a running session: `cjs applet/applet.js` — a parse
  error reports a line number; `ImportError: No JS module 'ui'` at line 9
  means the file parses fine.
- Settings and history live under
  `~/.config/cinnamon/spices/clipboard-manager@ravetcofx/` and
  `~/.cache/clipboard-manager@ravetcofx/`; they are not touched by
  `install.sh`.
- Cinnamon on this machine is 6.6, which loads xlet modules via
  `imports.searchPath`; the code keeps a 6.8+ importer fallback in place.
