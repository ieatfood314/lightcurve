# lightcurve

Screen time across every device, in one record. Successor to waytime (`ieatfood314/waytime`, left as it was).
The README says what it does and how it counts; keep it true when behaviour changes.

## Map

- `lightcurve/core.py`: the schema, intervals, days (04:00 to 04:00), naming and categories, every report (`day_report`, `range_report`, `ignition_report`) and `ingest`. The hub, the tracker and the command all go through it.
- `lightcurve/hub.py`: the HTTP server (stdlib `http.server`) and its API. Serves `web/` as it is on disk, so a change there is live on the next page load.
- `lightcurve/ignition.py`: the link to ignition, through ignition's ordinary API only. ignition's repo is never touched for this.
- `lightcurve/tracker.py`: the KDE tracker. `Recorder` holds the rules for turning focus, lock and idle into spans and has no D-Bus in it, so it is what the tests drive. `run()` is the daemon around it.
- `lightcurve/wayland_idle.py`: a dependency-free client for `ext-idle-notify-v1`.
- `lightcurve/cli.py`: the `lightcurve` command. `lightcurve/demo.py`: made-up data for `serve --demo`.
- `web/`: the dashboard. Plain HTML, CSS and JS, no build step. Fonts are in `web/fonts`.
- `android/`: the phone app, Kotlin with no libraries. `Spans.kt` and `Sites.kt` are the pure logic and have the unit tests; `SiteWatcher` is an accessibility service that notes the domain in a browser's address bar (its matching is ignition's `BlockerService`), and sync cuts browser spans by it; `MainActivity` is a WebView onto the hub plus one native page. `Today.kt` sends today's total to doppler (`ca.heeney.lightcurve.TODAY`, extras `lit` and `date`) after each good sync, and answers its `ca.heeney.lightcurve.REFRESH`; keep both names as doppler's `ScreenTime.kt` has them.
- `install.sh`, `update.sh`, `uninstall.sh`, `systemd/`: per-user install, no sudo anywhere.

## Rules that are easy to break

- Spans are keyed by `(device, start)` and re-sent as they grow. Anything a device sends must be safe to send twice.
- Things are known by their name (`n:<label lower>`), so an app and a site with the same name are one thing. Category choices are stored under that key.
- Analysis words are promises. "Usual" is a median of the user's own days and isn't claimed under five days of history; the burn comparison needs three days on each side; incomplete data is said out loud (`coverage_notes`). Don't add a number the data can't back.
- No window titles or addresses are stored. `site_from_caption` returns "" when a title doesn't name a site. Phones send a domain as the site; `site_name` turns it into the name a title would give (`SITE_NAMES`), at read time, so a better table fixes old records too.
- The category colours in `web/style.css` were checked with the dataviz skill's `validate_palette.js --pairs all` on both surfaces. Re-run it if you change one.
- Screenshots in `docs/` are demo data only. Never commit a real record.

## Test

```sh
python3 -m unittest discover -s tests -q
```

```sh
cd android && ./build.sh
```

`build.sh` runs the Kotlin unit tests, builds the signed APK and stops Gradle's daemon. It needs the toolchain in `~/.local/android-toolchain` and the key in `~/.config/lightcurve/` (`keystore.properties` and `release.jks`; losing the key means no more in-place updates).

To look at the dashboard without real data: `bin/lightcurve serve --demo --port 4697`.

## Ship

1. Run the tests, commit, push to `main` (public: `github.com/ieatfood314/lightcurve`).
2. The hub runs from this checkout as the user unit `lightcurve.service`. `web/` changes are live at once; after a Python change run `systemctl --user restart lightcurve`.
3. Computers run a clone in `~/.local/share/lightcurve/app`. Run `update.sh` there after a tracker change.
4. After a change under `android/`: `android/release.sh "what changed"`. It builds from the pushed commit and makes the GitHub release `v1.0.<commit count>`; the phone gets it through Obtainium. Hub-only changes need no release, since the phone shows the hub's own dashboard.
